/* global Zotero, Services, Cc, Ci, ChromeUtils, Components */
'use strict';

/**
 * The smoke test's eyes inside Zotero. Development only: tools/smoke/run.js
 * installs it as a proxy file into a throwaway profile, next to the XPI under
 * test. It is never part of the plugin and never installed in a real profile.
 *
 * What it does:
 *
 * 1. Let Marionette in. Marionette starts listening, and opens a session, only
 *    once the application says its startup is done -- the way FIREFOX says it:
 *    "browser-idle-startup-tasks-finished", sent by Firefox's BrowserGlue.
 *    Zotero ships the remote agent but not that part of Firefox, so on Windows
 *    the topic never comes. This sends it, once, when the main window has
 *    loaded, which is what Marionette checks next (by readyState). In Zotero
 *    only Marionette and the remote agent observe the topic.
 *
 * 2. Keep every console message, with the stack it carries. Zotero's error
 *    console is where #26 and #27 left their only trace. Messages logged
 *    before this add-on started -- the plugin may well start first -- are
 *    taken from the console service's backlog, and console.* calls, which
 *    never reach the console service, from the console API's storage.
 *
 *    A plugin's error does not always name the plugin's files. When a core
 *    API throws under the plugin, the error's source is the core file, and
 *    Zotero.logError() passes on only the message and that file. So
 *    Zotero.logError and Zotero.warn are wrapped -- passed straight through --
 *    to note the error's own stack and the caller's, which run.js then
 *    searches for the plugin's files as well.
 *
 * 3. Note every HTTP request to a host that is not this machine, with what is
 *    known of who made it (principals, the JS stack).
 *
 * 4. Note when each plugin's startup() and shutdown() have finished, through
 *    Zotero.Plugins' observer list, which Zotero calls after the bootstrap
 *    method's promise settles -- the only outside view of "fully started".
 *
 * run.js reads it all from Zotero.CitationGraphSmoke over Marionette. It
 * passes the strings that make a message the plugin's in the pref
 * extensions.zgsmoke.markers, so that the cap below never drops one of those.
 *
 * startup() returns at once. Zotero starts add-ons one after another and waits
 * for each startup(), so one that waited for the main window would hold back
 * the plugin under test until after it -- and the point of sideloading the XPI
 * is that the plugin starts before the main window, as it does for users.
 */

const TOPIC = 'browser-idle-startup-tasks-finished';
// Zotero's own chatter is capped; past it, a count. The plugin's messages are
// kept to a far higher ceiling, and run.js fails the run if even that is hit.
const MAX_OTHER = 5000;
const MAX_MATCHING = 50000;

let state = null;
let markers = [];
let helperRoot = '';
let consoleListener = null;
let observers = [];
let pluginObserver = null;
let unwrap = [];
// Stacks noted by the logError/warn wrappers, waiting for the console message
// the same call is about to log.
let pendingStacks = [];
const seenChannels = new Set();

function mentions(entry) {
	let hay = [entry.message, entry.sourceName, ...(entry.stack || [])];
	return hay.some(h => h && markers.some(k => String(h).includes(k)));
}

function pushConsole(entry) {
	if (mentions(entry)) {
		if (state.matching < MAX_MATCHING) {
			state.matching++;
			state.console.push(entry);
		}
		else state.droppedMatching++;
	}
	else if (state.console.length - state.matching < MAX_OTHER) {
		state.console.push(entry);
	}
	else state.droppedOther++;
}

/** Frames as "source:line", innermost first, without this add-on's own. */
function framesFromSaved(frame) {
	let out = [];
	for (let n = 0; frame && n < 40; n++) {
		if (frame.source && !frame.source.startsWith(helperRoot)) out.push(frame.source + ':' + frame.line);
		frame = frame.parent || frame.asyncParent;
	}
	return out;
}

function framesHere() {
	let out = [];
	let f = Components.stack;
	for (let n = 0; f && n < 64; n++) {
		if (f.filename && !f.filename.startsWith(helperRoot)) out.push(f.filename + ':' + f.lineNumber);
		f = f.caller || f.asyncCaller;
	}
	return out.slice(0, 40);
}

/** "fn@file:line:col" lines of an Error's stack string, as "file:line". */
function framesFromString(stack) {
	if (typeof stack !== 'string') return [];
	let out = [];
	for (let l of stack.split('\n')) {
		let m = l.match(/@(.+):(\d+):\d+$/);
		if (m && !m[1].startsWith(helperRoot)) out.push(m[1] + ':' + m[2]);
	}
	return out.slice(0, 40);
}

/** The stack the logError/warn wrapper noted for this message, if any. */
function takePending(text) {
	let i = pendingStacks.findIndex(p => p.text === text);
	if (i === -1) return [];
	return pendingStacks.splice(i, 1)[0].frames;
}

const LEVELS = ['debug', 'info', 'warning', 'error'];

/** An nsIConsoleMessage as plain JSON. */
function fromConsoleService(msg) {
	try {
		let e = msg.QueryInterface(Ci.nsIScriptError);
		let level = 'error';
		if (e.flags & Ci.nsIScriptError.warningFlag) level = 'warning';
		else if (e.flags & Ci.nsIScriptError.infoFlag) level = 'info';
		let message = e.errorMessage || e.message || '';
		let stack = [];
		try { stack = framesFromSaved(e.stack); }
		catch (err) { /* no stack on this message */ }
		stack.push(...takePending(message));
		return {
			kind: 'script',
			level,
			flags: e.flags,
			sourceName: e.sourceName || '',
			message,
			category: e.category || '',
			line: e.lineNumber || 0,
			at: e.timeStamp,
			stack,
		};
	}
	catch (notScriptError) {
		let level = 'info';
		try {
			if (typeof msg.logLevel === 'number' && LEVELS[msg.logLevel]) level = LEVELS[msg.logLevel];
		}
		catch (e) { /* no logLevel on this Gecko */ }
		let message = String(msg.message || '');
		return {
			kind: 'message',
			level,
			flags: null,
			sourceName: '',
			message,
			category: '',
			line: 0,
			at: msg.timeStamp,
			stack: takePending(message),
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
	let stack = [];
	for (let f of ev.stacktrace || []) {
		if (f.filename && !f.filename.startsWith(helperRoot)) stack.push(f.filename + ':' + f.lineNumber);
	}
	return {
		kind: 'console-api',
		level,
		flags: null,
		sourceName: ev.filename || '',
		message: (ev.arguments || []).map(argText).join(' '),
		category: 'console-api:' + ev.level,
		line: ev.lineNumber || 0,
		at: ev.timeStamp,
		stack,
	};
}

/**
 * Pass-through wrappers that note the error's own stack and the caller's.
 * Zotero.log() hands the console only the message and one file name; this is
 * the rest. Matched to the console message by its text, in takePending().
 */
function wrapLogging() {
	for (let name of ['logError', 'warn']) {
		let orig = Zotero[name];
		if (typeof orig !== 'function') continue;
		Zotero[name] = function (err) {
			try {
				let text = err && err.message ? err.message : String(err);
				let frames = [...framesFromString(err && err.stack), ...framesHere()];
				pendingStacks.push({ text, frames });
				if (pendingStacks.length > 200) pendingStacks.shift();
			}
			catch (e) { /* never get in the way of the real call */ }
			return orig.apply(this, arguments);
		};
		unwrap.push(() => { Zotero[name] = orig; });
	}
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

function principalSpec(p) {
	if (!p) return '';
	try {
		if (p.isSystemPrincipal) return 'system';
		return p.spec || (p.URI && p.URI.spec) || p.origin || '';
	}
	catch (e) { return ''; }
}

/**
 * One request to a host other than this machine, with what is known of who
 * made it: the principals on its loadInfo (a request from the graph page
 * carries the page's resource:// principal) and the stack when it was opened
 * (one from the plugin's chrome code carries the system principal, like
 * Zotero's own, but has the plugin's files on the stack).
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
		state.network.push({
			method: ch.requestMethod,
			url: uri.spec,
			at: Date.now(),
			seenAt: when,
			triggeringPrincipal: principalSpec(li && li.triggeringPrincipal),
			loadingPrincipal: principalSpec(li && li.loadingPrincipal),
			stack: when === 'opening' ? framesHere() : [],
		});
	}
	catch (e) { /* not an HTTP channel after all */ }
}

function startListening() {
	// The backlog first, then the listener: the console service calls
	// listeners only for what is logged after they register.
	try {
		for (let m of Services.console.getMessageArray() || []) pushConsole(fromConsoleService(m));
	}
	catch (e) { state.helperErrors.push('console backlog: ' + e); }
	consoleListener = {
		QueryInterface: ChromeUtils.generateQI(['nsIConsoleListener']),
		observe(m) {
			try { pushConsole(fromConsoleService(m)); }
			catch (e) { /* never throw back into the console service */ }
		},
	};
	Services.console.registerListener(consoleListener);

	try {
		let storage = Cc['@mozilla.org/consoleAPI-storage;1'].getService(Ci.nsIConsoleAPIStorage);
		for (let ev of storage.getEvents() || []) pushConsole(fromConsoleAPI(ev));
	}
	catch (e) { state.helperErrors.push('console API backlog: ' + e); }
	observe('console-api-log-event', (subject) => {
		try { pushConsole(fromConsoleAPI(subject.wrappedJSObject)); }
		catch (e) { /* as above */ }
	});

	// Opening, not modify: http-on-opening-request is sent from inside
	// AsyncOpen, while whoever asked -- fetch(), XHR's send() -- is still on
	// the stack. Modify is the backstop for a channel opening did not report.
	observe('http-on-opening-request', subject => recordRequest(subject, 'opening'));
	observe('http-on-modify-request', subject => recordRequest(subject, 'modify'));
}

function watchPlugins() {
	if (!Zotero.Plugins || typeof Zotero.Plugins.addObserver !== 'function') return;
	let note = method => ({ id }, reason) => {
		state.pluginEvents.push({ method, id, reason, at: Date.now() });
	};
	pluginObserver = { startup: note('startup'), shutdown: note('shutdown') };
	Zotero.Plugins.addObserver(pluginObserver);
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

function startup({ rootURI }) {
	helperRoot = rootURI || '';
	try { markers = JSON.parse(Services.prefs.getStringPref('extensions.zgsmoke.markers', '[]')); }
	catch (e) { markers = []; }
	state = {
		started: Date.now(),
		announced: false,
		matching: 0,
		droppedMatching: 0,
		droppedOther: 0,
		helperErrors: [],
		pluginEvents: [],
		console: [],
		network: [],
	};
	Zotero.CitationGraphSmoke = state;
	wrapLogging();
	watchPlugins();
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
	if (pluginObserver) Zotero.Plugins.removeObserver(pluginObserver);
	pluginObserver = null;
	for (let f of unwrap) f();
	unwrap = [];
	delete Zotero.CitationGraphSmoke;
}
