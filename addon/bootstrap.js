/* eslint-env browser */
/* global Zotero, Services, Components, Cc, Ci, Cu, IOUtils, PathUtils, ChromeWorker, fetch */

/**
 * Zotero Citation Graph -- plugin entry point.
 *
 * Copyright (C) 2026 Jakob Holz
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. It is distributed WITHOUT ANY WARRANTY; without even the
 * implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
 * the GNU Affero General Public License in LICENSE for more details.
 *
 * Third-party material bundled with this plugin, and the notices its licences
 * require, are listed in THIRD-PARTY-NOTICES.md beside this file.
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
var startupReason;

const RES_ROOT = 'zotero-graph';
const PLUGIN_ID = 'zotero-graph@jajaho.dev';

function log(msg) {
	Zotero.debug('[zotero-graph] ' + msg);
}

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI: uri }, reason) {
	rootURI = uri; // always ends with '/'
	log('startup ' + version + ' rootURI=' + rootURI);
	startupReason = reason;

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

	// trace first, and on its own: it has no dependencies, so requiring it
	// costs one file read, and starting its clock here is what makes the
	// elapsed column measure this plugin's whole contribution to restore
	// latency -- module loading included.
	let trace = require('./lib/trace.js');
	trace.start();
	trace.log('--- startup v' + version + ' reason=' + startupReason);

	CG = require('./lib/main.js');
	Zotero.ZoteroGraph = CG;
	trace.log('modules loaded');
	await CG.startup({ id, version, rootURI, pluginID: PLUGIN_ID, resRoot: RES_ROOT });
	trace.log('startup returned');

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

async function shutdown(params, reason) {
	log('shutdown');
	try {
		// No per-window unload loop of its own: which teardown each window wants
		// depends on the reason, and main.js owns that decision -- a window
		// forgotten here would be a graph tab that never reaches session.json.
		CG && await CG.shutdown(reason);
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
