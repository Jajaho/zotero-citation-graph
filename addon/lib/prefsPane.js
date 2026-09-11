/* global Zotero */

/**
 * The plugin's page in Zotero's Settings window.
 *
 * The markup is content/preferences.xhtml, a XUL fragment the Settings window
 * parses into its own document (core preferences.js _loadPane). Its handlers are
 * inline attributes that call back into this module through
 * Zotero.ZoteroCitationGraph.prefsPane: core turns `oncommand` into a listener
 * and dispatches `load` at the pane's root, and both run in the Settings
 * window's scope, where this plugin's modules are reachable only that way. No
 * `scripts` are registered -- a sandbox of our own would be a second copy of
 * everything this already has.
 *
 * Its static strings are Fluent, through the <linkset> in the fragment. The
 * status line is written from here with l10n.t(), since it carries a number
 * that this side formats.
 */

let l10n = require('./l10n.js');
let cacheStore = require('./cacheStore.js');

const STATUS_ID = 'zotero-citation-graph-cache-status';
const BUTTON_ID = 'zotero-citation-graph-clear-cache';

let _paneID = null;

/**
 * Put the pane in the Settings sidebar. Core takes it back out on its own when
 * the plugin shuts down (preferencePanes.js registers a Plugins observer for
 * exactly that), so unregister() is for symmetry and an early exit.
 */
async function register(config) {
	if (_paneID) return;
	_paneID = await Zotero.PreferencePanes.register({
		pluginID: config.pluginID,
		src: config.rootURI + 'content/preferences.xhtml',
		// Core's own default is the manifest's name, "Citation Graph for
		// Zotero" -- redundant inside Zotero, and never translated.
		label: l10n.t('prefs-title'),
	});
}

function unregister() {
	if (!_paneID) return;
	try {
		Zotero.PreferencePanes.unregister(_paneID);
	}
	catch (e) {
		Zotero.logError(e);
	}
	_paneID = null;
}

/** The pane's `load` handler: say how much there is to clear. */
async function load(root) {
	let doc = root.ownerDocument;
	let button = doc.getElementById(BUTTON_ID);
	// The same fallback as the menu entry's: if the window's Fluent did not
	// pick up the linkset, read the label straight out of the file we ship.
	if (button && !button.getAttribute('label')) {
		button.setAttribute('label', l10n.attr('prefs-clear-cache', 'label'));
	}
	await showSize(doc);
}

/** The button's `command` handler. */
async function clearCache(button) {
	let doc = button.ownerDocument;
	button.disabled = true;
	try {
		let freed = await cacheStore.clear();
		setStatus(doc, freed
			? l10n.t('prefs-cache-cleared', { size: formatBytes(freed) })
			: l10n.t('prefs-cache-empty'));
	}
	catch (e) {
		Zotero.logError(e);
		setStatus(doc, l10n.t('prefs-cache-failed', { message: e.message || String(e) }));
	}
	finally {
		button.disabled = false;
	}
}

async function showSize(doc) {
	let bytes = await cacheStore.size();
	setStatus(doc, bytes
		? l10n.t('prefs-cache-size', { size: formatBytes(bytes) })
		: l10n.t('prefs-cache-empty'));
}

function setStatus(doc, text) {
	let el = doc.getElementById(STATUS_ID);
	if (el) el.textContent = text;
}

/** 1.4 MB, 820 kB -- in the locale the strings are in, so "1,4 MB" in German. */
function formatBytes(bytes) {
	let [value, unit] = bytes >= 1e6 ? [bytes / 1e6, 'megabyte']
		: bytes >= 1e3 ? [bytes / 1e3, 'kilobyte']
		: [bytes, 'byte'];
	try {
		return new Intl.NumberFormat(l10n.contentBundle().locale, {
			style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1,
		}).format(value);
	}
	catch (e) {
		return Math.round(bytes / 1e3) + ' kB';
	}
}

module.exports = { register, unregister, load, clearCache, formatBytes };
