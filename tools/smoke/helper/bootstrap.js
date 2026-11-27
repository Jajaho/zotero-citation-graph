/* global Zotero, Services, Cc, Ci, ChromeUtils, Components */
'use strict';

/**
 * The smoke test's eyes inside Zotero. Development only: tools/smoke/run.js
 * installs it as a proxy file into a throwaway profile, next to the XPI under
 * test. It is never part of the plugin and never installed in a real profile.
 *
 * Three jobs:
 *
 * 1. Let Marionette in. Marionette starts listening, and opens a session, only
 *    once the application says its startup is done -- the way FIREFOX says it:
 *    "browser-idle-startup-tasks-finished", sent by Firefox's BrowserGlue.
 *    Zotero ships the remote agent but not that part of Firefox, so the topic
 *    never comes. This sends it on Zotero's behalf once the main window has
 *    loaded, which is what Marionette checks next (by readyState). In Zotero
 *    only Marionette and the remote agent observe the topic.
 *
 * 2. Keep every console message. Zotero's error console is where #26 and #27
 *    left their only trace, so that is what the smoke test reads. Messages
 *    logged before this add-on started -- the plugin may well start first --
 *    are taken from the console service's own backlog, and console.* calls,
 *    which never reach the console service, from the console API's storage.
 *
 * 3. Note every HTTP request to a host that is not this machine, with enough
 *    about its origin (principals, the JS stack) for run.js to tell whether
 *    the plugin made it. The plugin promises to stay offline unless asked; a
 *    request of its own in a smoke run is a broken promise.
 *
 * run.js reads what was gathered from Zotero.CitationGraphSmoke over
 * Marionette.
 *
 * startup() returns at once. Zotero starts add-ons one after another and waits
 * for each startup(), so one that waited for the main window would hold back
 * the plugin under test until after it -- and the point of sideloading the XPI
 * is that the plugin starts before the main window, as it does for users.
 */

const TOPIC = 'browser-idle-startup-tasks-finished';
// Enough for a smoke run many times over; past it, a count, not a crash.
const MAX = 5000;

let state = null;
let consoleListener = null;
let observers = [];

function push(list, entry) {
	if (list.length < MAX) list.push(entry);
	else state.dropped++;
}

const LEVELS = ['debug', 'info', 'warning', 'error'];

/** An nsIConsoleMessage as plain JSON: { kind, level, flags, sourceName, message, category, line, at }. */
function fromConsoleService(msg) {
	try {
		let e = msg.QueryInterface(Ci.nsIScriptError);
		let level = 'error';
		if (e.flags & Ci.nsIScriptError.warningFlag) level = 'warning';
		else if (e.flags & Ci.nsIScriptError.infoFlag) level = 'info';
		return {
			kind: 'script',
			level,
			flags: e.flags,
			sourceName: e.sourceName || '',
			message: e.errorMessage || e.message || '',
			category: e.category || '',
			line: e.lineNumber || 0,
			at: e.timeStamp,
		};
	}
	catch (notScriptError) {
		let level = 'info';
		try {
			if (typeof msg.logLevel === 'number' && LEVELS[msg.logLevel]) level = LEVELS[msg.logLevel];
		}
		catch (e) { /* no logLevel on this Gecko */ }
		return {
			kind: 'message',
			level,
			flags: null,
			sourceName: '',
			message: String(msg.message || ''),
			category: '',
			line: 0,
			at: msg.timeStamp,
		};
	}
}

function argText(a) {
	if (a == null) return String(a);
	if (typeof a !== 'object') return String(a);
	if ('message' in a && 'stack' in a) return a.name + ': ' + a.message;
	try { return JSON.stringify(a); }
	catch (e) { return String(a); }
}

/** A console API event (console.error() and friends) as plain JSON. */
function fromConsoleAPI(ev) {
	let level = ev.level === 'warn' ? 'warning' : ev.level === 'error' ? 'error' : ev.level === 'info' ? 'info' : 'debug';
	return {
		kind: 'console-api',
		level,
		flags: null,
		sourceName: ev.filename || '',
		message: (ev.arguments || []).map(argText).join(' '),
		category: 'console-api:' + ev.level,
		line: ev.lineNumber || 0,
		at: ev.timeStamp,
	};
}

function isLoopback(host) {
	host = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
}

function observe(topic, fn) {
	let o = { observe: fn };
	Services.obs.addObserver(o, topic);
	observers.push([o, topic]);
}

function startListening() {
	// The backlog first, then the listener: the console service calls
	// listeners only for what is logged after they register.
	try {
		for (let m of Services.console.getMessageArray() || []) push(state.console, fromConsoleService(m));
	}
	catch (e) { state.helperErrors.push('console backlog: ' + e); }
	consoleListener = {
		QueryInterface: ChromeUtils.generateQI(['nsIConsoleListener']),
		observe(m) {
			try { push(state.console, fromConsoleService(m)); }
			catch (e) { /* never throw back into the console service */ }
		},
	};
	Services.console.registerListener(consoleListener);

	try {
		let storage = Cc['@mozilla.org/consoleAPI-storage;1'].getService(Ci.nsIConsoleAPIStorage);
		for (let ev of storage.getEvents() || []) push(state.console, fromConsoleAPI(ev));
	}
	catch (e) { state.helperErrors.push('console API backlog: ' + e); }
	observe('console-api-log-event', (subject) => {
		try { push(state.console, fromConsoleAPI(subject.wrappedJSObject)); }
		catch (e) { /* as above */ }
	});

	// Opening, not modify: http-on-opening-request is sent from inside
	// AsyncOpen, while whoever asked -- fetch(), XHR's send() -- is still on
	// the stack, which is what lets run.js tell the plugin's requests from
	// Zotero's. Modify is the backstop for a channel opening did not report.
	observe('http-on-opening-request', subject => recordRequest(subject, 'opening'));
	observe('http-on-modify-request', subject => recordRequest(subject, 'modify'));
}

const seenChannels = new Set();

function principalSpec(p) {
	if (!p) return '';
	try {
		if (p.isSystemPrincipal) return 'system';
		return p.spec || (p.URI && p.URI.spec) || p.origin || '';
	}
	catch (e) { return ''; }
}

/** The files on the JS stack right now, innermost first, async callers included. */
function stackFiles() {
	let out = [];
	let f = Components.stack;
	for (let n = 0; f && n < 64; n++) {
		if (f.filename && !out.includes(f.filename)) out.push(f.filename);
		f = f.caller || f.asyncCaller;
	}
	return out.slice(0, 24);
}

/**
 * One request to a host other than this machine, with what is known of who
 * made it: the principals on its loadInfo (a request from the graph page
 * carries the page's resource:// principal) and the files on the stack when
 * it was opened (a request from the plugin's chrome code carries the system
 * principal, like Zotero's own, but has the plugin's files on the stack).
 */
function recordRequest(subject, when) {
	try {
		let ch = subject.QueryInterface(Ci.nsIHttpChannel);
		let uri = ch.URI;
		if (isLoopback(uri.host)) return;
		let id = ch.channelId;
		if (seenChannels.has(id)) return;
		seenChannels.add(id);
		let li = ch.loadInfo;
		push(state.network, {
			method: ch.requestMethod,
			url: uri.spec,
			at: Date.now(),
			seenAt: when,
			triggeringPrincipal: principalSpec(li && li.triggeringPrincipal),
			loadingPrincipal: principalSpec(li && li.loadingPrincipal),
			stack: when === 'opening' ? stackFiles() : [],
		});
	}
	catch (e) { /* not an HTTP channel after all */ }
}

function announce(win) {
	if (state.announced) return;
	let fire = () => {
		if (state.announced) return;
		state.announced = true;
		Services.obs.notifyObservers(null, TOPIC);
	};
	if (!win || win.document.readyState === 'complete') fire();
	else win.addEventListener('load', fire, { once: true });
}

function install() {}
function uninstall() {}

function startup() {
	state = {
		started: Date.now(),
		announced: false,
		dropped: 0,
		helperErrors: [],
		console: [],
		network: [],
	};
	Zotero.CitationGraphSmoke = state;
	startListening();
	// In the background: see the comment at the top.
	Promise.resolve(Zotero.uiReadyPromise)
		.then(() => announce(Zotero.getMainWindow()))
		.catch(e => state.helperErrors.push('announce: ' + e));
}

function onMainWindowLoad({ window }) {
	if (state) announce(window);
}

function onMainWindowUnload() {}

function shutdown() {
	if (consoleListener) {
		try { Services.console.unregisterListener(consoleListener); }
		catch (e) { /* already gone */ }
	}
	consoleListener = null;
	for (let [o, topic] of observers) {
		try { Services.obs.removeObserver(o, topic); }
		catch (e) { /* already gone */ }
	}
	observers = [];
	delete Zotero.CitationGraphSmoke;
}
