/* eslint-env browser */
/* global Zotero, Services, Components, Cc, Ci, Cu, IOUtils, PathUtils, ChromeWorker, fetch */

/**
 * Zotero Citation Graph -- plugin entry point.
 *
 * Zotero loads this file into a system-principal sandbox and calls each lifecycle
 * method as fn({ id, version, rootURI, ... }, reason). See Zotero core
 * chrome/content/zotero/xpcom/plugins.js (_callMethod).
 *
 * There is no `require` in that sandbox, so lib/cjs.js provides a small CommonJS
 * loader rooted at rootURI. That is what lets citation-graph/ -- which is plain
 * CommonJS with zero Node-only dependencies -- load unmodified, with no build step.
 */

var rootURI;
var resProto;
var CG; // the plugin's main module

const RES_ROOT = 'zotero-graph';
const PLUGIN_ID = 'zotero-graph@jajaho.dev';

function log(msg) {
	Zotero.debug('[zotero-graph] ' + msg);
}

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI: uri }) {
	rootURI = uri; // always ends with '/'
	log('startup ' + version + ' rootURI=' + rootURI);

	// Serve the plugin over resource://zotero-graph/. Core loads its own content
	// pages the same way (resource://zotero/reader/reader.html), and this behaves
	// identically for an unpacked directory and a packed XPI.
	resProto = Services.io.getProtocolHandler('resource')
		.QueryInterface(Ci.nsIResProtocolHandler);
	resProto.setSubstitution(RES_ROOT, Services.io.newURI(rootURI));

	// Bootstrap the CommonJS loader, then load the plugin proper through it.
	let shim = {};
	Services.scriptloader.loadSubScriptWithOptions(rootURI + 'lib/cjs.js', {
		target: shim, charset: 'utf-8', ignoreCache: true
	});
	let require = shim.makeRequire(rootURI, {
		Zotero, Services, Components, Cc, Ci, Cu,
		IOUtils, PathUtils, ChromeWorker, fetch,
		TextDecoder, TextEncoder, URL, URLSearchParams,
		setTimeout, clearTimeout,
		console: { log: log, warn: log, error: log },
		__rootURI: rootURI,
		__resRoot: RES_ROOT,
		__pluginID: PLUGIN_ID,
	});

	CG = require('./lib/main.js');
	Zotero.ZoteroGraph = CG;
	await CG.startup({ id, version, rootURI, pluginID: PLUGIN_ID, resRoot: RES_ROOT });

	// Windows already open when the plugin is enabled at runtime don't get
	// onMainWindowLoad, so handle them here.
	for (let win of Zotero.getMainWindows()) {
		if (win.ZoteroPane) CG.onMainWindowLoad(win);
	}
}

function onMainWindowLoad({ window }) {
	try {
		CG && CG.onMainWindowLoad(window);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function onMainWindowUnload({ window }) {
	try {
		CG && CG.onMainWindowUnload(window);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

async function shutdown() {
	log('shutdown');
	try {
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) CG && CG.onMainWindowUnload(win);
		}
		CG && await CG.shutdown();
	}
	catch (e) {
		Zotero.logError(e);
	}
	delete Zotero.ZoteroGraph;
	CG = null;
	if (resProto) {
		resProto.setSubstitution(RES_ROOT, null);
		resProto = null;
	}
}
