/* global Zotero, Services, Cc, Ci, ChromeUtils */
'use strict';

/**
 * Runs the rendering benchmark inside Zotero and posts the results to run.js.
 *
 * Only ever installed by `run.js --app zotero`, into a throwaway profile with a
 * throwaway data directory, next to the plugin under test. It is never part of
 * the plugin and never installed in a real profile.
 *
 * Zotero rather than Firefox because Zotero is what users run: its own Gecko
 * (an ESR, older than release Firefox), its own graphics prefs, its own window.
 * Firefox gives fair comparisons. Zotero gives the figures a user would see.
 *
 * An add-on rather than Marionette because Marionette cannot open a session in
 * Zotero: it waits for browser-idle-startup-tasks-finished, and Zotero never
 * sends it.
 *
 * The page goes where the plugin puts its graph: a <browser type="content">
 * in a tab of the main window (lib/graphTab.js mount()). Not a window of its
 * own: Zotero 10 opens a top-level resource:// window and leaves it on
 * about:blank. And a tab is the place a user's graph is drawn in anyway, so the
 * canvas is composited exactly as theirs is.
 *
 * run.js passes these prefs in user.js:
 *   extensions.zgbench.page    the benchmark URL (resource://, with its query)
 *   extensions.zgbench.sink    http://127.0.0.1:<port>, where serve.js listens
 *   extensions.zgbench.width   main window size, so the graph has room
 *   extensions.zgbench.height
 */

const { setInterval, clearInterval, setTimeout: setTimeoutOnce } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');

const POLL_MS = 1000;
let timer = null;

const log = (msg) => Zotero.debug('[zg-bench-runner] ' + msg);

function post(sink, path, obj) {
	return Zotero.HTTP.request('POST', sink + path, {
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(obj),
		successCodes: false,
	}).catch((e) => Zotero.logError(e));
}

/**
 * Returns at once and runs in the background. Zotero starts add-ons one after
 * another and waits for each startup() to settle, so a startup() that waited
 * for the run would hold back the plugin under test -- whose resource:// root
 * the run is waiting for. Each would wait for the other until the timeout.
 */
function startup(data) {
	run(data).catch((e) => {
		log('failed: ' + e);
		const sink = Services.prefs.getStringPref('extensions.zgbench.sink', '');
		if (sink) post(sink, '/results', { errors: ['fatal: runner: ' + e] });
	});
}

async function run({ rootURI }) {
	await Zotero.initializationPromise;
	await Zotero.uiReadyPromise;

	const page = Services.prefs.getStringPref('extensions.zgbench.page', '');
	const sink = Services.prefs.getStringPref('extensions.zgbench.sink', '');
	if (!page || !sink) return;

	const scope = { Services, Cc, Ci };
	let gfx;
	try {
		Services.scriptloader.loadSubScript(rootURI + 'gfx-probe.js', scope);
		gfx = scope.zgGfxProbe();
	}
	catch (e) {
		gfx = { error: String(e) };
	}
	log('renderer: ' + (gfx.summary || gfx.error));
	await post(sink, '/gfx', gfx);

	// The page lives under the plugin's resource:// root, which the plugin
	// registers in its own startup -- and add-ons start in no promised order.
	// A <browser> pointed at a root nobody has registered yet stays on
	// about:blank and says nothing, so wait for the root first.
	const host = new URL(page).host;
	const res = Services.io.getProtocolHandler('resource').QueryInterface(Ci.nsIResProtocolHandler);
	for (let i = 0; i < 120 && !res.hasSubstitution(host); i++) {
		await new Promise((r) => setTimeoutOnce(r, 500));
	}
	if (!res.hasSubstitution(host)) {
		post(sink, '/results', { errors: ['fatal: the plugin never registered resource://' + host + '/'] });
		return;
	}

	let browser;
	try {
		const win = Zotero.getMainWindow();
		win.resizeTo(Services.prefs.getIntPref('extensions.zgbench.width', 1600),
			Services.prefs.getIntPref('extensions.zgbench.height', 1100));
		const { container } = win.Zotero_Tabs.add({
			type: 'zg-bench', title: 'Rendering benchmark', select: true, data: {},
		});
		browser = win.document.createXULElement('browser');
		browser.setAttribute('type', 'content');
		browser.setAttribute('flex', '1');
		browser.setAttribute('src', page);
		container.appendChild(browser);
	}
	catch (e) {
		log('could not open the benchmark: ' + e);
		post(sink, '/results', { errors: ['fatal: could not open the benchmark: ' + e] });
		return;
	}
	log('opened ' + page);

	// bench.js with report=window keeps the run in `results` and sets the
	// title. The page is not chrome, so its globals are behind an Xray.
	let sent = false;
	let ticks = 0;
	timer = setInterval(() => {
		if (sent) return;
		const doc = browser.contentDocument;
		const title = doc ? doc.title : '';
		if (++ticks % 60 === 0) {
			log('waiting; page title: ' + title + ' @ ' + (doc ? doc.location.href.split('?')[0] : 'no document'));
		}
		if (title !== 'benchmark done') return;
		sent = true;
		log('done, posting results');
		let run;
		try {
			const w = browser.contentWindow;
			run = JSON.parse(JSON.stringify(w.wrappedJSObject ? w.wrappedJSObject.results : w.results));
		}
		catch (e) {
			run = { errors: ['fatal: could not read the results: ' + e] };
		}
		post(sink, '/results', run || { errors: ['fatal: the page finished with no results'] });
	}, POLL_MS);
}

function shutdown() {
	if (timer) clearInterval(timer);
	timer = null;
}

function install() {}
function uninstall() {}
