#!/usr/bin/env node
'use strict';

/**
 * Load the built XPI into a real, throwaway Zotero, use it the way a user
 * would, and fail on anything the plugin's own files put in the error console.
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
 *   --timeout  for the whole run, in seconds (default 600)
 *
 * What it does:
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
 *   4. The cases: the collection menu, the item menu over one item and over
 *      three, each fired through the plugin's own entry and required to open a
 *      graph tab whose #status leaves "Loading…" within 30 s; then the add-on
 *      disabled and enabled again.
 *   5. The verdict: any console ERROR whose source or text points at the
 *      plugin's files fails the run, unless tools/smoke/allow.json lists it
 *      with a reason; warnings of the same kind are printed and let pass; any
 *      request the plugin made to a host other than this machine fails the
 *      run. Zotero's own errors are counted and otherwise left alone, and its
 *      own requests are listed with `ours: false`.
 *
 * The report is a contract (CI reads it):
 *   { ok, zotero: { path, version, gecko }, xpi,
 *     cases: [{ name, ok, ms, error? }],
 *     console: { errors: [...], warnings: [...], ignored: n },
 *     network: [{ ours, method, url, ... }] }
 * plus, when the run could not finish, a top-level `error`. Exit 0 if ok,
 * else 1. Zotero is stopped and the profile and data directory deleted however
 * the run ends: pass, fail, timeout or Ctrl+C.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * The XPI
 * ------------------------------------------------------------------ */

/** One file out of a zip, by name. Enough to read an XPI's manifest. */
function readZipEntry(buf, name) {
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd === -1) throw new Error('not a zip');
	let p = buf.readUInt32LE(eocd + 16);
	for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
		const nameLen = buf.readUInt16LE(p + 28);
		const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
		if (entryName === name) {
			const method = buf.readUInt16LE(p + 10);
			const size = buf.readUInt32LE(p + 20);
			const off = buf.readUInt32LE(p + 42);
			const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
			const body = buf.subarray(start, start + size);
			return method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
		}
		p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
	}
	throw new Error('no ' + name + ' in the archive');
}

/** --xpi as given, or this checkout built and verified. */
function resolveXpi() {
	const given = opt('xpi', null);
	if (given) {
		const xpi = path.resolve(given);
		if (!fs.existsSync(xpi)) throw new Error('no XPI at ' + xpi);
		return xpi;
	}
	const node = process.execPath;
	execFileSync(node, [path.join(root, 'tools', 'build-xpi.js')], { cwd: root, stdio: 'inherit' });
	execFileSync(node, [path.join(root, 'tools', 'verify-xpi.js')], { cwd: root, stdio: 'inherit' });
	const { xpiName } = require('../check-version.js');
	const version = JSON.parse(fs.readFileSync(path.join(root, 'addon', 'manifest.json'), 'utf8')).version;
	return path.join(root, 'dist', xpiName(version));
}

/* ------------------------------------------------------------------ *
 * Zotero
 * ------------------------------------------------------------------ */

/**
 * Prefs beyond the bench's (tools/lib/zotero-launch.js zoteroPrefs()) that
 * keep a smoke run off the network and off the user's ports. Each line is
 * something a fresh Zotero did, or could do, on its own. The network check
 * only fails on requests it can tie to the plugin (attribute()), but a quiet
 * Zotero keeps the list short enough that a new one is noticed.
 */
function smokePrefs(port) {
	return [
		'user_pref("marionette.port", ' + port + ');',
		// The connector server listens on 23119. The user's own Zotero
		// probably holds it already, and this one has no use for it.
		'user_pref("extensions.zotero.httpServer.enabled", false);',
		// Zotero fetches Retraction Watch's list from api.zotero.org as soon as
		// the library has items, and the TLS handshake for it asks an OCSP
		// responder in turn. Both were in the first smoke run's requests.
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

/** The plugin has published itself, as bootstrap.js does at the end of startup. */
async function chromeWaitForPlugin(timeoutMs) {
	const t0 = Date.now();
	while (!Zotero.ZoteroCitationGraph) {
		if (Date.now() - t0 > timeoutMs) throw new Error('the plugin never published Zotero.ZoteroCitationGraph');
		await new Promise(r => setTimeout(r, 100));
	}
	return true;
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
 */
async function chromeMenuCase({ kind, collectionID, select, fire, waitMs, l10nId }) {
	const win = Zotero.getMainWindow();
	const doc = win.document;
	const tabs = win.Zotero_Tabs;
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const until = async (what, fn, deadline) => {
		for (;;) {
			const v = fn();
			if (v) return v;
			if (Date.now() > deadline) throw new Error('no ' + what + ' within ' + Math.round(waitMs / 1000) + ' s');
			await sleep(100);
		}
	};

	tabs.select('zotero-pane');
	await win.ZoteroPane.collectionsView.selectByID('C' + collectionID);
	await win.ZoteroPane.itemsView.waitForLoad();
	if (kind === 'item') {
		await win.ZoteroPane.selectItems(select);
		const n = win.ZoteroPane.getSelectedItems().length;
		if (n !== select.length) throw new Error('selected ' + n + ' items, wanted ' + select.length);
	}

	const popupID = kind === 'collection' ? 'zotero-collectionmenu' : 'zotero-itemmenu';
	const popup = doc.getElementById(popupID);
	if (popup.state !== 'closed') popup.hidePopup();
	// popupshown can be slow to come, or not come at all, headless; the entry
	// is built and its onShowing run on popupshowing, inside the open call.
	const shown = new Promise(r => popup.addEventListener('popupshown', r, { once: true }));
	const ev = { screenX: 200, screenY: 200, target: null };
	if (kind === 'collection') await win.ZoteroPane.onCollectionsContextMenuOpen(ev, 200, 200);
	else await win.ZoteroPane.onItemsContextMenuOpen(ev, 200, 200);
	await Promise.race([shown, sleep(5000)]);

	const entries = [...popup.querySelectorAll('menuitem')].filter(e => e.dataset.l10nId === l10nId);
	const entry = entries.find(e => !e.hidden);
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
	try {
		entry.doCommand();
		popup.hidePopup();
		const tab = await until('graph tab', () => graphTabs().find(t => t.type === 'graph'), deadline);
		const page = () => {
			const box = doc.getElementById(tab.id);
			const browser = box && box.querySelector('browser.zotero-citation-graph');
			const cd = browser && browser.contentDocument;
			if (!cd || cd.readyState === 'loading') return null;
			const cw = browser.contentWindow.wrappedJSObject || browser.contentWindow;
			const el = cd.getElementById('status');
			return el ? { el, L: cw.ZGL10n } : null;
		};
		// "Loading…" is what graph.html says until chrome has sent the strings
		// and the data; the strings come first, and then the same words in the
		// user's language. Left means neither, with the strings in.
		const statusText = () => {
			const p = page();
			if (!p || !p.L || !p.L.loaded()) return null;
			const text = p.el.textContent.trim();
			if (text === 'Loading…' || text === p.L.t('status-loading')) return null;
			return { text };
		};
		const first = await until('#status leaving "Loading…"', statusText, deadline);
		// Then let the build finish before the tab goes, so a build cut short
		// by the close is not what the run ends up reporting. A second of
		// quiet, at most ten.
		let last = first.text;
		let quietSince = Date.now();
		const settleBy = Date.now() + 10000;
		while (Date.now() - quietSince < 1000 && Date.now() < settleBy) {
			await sleep(100);
			const s = statusText();
			const text = s ? s.text : last;
			if (text !== last) { last = text; quietSince = Date.now(); }
		}
		return { tab: tab.type, status: last };
	}
	finally {
		for (const t of graphTabs()) tabs.close(t.id);
		await sleep(300);
	}
}

/** Disable the add-on, wait for it to go, enable it again, wait for it to come back. */
async function chromeDisableEnable(id, waitMs) {
	const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
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
	await addon.disable();
	await until('Zotero.ZoteroCitationGraph to go', () => !Zotero.ZoteroCitationGraph);
	await addon.enable();
	await until('Zotero.ZoteroCitationGraph to come back', () => !!Zotero.ZoteroCitationGraph);
	return true;
}

/** What the helper gathered, as JSON. */
function chromeCollect() {
	const s = Zotero.CitationGraphSmoke;
	if (!s) throw new Error('the smoke helper is not running');
	return JSON.parse(JSON.stringify({
		console: s.console, network: s.network, dropped: s.dropped, helperErrors: s.helperErrors,
	}));
}

/* ------------------------------------------------------------------ *
 * The verdict
 * ------------------------------------------------------------------ */

/**
 * The strings that make a console message the plugin's. Its files are reached
 * three ways: the XPI itself (jar:file:…/<id>.xpi!/…, the id sometimes
 * percent-encoded), the resource:// root bootstrap.js registers, and the .ftl
 * Zotero's own Fluent loads through the zotero-plugins: scheme.
 */
function markers(id, xpi) {
	const out = [
		id + '.xpi',
		encodeURIComponent(id) + '.xpi',
		'resource://zotero-citation-graph/',
		'chrome://zotero-citation-graph',
		'zotero-citation-graph.ftl',
	];
	if (xpi) out.push(path.basename(xpi));
	return out;
}

/**
 * The helper's requests, each marked `ours` when it can be tied to the
 * plugin: the graph page's resource:// principal on its loadInfo, or one of
 * the plugin's files on the JS stack when it was opened. Zotero's own -- a
 * new default the profile does not switch off yet -- stay in the report with
 * `ours: false` and do not fail the run: a CI machine is no place to find out
 * that Zotero 12 checks something new at startup.
 */
function attribute(requests, marks) {
	return requests.map((r) => {
		const where = [r.triggeringPrincipal, r.loadingPrincipal, ...(r.stack || [])].filter(Boolean);
		const ours = where.some(w => marks.some(k => w.includes(k)));
		return Object.assign({ ours }, r);
	});
}

function loadAllow() {
	let list;
	try { list = JSON.parse(fs.readFileSync(ALLOW, 'utf8')); }
	catch (e) { throw new Error('could not read ' + ALLOW + ': ' + e.message); }
	if (!Array.isArray(list)) throw new Error(ALLOW + ' must be an array');
	for (const a of list) {
		if (!a || typeof a.match !== 'string' || !a.match || typeof a.reason !== 'string' || !a.reason.trim()) {
			throw new Error(ALLOW + ': every entry needs a non-empty "match" and a "reason"');
		}
	}
	return list;
}

function classify(messages, marks, allow) {
	const out = { errors: [], warnings: [], ignored: 0, allowed: [], ignoredMessages: [] };
	for (const m of messages) {
		const hay = (m.sourceName || '') + '\n' + (m.message || '');
		const ours = marks.some(k => hay.includes(k));
		if (m.level === 'error') {
			if (!ours) {
				out.ignored++;
				if (out.ignoredMessages.length < 200) out.ignoredMessages.push(m);
				continue;
			}
			const a = allow.find(x => hay.includes(x.match));
			if (a) out.allowed.push(Object.assign({}, m, { reason: a.reason }));
			else out.errors.push(m);
		}
		else if (m.level === 'warning' && ours) {
			out.warnings.push(m);
		}
	}
	return out;
}

/** Where a message came from, with the temp-directory part of a jar: URI cut down. */
function source(m) {
	const src = (m.sourceName || '').replace(/^jar:file:\/\/\/.*\/([^/]+\.xpi)!/, 'jar:…/$1!');
	return src ? src + (m.line ? ':' + m.line : '') : '';
}

/** The text on one line. Newlines are shown escaped, as Fluent's own "\n | \r\n" is. */
function text(m) {
	return String(m.message).replace(/\r/g, '\\r').replace(/\n/g, '\\n').trim();
}

/**
 * Messages grouped by text, a group per line: one bad .ftl is a parser error
 * per message per locale per window -- 165 lines on the Zotero 11 beta, which
 * would bury the one line that says something else.
 */
function printGrouped(list, extra = () => '') {
	const groups = new Map();
	for (const m of list) {
		const key = m.level + ' ' + text(m);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(m);
	}
	for (const ms of groups.values()) {
		const srcs = [...new Set(ms.map(source).filter(Boolean))];
		console.log('    [' + ms[0].level + '] ' + (ms.length > 1 ? ms.length + 'x ' : '') + text(ms[0]) + extra(ms[0]));
		for (const s of srcs.slice(0, 3)) console.log('        @ ' + s);
		if (srcs.length > 3) console.log('        @ ... and ' + (srcs.length - 3) + ' more (see the report)');
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
	const timeoutMs = Number(opt('timeout', 600)) * 1000;
	const reportPath = path.resolve(opt('report', 'smoke-report.json'));
	const headed = flag('headed');

	const report = {
		ok: false,
		zotero: { path: null, version: null, gecko: null },
		xpi: null,
		cases: [],
		console: { errors: [], warnings: [], ignored: 0 },
		network: [],
	};

	let app = null;
	let m = null;
	let collected = false;
	let marks = [];
	let allow = [];

	const collect = async () => {
		if (collected || !m) return;
		const got = await Promise.race([m.run(chromeCollect), sleep(10000).then(() => null)]);
		if (!got) return;
		collected = true;
		const c = classify(got.console, marks, allow);
		report.console = {
			errors: c.errors, warnings: c.warnings, ignored: c.ignored,
			allowed: c.allowed, ignoredMessages: c.ignoredMessages,
		};
		report.network = attribute(got.network, marks);
		if (got.dropped) report.console.dropped = got.dropped;
		if (got.helperErrors.length) report.helperErrors = got.helperErrors;
	};

	let finishing = null;
	const finish = (why) => {
		if (finishing) return finishing;
		finishing = (async () => {
			if (why && !report.error) report.error = why;
			// What the console held by then is the most useful thing a failed
			// run can leave behind, so it is asked for even on the way out.
			try { await collect(); }
			catch (e) { /* the session is gone */ }
			if (m) await Promise.race([m.close().catch(() => {}), sleep(3000)]);
			if (app) {
				await launch.stopByProfile(app.child, app.profile);
				await launch.removeDir(app.profile);
				await launch.removeDir(app.dataDir);
			}
			report.ok = !report.error
				&& report.cases.length > 0 && report.cases.every(c => c.ok)
				&& report.console.errors.length === 0
				&& !report.network.some(r => r.ours);
			print(report, reportPath);
			fs.writeFileSync(reportPath, JSON.stringify(report, null, '\t') + '\n');
			process.exit(report.ok ? 0 : 1);
		})();
		return finishing;
	};
	process.on('SIGINT', () => finish('interrupted'));
	process.on('SIGTERM', () => finish('terminated'));
	const timer = setTimeout(() => finish('timed out after ' + timeoutMs / 1000 + ' s'), timeoutMs);
	timer.unref();

	try {
		allow = loadAllow();
		const xpi = resolveXpi();
		report.xpi = xpi;
		const manifest = JSON.parse(readZipEntry(fs.readFileSync(xpi), 'manifest.json').toString('utf8'));
		const id = manifest.applications.zotero.id;
		marks = markers(id, xpi);

		const binary = launch.findZotero(opt('zotero', process.env.ZOTERO_BIN));
		report.zotero.path = binary;

		const port = await launch.freePort();
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-smoke-data-'));
		const profile = launch.makeProfile([...launch.zoteroPrefs(dataDir), ...smokePrefs(port)], 'zg-smoke-');
		app = { child: null, profile, dataDir };
		const ext = path.join(profile, 'extensions');
		fs.mkdirSync(ext, { recursive: true });
		fs.copyFileSync(xpi, path.join(ext, id + '.xpi'));
		launch.installProxy(profile, HELPER);

		console.log('\nsmoke: ' + path.basename(xpi) + ' (' + manifest.version + ') in ' + binary);
		const args = ['-no-remote', '-profile', profile, '--marionette', '--remote-allow-system-access'];
		const env = { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' };
		if (!headed) {
			args.push('-headless');
			env.MOZ_HEADLESS = '1';
		}
		app.child = launch.spawnApp(binary, args, { env });
		let stderr = '';
		app.child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
		app.child.stdout.on('data', () => {});

		try {
			m = await connect(port, { timeoutMs: 180000, scriptTimeoutMs: 120000 });
		}
		catch (e) {
			throw new Error(e.message + (stderr.trim() ? '\n  Zotero said: ' + stderr.trim().split('\n').slice(-5).join('\n    ') : ''));
		}
		const info = await m.run(chromeWaitForZotero, 120000);
		Object.assign(report.zotero, { version: info.version, gecko: info.gecko });
		console.log('       Zotero ' + info.version + ', Gecko ' + info.gecko + ', ' + info.locale + ', Marionette on ' + port);

		const runCase = async (name, fn) => {
			// Past a timeout or a Ctrl+C the session is being torn down under
			// whatever is still running here; what it would report is noise.
			if (finishing) return false;
			const t0 = Date.now();
			const c = { name, ok: false, ms: 0 };
			try {
				const r = await fn();
				// What the graph page said once it had loaded: the first
				// thing to read when a pass looks too easy.
				if (r && typeof r.status === 'string') c.status = r.status;
				c.ok = true;
			}
			catch (e) {
				c.error = String(e.message || e).replace(/^WebDriver:ExecuteScript: [^:]+: /, '');
			}
			c.ms = Date.now() - t0;
			if (finishing) return false;
			report.cases.push(c);
			console.log('  ' + (c.ok ? 'ok  ' : 'FAIL') + '  ' + name + '  (' + (c.ms / 1000).toFixed(1) + ' s)'
				+ (typeof c.status === 'string' ? '  #status: ' + JSON.stringify(c.status.slice(0, 80)) : '')
				+ (c.error ? '\n          ' + c.error : ''));
			return c.ok;
		};

		const started = await runCase('plugin starts', () => m.run(chromeWaitForPlugin, 60000));
		if (started) {
			const fx = await m.run(chromeFixture, 'Smoke', PAPERS);
			const menu = (kind, select, fire = true) => m.run(chromeMenuCase, {
				kind, collectionID: fx.collectionID, select, fire, waitMs: TAB_WAIT_MS, l10nId: ENTRY_L10N_ID,
			});
			await runCase('collection menu, "Smoke" selected', () => menu('collection', null));
			await runCase('item menu, 1 item selected', () => menu('item', fx.itemIDs.slice(0, 1)));
			await runCase('item menu, 3 items selected', () => menu('item', fx.itemIDs));
			await runCase('disable and re-enable the add-on', async () => {
				await m.run(chromeDisableEnable, id, TAB_WAIT_MS);
				// Back means back in the menu too, not only on the Zotero object.
				await menu('collection', null, false);
			});
		}
		// Errors from a promise the last case left running land a moment late.
		await sleep(1500);
		await collect();
	}
	catch (e) {
		report.error = String(e.message || e);
	}
	await finish();
}

function print(report, reportPath) {
	const c = report.console;
	console.log('');
	if (report.error) console.log('  error: ' + report.error);
	if (c.errors.length) {
		console.log('  plugin errors in the console (' + c.errors.length + '):');
		printGrouped(c.errors);
	}
	if (c.warnings.length) {
		console.log('  plugin warnings in the console (' + c.warnings.length + ', not failing):');
		printGrouped(c.warnings);
	}
	if (c.allowed && c.allowed.length) {
		console.log('  allowed by tools/smoke/allow.json (' + c.allowed.length + '):');
		printGrouped(c.allowed, (m) => '  -- ' + m.reason);
	}
	const ours = report.network.filter(r => r.ours);
	const theirs = report.network.filter(r => !r.ours);
	if (ours.length) {
		console.log('  requests by the plugin that left the machine (' + ours.length + '):');
		for (const r of ours) {
			const why = [r.triggeringPrincipal, r.loadingPrincipal, ...(r.stack || [])]
				.find(w => w && /zotero-citation-graph/.test(w)) || '';
			console.log('    ' + r.method + ' ' + r.url + (why ? '\n        from ' + why : ''));
		}
	}
	if (theirs.length) {
		console.log('  requests by Zotero itself (' + theirs.length + ', not failing; switch them off in smokePrefs()):');
		for (const r of theirs) console.log('    ' + r.method + ' ' + r.url);
	}
	// Zotero's own errors that name the plugin by id or menu id are not the
	// plugin's files speaking, so they do not fail the run -- but they are
	// about it, and worth a look.
	const naming = (c.ignoredMessages || []).filter(m => /zotero-citation-graph/.test(m.message || ''));
	if (naming.length) {
		console.log('  Zotero\'s own errors naming the plugin (' + naming.length + ', not failing):');
		printGrouped(naming);
	}
	console.log('  Zotero\'s own errors, ignored: ' + c.ignored);
	console.log('\n' + (report.ok ? 'PASS' : 'FAIL') + '  report: ' + reportPath);
}

main().catch((e) => {
	console.error(e.stack || e);
	process.exit(1);
});
