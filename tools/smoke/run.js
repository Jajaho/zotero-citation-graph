#!/usr/bin/env node
'use strict';

/**
 * Load the built XPI into a real, throwaway Zotero, use it the way a user
 * would, and fail on anything in the error console that is about the plugin.
 *
 * Why: #26 and #27 both reached users although each left a trace in Zotero's
 * error console -- "win is undefined" on every menu click on the Zotero 11
 * beta, and a Fluent parser error per plural string in every window. `npm test`
 * runs against hand-written Gecko mocks, and the menu mock made the same
 * assumption as the code. Nothing loaded the XPI into Zotero before a release.
 *
 * Usage:
 *   npm run smoke -- [--zotero <path>] [--xpi <path>] [--report <path>]
 *                    [--headed] [--timeout <s>]
 *
 *   --zotero   the Zotero binary (default: ZOTERO_BIN, then the usual places)
 *   --xpi      test this XPI as it is; without it, build and verify this
 *              checkout's and test dist/<name>-<version>.xpi
 *   --report   where the JSON report goes (default smoke-report.json)
 *   --headed   show the window; headless otherwise
 *   --timeout  for the whole run, in seconds (default 900)
 *
 * What it does, once per locale the XPI ships (locale/<code>/ in the archive),
 * with Zotero pinned to that locale -- Zotero 10 parses only the window
 * locale's .ftl, so an error in the German file is invisible to an English run:
 *
 *   1. A fresh profile and data directory under the OS temp directory. The XPI
 *      is copied in as profile/extensions/<id>.xpi -- a sideload, so the plugin
 *      starts at Zotero's startup, before the main window, as it does for
 *      users. (Marionette's Addon:Install would start it into a window that is
 *      already up, which is the case users never hit.) tools/smoke/helper/ goes
 *      in beside it as a proxy file.
 *   2. Zotero headless, with Marionette on a free port: other runs, or the
 *      user's own Zotero, may be up at the same time.
 *   3. A collection "Smoke" with three journal articles, no DOI, no files.
 *   4. The cases: the plugin finishes starting; the collection menu, and the
 *      item menu over one item and over three, each fired through the plugin's
 *      own entry and required to open a graph tab that shows the papers it was
 *      asked for within 30 s; then the add-on disabled and enabled again, and
 *      the collection entry fired once more.
 *   5. The verdict. Any console error OR warning whose text, source or stack
 *      names the plugin -- its id, its menu ids, its files -- fails the run,
 *      unless tools/smoke/allow.json lists it with a reason. So does any
 *      request to a host other than this machine, unless allow.json lists it;
 *      requests are also marked `ours` when they can be tied to the plugin.
 *      Zotero's own errors are counted and otherwise left alone.
 *
 * The report is a contract (CI reads it):
 *   { ok, zotero: { path, version, gecko }, xpi,
 *     cases: [{ name, ok, ms, error? }],
 *     console: { errors: [...], warnings: [...], ignored: n },
 *     network: [{ ours, method, url, ... }] }
 * plus, when the run could not finish, a top-level `error`. Exit 0 if ok,
 * else 1. Zotero is stopped and the profile and data directory deleted however
 * the run ends: pass, fail, timeout, crash or Ctrl+C (twice to give up on the
 * cleanup).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const launch = require('../lib/zotero-launch.js');
const { connect } = require('../lib/marionette.js');

const root = path.join(__dirname, '..', '..');
const HELPER = path.join(__dirname, 'helper');
const ALLOW = path.join(__dirname, 'allow.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt) => {
	const i = argv.indexOf('--' + name);
	return i === -1 || i === argv.length - 1 ? dflt : argv[i + 1];
};

// How long a menu click has to put a graph on screen. The page needs a second
// or two; thirty is room for a slow CI machine, not a target.
const TAB_WAIT_MS = 30000;
// MenuManager tags each entry with its l10n id (menuManager.js sets
// dataset.l10nId), which is the same in every locale. The label is not.
const ENTRY_L10N_ID = 'zotero-citation-graph-view-citation-graph';
// The ids lib/main.js registers its two menus under. Zotero names them in its
// own errors about the menus, with no file of the plugin's anywhere near.
const MENU_IDS = ['zotero-citation-graph-collection', 'zotero-citation-graph-item'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * The XPI
 * ------------------------------------------------------------------ */

/** The archive's entries, and a reader for one of them. Enough for an XPI. */
function readZip(buf) {
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd === -1) throw new Error('not a zip');
	const entries = new Map();
	let p = buf.readUInt32LE(eocd + 16);
	for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
		const nameLen = buf.readUInt16LE(p + 28);
		entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
			method: buf.readUInt16LE(p + 10),
			size: buf.readUInt32LE(p + 20),
			off: buf.readUInt32LE(p + 42),
		});
		p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
	}
	return {
		names: [...entries.keys()],
		read(name) {
			const e = entries.get(name);
			if (!e) throw new Error('no ' + name + ' in the archive');
			const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
			const body = buf.subarray(start, start + e.size);
			return e.method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
		},
	};
}

/** What the run needs to know of the XPI: its id, version, locales and .ftl files. */
function xpiInfo(xpi) {
	const zip = readZip(fs.readFileSync(xpi));
	const manifest = JSON.parse(zip.read('manifest.json').toString('utf8'));
	const locales = new Set();
	const ftl = new Set();
	for (const name of zip.names) {
		const m = name.match(/^locale\/([^/]+)\/(.+\.ftl)$/);
		if (m) { locales.add(m[1]); ftl.add(path.posix.basename(m[2])); }
	}
	if (!locales.size) throw new Error('the XPI has no locale/<code>/*.ftl');
	return {
		id: manifest.applications.zotero.id,
		version: manifest.version,
		locales: [...locales].sort(),
		ftl: [...ftl].sort(),
	};
}

/** --xpi as given, or this checkout built and verified. */
function resolveXpi() {
	const given = opt('xpi', null);
	if (given) {
		const xpi = path.resolve(given);
		if (!fs.existsSync(xpi) || !fs.statSync(xpi).isFile()) throw new Error('no XPI at ' + xpi);
		return xpi;
	}
	const node = process.execPath;
	execFileSync(node, [path.join(root, 'tools', 'build-xpi.js')], { cwd: root, stdio: 'inherit' });
	execFileSync(node, [path.join(root, 'tools', 'verify-xpi.js')], { cwd: root, stdio: 'inherit' });
	const { xpiName } = require('../check-version.js');
	const version = JSON.parse(fs.readFileSync(path.join(root, 'addon', 'manifest.json'), 'utf8')).version;
	return path.join(root, 'dist', xpiName(version));
}

/**
 * The strings that make a console message the plugin's, wherever they turn up
 * in it: text, source or stack. Its files are reached three ways -- the XPI
 * itself (jar:file:…/<id>.xpi!/…, the id sometimes percent-encoded), the
 * resource:// root bootstrap.js registers, and the .ftl files Zotero's own
 * Fluent loads through the zotero-plugins: scheme -- and Zotero names it by id
 * and by menu id in errors that come from core files.
 */
function markers(info, xpi) {
	return [
		info.id,
		encodeURIComponent(info.id),
		...MENU_IDS,
		'resource://zotero-citation-graph/',
		'chrome://zotero-citation-graph',
		...info.ftl,
		path.basename(xpi),
	];
}

/* ------------------------------------------------------------------ *
 * Zotero
 * ------------------------------------------------------------------ */

/**
 * Prefs beyond the bench's (tools/lib/zotero-launch.js zoteroPrefs()) that
 * keep a smoke run off the network and off the user's ports, and pin it to one
 * locale. Each network line is something a fresh Zotero did on its own in a
 * smoke run; any request that still leaves the machine fails the run unless
 * allow.json says why it may.
 */
function smokePrefs(port, locale, marks) {
	return [
		'user_pref("marionette.port", ' + port + ');',
		'user_pref("intl.locale.requested", ' + launch.pstr(locale) + ');',
		// What the helper must never drop from its buffer; see its startup().
		'user_pref("extensions.zgsmoke.markers", ' + launch.pstr(JSON.stringify(marks)) + ');',
		// The connector server listens on 23119. The user's own Zotero
		// probably holds it already, and this one has no use for it.
		'user_pref("extensions.zotero.httpServer.enabled", false);',
		// Zotero fetches Retraction Watch's list from api.zotero.org as soon as
		// the library has items, and the TLS handshake for it asks an OCSP
		// responder in turn.
		'user_pref("extensions.zotero.retractions.enabled", false);',
		'user_pref("security.OCSP.enabled", 0);',
		// The sync notification socket; Zotero 11 opens it with no account.
		'user_pref("extensions.zotero.streaming.enabled", false);',
		'user_pref("extensions.update.enabled", false);',
		'user_pref("extensions.update.autoUpdateDefault", false);',
		'user_pref("extensions.getAddons.cache.enabled", false);',
		'user_pref("extensions.blocklist.enabled", false);',
		'user_pref("app.update.auto", false);',
		'user_pref("app.update.checkInstallTime", false);',
		'user_pref("network.captive-portal-service.enabled", false);',
		'user_pref("network.connectivity-service.enabled", false);',
		'user_pref("network.dns.disablePrefetch", true);',
		'user_pref("network.prefetch-next", false);',
	];
}

/* ------------------------------------------------------------------ *
 * What runs inside Zotero
 *
 * Each of these is shipped to Zotero as source and run in the chrome context
 * of the main window (lib/marionette.js run()), so it closes over nothing
 * here: everything it needs comes in as an argument.
 * ------------------------------------------------------------------ */

/** The main window up, the schema done, the helper listening. */
async function chromeWaitForZotero(timeoutMs) {
	const t0 = Date.now();
	for (;;) {
		const win = Zotero.getMainWindow && Zotero.getMainWindow();
		if (win && win.ZoteroPane && win.Zotero_Tabs && win.ZoteroPane.collectionsView
			&& Zotero.initialized && Zotero.CitationGraphSmoke) {
			await Zotero.Schema.schemaUpdatePromise;
			await Zotero.uiReadyPromise;
			return {
				version: Zotero.version,
				gecko: Services.appinfo.platformVersion,
				locale: Services.locale.appLocaleAsBCP47,
			};
		}
		if (Date.now() - t0 > timeoutMs) throw new Error('the Zotero main window never came up');
		await new Promise(r => setTimeout(r, 250));
	}
}

/**
 * The plugin fully started: published on Zotero, AND its startup() settled --
 * which Zotero.Plugins tells its observers (the helper is one), after the
 * bootstrap method's promise -- or, if the plugin started before the helper
 * could listen, both of its menus registered, which is the last thing its
 * startup does that anything here depends on.
 *
 * after   how many of the helper's plugin events to skip: a re-enable waits
 *         for a startup newer than the one before it.
 */
async function chromeWaitForPlugin({ id, timeoutMs, after }) {
	const s = Zotero.CitationGraphSmoke;
	const menusIn = () => {
		try {
			const mm = Zotero.MenuManager._menuManager;
			return ['main/library/collection', 'main/library/item']
				.every(t => mm.getCustomMenuOptions(t).some(o => o.pluginID === id));
		}
		catch (e) { return false; }
	};
	const t0 = Date.now();
	for (;;) {
		const started = s.pluginEvents.slice(after).some(e => e.id === id && e.method === 'startup');
		if (Zotero.ZoteroCitationGraph && (started || (after === 0 && menusIn()))) {
			return { via: started ? 'startup observer' : 'menus registered' };
		}
		if (Date.now() - t0 > timeoutMs) {
			throw new Error(Zotero.ZoteroCitationGraph
				? 'the plugin published itself but its startup never finished'
				: 'the plugin never published Zotero.ZoteroCitationGraph');
		}
		await new Promise(r => setTimeout(r, 100));
	}
}

/** The fixture: a collection and its items. No DOI and no files, so nothing to fetch or read. */
async function chromeFixture(name, papers) {
	const libraryID = Zotero.Libraries.userLibraryID;
	const col = new Zotero.Collection({ libraryID, name });
	await col.saveTx();
	const itemIDs = [];
	for (const p of papers) {
		const item = new Zotero.Item('journalArticle');
		item.libraryID = libraryID;
		item.setField('title', p.title);
		item.setField('date', p.date);
		item.setField('publicationTitle', p.journal);
		item.setCreators(p.creators.map(([firstName, lastName]) => ({ firstName, lastName, creatorType: 'author' })));
		item.addToCollection(col.id);
		await item.saveTx();
		itemIDs.push(item.id);
	}
	return { collectionID: col.id, itemIDs };
}

/**
 * Open a context menu the way Zotero does on a right-click, find the plugin's
 * entry, and -- with `fire` -- click it and wait for the graph.
 *
 * kind     'collection' or 'item'
 * select   the item IDs to select first, for 'item'
 * fire     false: only check the entry is there and showing
 * expect   how many papers the graph must show
 *
 * The graph counts as working when the page has its strings, #status is not
 * in its error state (0.78.6 and later mark it `failed`), and the stats line
 * starts with "<expect> / <expect> items" -- in the page's own words, so in
 * any locale. Not merely "#status says something else than Loading…": an
 * error says something else too.
 */
async function chromeMenuCase({ kind, collectionID, select, fire, waitMs, l10nId, expect }) {
	const win = Zotero.getMainWindow();
	const doc = win.document;
	const tabs = win.Zotero_Tabs;
	const sleep = ms => new Promise(r => setTimeout(r, ms));

	tabs.select('zotero-pane');
	await win.ZoteroPane.collectionsView.selectByID('C' + collectionID);
	await win.ZoteroPane.itemsView.waitForLoad();
	if (kind === 'item') {
		await win.ZoteroPane.selectItems(select);
		const n = win.ZoteroPane.getSelectedItems().length;
		if (n !== select.length) throw new Error('selected ' + n + ' items, wanted ' + select.length);
	}

	// Opened until the entry is there, for up to ten seconds: just after a
	// re-enable the menu can be asked for a moment before the plugin's
	// registration has reached it.
	const popupID = kind === 'collection' ? 'zotero-collectionmenu' : 'zotero-itemmenu';
	const popup = doc.getElementById(popupID);
	const openBy = Date.now() + 10000;
	let entry = null;
	let entries = [];
	for (;;) {
		if (popup.state !== 'closed') popup.hidePopup();
		// popupshown can be slow to come, or not come at all, headless; the
		// entry is built and its onShowing run on popupshowing, inside the
		// open call.
		const shown = new Promise(r => popup.addEventListener('popupshown', r, { once: true }));
		const ev = { screenX: 200, screenY: 200, target: null };
		if (kind === 'collection') await win.ZoteroPane.onCollectionsContextMenuOpen(ev, 200, 200);
		else await win.ZoteroPane.onItemsContextMenuOpen(ev, 200, 200);
		await Promise.race([shown, sleep(3000)]);
		entries = [...popup.querySelectorAll('menuitem')].filter(e => e.dataset.l10nId === l10nId);
		entry = entries.find(e => !e.hidden);
		if (entry || Date.now() > openBy) break;
		popup.hidePopup();
		await sleep(300);
	}
	if (!entry) {
		popup.hidePopup();
		throw new Error(entries.length
			? 'the plugin\'s entry is in #' + popupID + ' but hidden'
			: 'no entry with data-l10n-id="' + l10nId + '" in #' + popupID);
	}
	if (!fire) {
		popup.hidePopup();
		return { label: entry.getAttribute('label') };
	}

	const before = new Set(tabs._tabs.map(t => t.id));
	const graphTabs = () => tabs._tabs.filter(t => !before.has(t.id) && /^graph(-|$)/.test(t.type));
	const deadline = Date.now() + waitMs;
	let last = { status: null, stats: null };
	const until = async (what, fn) => {
		for (;;) {
			const v = fn();
			if (v) return v;
			if (Date.now() > deadline) {
				throw new Error('no ' + what + ' within ' + Math.round(waitMs / 1000) + ' s'
					+ (last.status != null ? ' (#status: ' + JSON.stringify(last.status)
						+ ', #stats: ' + JSON.stringify(last.stats) + ')' : ''));
			}
			await sleep(100);
		}
	};
	try {
		entry.doCommand();
		popup.hidePopup();
		const tab = await until('graph tab', () => graphTabs().find(t => t.type === 'graph'));
		const read = () => {
			const box = doc.getElementById(tab.id);
			const browser = box && box.querySelector('browser.zotero-citation-graph');
			const cd = browser && browser.contentDocument;
			if (!cd || cd.readyState === 'loading') return null;
			const cw = browser.contentWindow;
			const L = (cw.wrappedJSObject || cw).ZGL10n;
			const status = cd.getElementById('status');
			const stats = cd.getElementById('stats');
			if (!status || !L || !L.loaded()) return null;
			last = { status: status.textContent.trim(), stats: stats ? stats.textContent.trim() : '' };
			if (status.classList.contains('failed')) {
				throw new Error('#status shows a failure: ' + JSON.stringify(last.status));
			}
			// Built in the page's compartment: a chrome object handed to page
			// code arrives as an opaque wrapper.
			const args = Components.utils.cloneInto({ shown: expect, total: expect }, cw);
			const want = L.t('stats-items', args);
			if (!last.stats.startsWith(want)) return null;
			if (last.status === 'Loading…' || last.status === L.t('status-loading')) return null;
			return Object.assign({ want }, last);
		};
		const first = await until('graph of ' + expect + ' paper' + (expect === 1 ? '' : 's'), read);
		// Then let the build finish before the tab goes, so a build cut short
		// by the close is not what the run ends up reporting. A second of
		// quiet, at most ten.
		let seen = first.status + '\n' + first.stats;
		let quietSince = Date.now();
		const settleBy = Date.now() + 10000;
		while (Date.now() - quietSince < 1000 && Date.now() < settleBy) {
			await sleep(100);
			read();
			const now = last.status + '\n' + last.stats;
			if (now !== seen) { seen = now; quietSince = Date.now(); }
		}
		return { tab: tab.type, status: last.status, stats: last.stats };
	}
	finally {
		for (const t of graphTabs()) tabs.close(t.id);
		await sleep(300);
	}
}

/** Disable the add-on and wait for it to go; enable it. Resolves to the event count to wait past. */
async function chromeDisableEnable(id, waitMs) {
	const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
	const s = Zotero.CitationGraphSmoke;
	const until = async (what, fn) => {
		const t0 = Date.now();
		while (!fn()) {
			if (Date.now() - t0 > waitMs) throw new Error('timed out waiting for ' + what);
			await new Promise(r => setTimeout(r, 100));
		}
	};
	const addon = await AddonManager.getAddonByID(id);
	if (!addon) throw new Error('AddonManager does not know ' + id);
	if (!addon.isActive) throw new Error(id + ' is not active before the case');
	const beforeDisable = s.pluginEvents.length;
	await addon.disable();
	await until('Zotero.ZoteroCitationGraph to go', () => !Zotero.ZoteroCitationGraph);
	await until('the plugin\'s shutdown to finish',
		() => s.pluginEvents.slice(beforeDisable).some(e => e.id === id && e.method === 'shutdown'));
	const beforeEnable = s.pluginEvents.length;
	await addon.enable();
	return beforeEnable;
}

/** What the helper gathered, as JSON. */
function chromeCollect() {
	const s = Zotero.CitationGraphSmoke;
	if (!s) throw new Error('the smoke helper is not running');
	return JSON.parse(JSON.stringify({
		console: s.console, network: s.network, droppedMatching: s.droppedMatching,
		droppedOther: s.droppedOther, helperErrors: s.helperErrors, pluginEvents: s.pluginEvents,
	}));
}

/* ------------------------------------------------------------------ *
 * The verdict
 * ------------------------------------------------------------------ */

function loadAllow() {
	let list;
	try { list = JSON.parse(fs.readFileSync(ALLOW, 'utf8')); }
	catch (e) { throw new Error('could not read ' + ALLOW + ': ' + e.message); }
	if (!Array.isArray(list)) throw new Error(ALLOW + ' must be an array');
	return list.map((a) => {
		const ok = a && typeof a.reason === 'string' && a.reason.trim()
			&& ((typeof a.match === 'string' && a.match) || (typeof a.regex === 'string' && a.regex));
		if (!ok) throw new Error(ALLOW + ': every entry needs a "reason" and a non-empty "match" or "regex"');
		let re = null;
		if (a.regex) {
			try { re = new RegExp(a.regex); }
			catch (e) { throw new Error(ALLOW + ': bad regex ' + a.regex + ': ' + e.message); }
		}
		return {
			reason: a.reason,
			test: (strings) => strings.some(s => s && (a.match ? s.includes(a.match) : re.test(s))),
		};
	});
}

/** Text, source and stack of a message: everywhere it can name the plugin. */
const places = (m) => [m.message, m.sourceName, ...(m.stack || [])].filter(Boolean);

function classify(messages, marks, allow) {
	const out = { errors: [], warnings: [], ignored: 0, allowed: [], unattributed: [], ignoredMessages: [] };
	for (const m of messages) {
		if (m.level !== 'error' && m.level !== 'warning') continue;
		const where = places(m);
		const ours = where.some(w => marks.some(k => w.includes(k)));
		if (ours) {
			const a = allow.find(x => x.test(where));
			if (a) out.allowed.push(Object.assign({}, m, { reason: a.reason }));
			else (m.level === 'error' ? out.errors : out.warnings).push(m);
			continue;
		}
		if (m.level !== 'error') continue;
		out.ignored++;
		// No source and nothing of ours on the stack: it could be anybody's.
		// "uncaught exception: undefined" is the usual one, a promise
		// rejected with nothing. Shown, not failed.
		if (!m.sourceName && out.unattributed.length < 50) out.unattributed.push(m);
		if (out.ignoredMessages.length < 200) out.ignoredMessages.push(m);
	}
	return out;
}

/**
 * Every request that left the machine, marked `ours` when it can be tied to
 * the plugin -- the graph page's resource:// principal on it, or one of the
 * plugin's files on the stack when it was opened -- and `allowed` when
 * allow.json says why it may. Every request that is not allowed fails the
 * run, the plugin's or not: the profile switches Zotero's own off, so a new
 * one is a new default to switch off too, and found here rather than later.
 */
function judgeNetwork(requests, marks, allow) {
	return requests.map((r) => {
		const where = [r.triggeringPrincipal, r.loadingPrincipal, ...(r.stack || [])].filter(Boolean);
		const ours = where.some(w => marks.some(k => w.includes(k)));
		const a = allow.find(x => x.test([r.url]));
		return Object.assign({ ours }, r, a ? { allowed: a.reason } : null);
	});
}

/** Where a message came from, with the temp-directory part of a jar: URI cut down. */
function source(m) {
	const src = (m.sourceName || '').replace(/^jar:file:\/\/\/.*\/([^/]+\.xpi)!/, 'jar:…/$1!');
	return src ? src + (m.line ? ':' + m.line : '') : '';
}

const shortFrame = (f) => f.replace(/^jar:file:\/\/\/.*\/([^/]+\.xpi)!/, 'jar:…/$1!');

/** The text on one line. Newlines are shown escaped, as Fluent's own "\n | \r\n" is. */
function text(m) {
	return String(m.message).replace(/\r/g, '\\r').replace(/\n/g, '\\n').trim();
}

/**
 * Messages grouped by text, a group per line: one bad .ftl is a parser error
 * per message per locale per window -- 165 lines on the Zotero 11 beta, which
 * would bury the one line that says something else.
 */
function printGrouped(list, { reason = false, stack = false } = {}) {
	const groups = new Map();
	for (const m of list) {
		const key = m.level + ' ' + text(m);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(m);
	}
	for (const ms of groups.values()) {
		const srcs = [...new Set(ms.map(source).filter(Boolean))];
		console.log('    [' + ms[0].level + '] ' + (ms.length > 1 ? ms.length + 'x ' : '') + text(ms[0])
			+ (reason ? '  -- ' + ms[0].reason : ''));
		for (const s of srcs.slice(0, 3)) console.log('        @ ' + s);
		if (srcs.length > 3) console.log('        @ ... and ' + (srcs.length - 3) + ' more (see the report)');
		const frames = (ms.find(m => (m.stack || []).length) || {}).stack || [];
		if ((stack || !srcs.length) && frames.length) {
			for (const f of frames.slice(0, 4)) console.log('        < ' + shortFrame(f));
		}
	}
}

/* ------------------------------------------------------------------ *
 * Driving it
 * ------------------------------------------------------------------ */

const PAPERS = [
	{ title: 'A smoke test of citation graphs', date: '2019', journal: 'Journal of Smoke', creators: [['Ada', 'Lovelace']] },
	{ title: 'On the graphs of citations', date: '2021-03', journal: 'Journal of Smoke', creators: [['Alan', 'Turing'], ['Grace', 'Hopper']] },
	{ title: 'Ghosts in the reference list', date: '2023', journal: 'Annals of Fixtures', creators: [['Barbara', 'Liskov']] },
];

async function main() {
	const reportPath = path.resolve(opt('report', 'smoke-report.json'));
	const headed = flag('headed');

	const report = {
		ok: false,
		zotero: { path: null, version: null, gecko: null },
		xpi: null,
		cases: [],
		console: { errors: [], warnings: [], ignored: 0 },
		network: [],
		runs: [],
	};

	// Everything the launches gathered, judged once at the end.
	const raw = { console: [], network: [], droppedMatching: 0, droppedOther: 0, helperErrors: [] };
	let current = null; // the launch in progress: { child, profile, dataDir, m, locale, collected }
	let marks = [];
	let allow = [];
	let cleanupFailed = false;

	const collect = async (run) => {
		if (!run || run.collected || !run.m) return;
		const got = await Promise.race([run.m.run(chromeCollect).catch(() => null), sleep(10000).then(() => null)]);
		if (!got) return;
		run.collected = true;
		const tag = (e) => Object.assign({ locale: run.locale }, e);
		raw.console.push(...got.console.map(tag));
		raw.network.push(...got.network.map(tag));
		raw.droppedMatching += got.droppedMatching;
		raw.droppedOther += got.droppedOther;
		raw.helperErrors.push(...got.helperErrors);
		const r = report.runs.find(x => x.locale === run.locale);
		if (r) r.pluginEvents = got.pluginEvents;
	};

	const stop = async (run) => {
		if (!run || run.stopped) return;
		run.stopped = true;
		if (run.m) await Promise.race([run.m.close().catch(() => {}), sleep(3000)]);
		if (run.child) {
			const gone = await launch.stopByProfile(run.child, run.profile);
			if (!gone) cleanupFailed = true;
		}
		if (!await launch.removeDir(run.profile)) cleanupFailed = true;
		if (!await launch.removeDir(run.dataDir)) cleanupFailed = true;
	};

	let finishing = null;
	const finish = (why) => {
		if (finishing) return finishing;
		finishing = (async () => {
			if (why && !report.error) report.error = why;
			// What the console held by then is the most useful thing a failed
			// run can leave behind, so it is asked for even on the way out.
			try { await collect(current); }
			catch (e) { /* the session is gone */ }
			try { await stop(current); }
			catch (e) { cleanupFailed = true; }

			const c = classify(raw.console, marks, allow);
			report.console = {
				errors: c.errors, warnings: c.warnings, ignored: c.ignored,
				allowed: c.allowed, unattributed: c.unattributed, ignoredMessages: c.ignoredMessages,
				droppedMatching: raw.droppedMatching, droppedOther: raw.droppedOther,
			};
			report.network = judgeNetwork(raw.network, marks, allow);
			if (raw.helperErrors.length) report.helperErrors = raw.helperErrors;
			if (cleanupFailed) report.cleanupFailed = true;
			report.ok = !report.error
				&& report.cases.length > 0 && report.cases.every(x => x.ok)
				&& c.errors.length === 0 && c.warnings.length === 0
				&& raw.droppedMatching === 0
				&& report.network.every(r => r.allowed)
				&& !cleanupFailed;
			try { print(report, reportPath); }
			catch (e) { console.error('could not print the summary: ' + e.message); }
			try {
				fs.mkdirSync(path.dirname(reportPath), { recursive: true });
				fs.writeFileSync(reportPath, JSON.stringify(report, null, '\t') + '\n');
			}
			catch (e) {
				console.error('could not write ' + reportPath + ': ' + e.message);
				report.ok = false;
			}
			process.exit(report.ok ? 0 : 1);
		})();
		return finishing;
	};
	process.on('SIGINT', () => {
		// A second Ctrl+C means "stop waiting for the cleanup".
		if (finishing) process.exit(130);
		finish('interrupted');
	});
	process.on('SIGTERM', () => finish('terminated'));
	process.on('uncaughtException', (e) => finish('crashed: ' + (e && e.stack || e)));
	process.on('unhandledRejection', (e) => finish('crashed: ' + (e && e.stack || e)));
	// Nothing asynchronous runs in an exit handler; off Windows a group kill
	// is still possible, and is what is left if the cleanup never ran.
	process.on('exit', () => {
		if (current && !current.stopped) launch.killGroupSync(current.child);
	});

	try {
		const timeoutS = Number(opt('timeout', 900));
		if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error('--timeout takes a number of seconds > 0');
		const timer = setTimeout(() => finish('timed out after ' + timeoutS + ' s'), timeoutS * 1000);
		timer.unref();

		allow = loadAllow();
		const binary = launch.findZotero(opt('zotero', process.env.ZOTERO_BIN));
		report.zotero.path = binary;
		const xpi = resolveXpi();
		report.xpi = xpi;
		const info = xpiInfo(xpi);
		marks = markers(info, xpi);

		for (const locale of info.locales) {
			if (finishing) break;
			await runLocale({ locale, binary, xpi, info, headed, report, setCurrent: (r) => { current = r; },
				collect, stop, isFinishing: () => !!finishing });
		}
	}
	catch (e) {
		report.error = String(e.message || e);
	}
	await finish();
}

/** One launch of Zotero, pinned to `locale`, through every case. */
async function runLocale({ locale, binary, xpi, info, headed, report, setCurrent, collect, stop, isFinishing }) {
	const port = await launch.freePort();
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-smoke-data-'));
	const run = { locale, child: null, profile: null, dataDir, m: null, collected: false, stopped: false };
	setCurrent(run);
	run.profile = launch.makeProfile([...launch.zoteroPrefs(dataDir), ...smokePrefs(port, locale, markers(info, xpi))],
		'zg-smoke-');
	const ext = path.join(run.profile, 'extensions');
	fs.mkdirSync(ext, { recursive: true });
	fs.copyFileSync(xpi, path.join(ext, info.id + '.xpi'));
	launch.installProxy(run.profile, HELPER);

	console.log('\nsmoke: ' + path.basename(xpi) + ' (' + info.version + ') in ' + binary + ', locale ' + locale);
	const args = ['-no-remote', '-profile', run.profile, '--marionette', '--remote-allow-system-access'];
	// MOZ_HEADLESS set or taken away: one inherited from the shell would
	// otherwise make --headed headless.
	const env = { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', MOZ_HEADLESS: headed ? null : '1' };
	if (!headed) args.push('-headless');
	let spawnError = null;
	run.child = launch.spawnApp(binary, args, { env });
	run.child.on('error', (e) => { spawnError = e; });
	let stderr = '';
	run.child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
	run.child.stdout.on('data', () => {});

	try {
		run.m = await Promise.race([
			connect(port, { timeoutMs: 180000, scriptTimeoutMs: 120000 }),
			new Promise((resolve, reject) => run.child.once('error', e => reject(new Error('could not start ' + binary + ': ' + e.message)))),
		]);
	}
	catch (e) {
		throw new Error((spawnError ? 'could not start ' + binary + ': ' + spawnError.message : e.message)
			+ (stderr.trim() ? '\n  Zotero said: ' + stderr.trim().split('\n').slice(-5).join('\n    ') : ''));
	}
	const m = run.m;
	const z = await m.run(chromeWaitForZotero, 120000);
	Object.assign(report.zotero, { version: z.version, gecko: z.gecko });
	report.runs.push({ locale, appLocale: z.locale, port });
	console.log('       Zotero ' + z.version + ', Gecko ' + z.gecko + ', app locale ' + z.locale + ', Marionette on ' + port);

	const runCase = async (name, fn) => {
		// Past a timeout or a Ctrl+C the session is being torn down under
		// whatever is still running here; what it would report is noise.
		if (isFinishing()) return false;
		const t0 = Date.now();
		const c = { name: '[' + locale + '] ' + name, ok: false, ms: 0 };
		try {
			const r = await fn();
			// What the graph page said once it had loaded: the first thing to
			// read when a pass looks too easy.
			if (r && typeof r.stats === 'string') { c.status = r.status; c.stats = r.stats; }
			c.ok = true;
		}
		catch (e) {
			c.error = String(e.message || e).replace(/^WebDriver:ExecuteScript: [^:]+: /, '');
		}
		c.ms = Date.now() - t0;
		if (isFinishing()) return false;
		report.cases.push(c);
		console.log('  ' + (c.ok ? 'ok  ' : 'FAIL') + '  ' + c.name + '  (' + (c.ms / 1000).toFixed(1) + ' s)'
			+ (c.stats ? '  #stats: ' + JSON.stringify(c.stats.slice(0, 60)) : '')
			+ (c.error ? '\n          ' + c.error : ''));
		return c.ok;
	};

	const started = await runCase('plugin starts', () => m.run(chromeWaitForPlugin, { id: info.id, timeoutMs: 60000, after: 0 }));
	if (started) {
		const fx = await m.run(chromeFixture, 'Smoke', PAPERS);
		const menu = (kind, select, expect, fire = true) => m.run(chromeMenuCase, {
			kind, collectionID: fx.collectionID, select, fire, expect, waitMs: TAB_WAIT_MS, l10nId: ENTRY_L10N_ID,
		});
		await runCase('collection menu, "Smoke" selected', () => menu('collection', null, PAPERS.length));
		await runCase('item menu, 1 item selected', () => menu('item', fx.itemIDs.slice(0, 1), 1));
		await runCase('item menu, 3 items selected', () => menu('item', fx.itemIDs, fx.itemIDs.length));
		await runCase('disable and re-enable, then the collection menu again', async () => {
			const after = await m.run(chromeDisableEnable, info.id, TAB_WAIT_MS);
			await m.run(chromeWaitForPlugin, { id: info.id, timeoutMs: TAB_WAIT_MS, after });
			// Back means back in the menu and opening graphs, not only on the
			// Zotero object.
			return menu('collection', null, PAPERS.length);
		});
	}
	// Errors from a promise the last case left running land a moment late.
	await sleep(1500);
	await collect(run);
	await stop(run);
	setCurrent(null);
}

function print(report, reportPath) {
	const c = report.console;
	console.log('');
	if (report.error) console.log('  error: ' + report.error);
	if (c.errors.length) {
		console.log('  plugin errors in the console (' + c.errors.length + '):');
		printGrouped(c.errors, { stack: true });
	}
	if (c.warnings.length) {
		console.log('  plugin warnings in the console (' + c.warnings.length + '):');
		printGrouped(c.warnings, { stack: true });
	}
	if (c.droppedMatching) console.log('  plugin messages the helper had to drop: ' + c.droppedMatching);
	if (c.allowed && c.allowed.length) {
		console.log('  allowed by tools/smoke/allow.json (' + c.allowed.length + ', not failing):');
		printGrouped(c.allowed, { reason: true });
	}
	const blocked = report.network.filter(r => !r.allowed);
	const allowedNet = report.network.filter(r => r.allowed);
	if (blocked.length) {
		console.log('  requests that left the machine (' + blocked.length + '):');
		for (const r of blocked) {
			console.log('    ' + r.method + ' ' + r.url + (r.ours ? '  (the plugin\'s)' : '  (Zotero\'s own: switch it off in smokePrefs())'));
		}
	}
	if (allowedNet.length) {
		console.log('  requests allowed by tools/smoke/allow.json (' + allowedNet.length + ', not failing):');
		for (const r of allowedNet) console.log('    ' + r.method + ' ' + r.url + '  -- ' + r.allowed);
	}
	if (c.unattributed && c.unattributed.length) {
		console.log('  unattributed errors, with no source (' + c.unattributed.length + ', not failing):');
		printGrouped(c.unattributed, { stack: true });
	}
	console.log('  Zotero\'s own errors, ignored: ' + c.ignored);
	if (report.cleanupFailed) console.log('  cleanup FAILED: a Zotero process or a temp directory was left behind');
	console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + '  report: ' + reportPath);
}

main().catch((e) => {
	console.error(e.stack || e);
	process.exit(1);
});
