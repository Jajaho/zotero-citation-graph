/* global Zotero, Services */

/**
 * Strings, chrome side.
 *
 * Zotero already registers addon/locale/<locale>/*.ftl into a global
 * L10nRegistry source (plugins.js registerLocales), which is what resolves the
 * collection menu's label through the main window's bundle. That path is
 * untouched. This module is for the strings chrome produces in JS -- build
 * phases on the status line, the tab title, the reader pane's buttons -- and for
 * handing the graph page the source it formats from.
 *
 * It reads the .ftl itself rather than going through Localization, so that both
 * sides of the bridge run the same reader over the same text: a string that
 * renders one way in the panel and another way on the status line would be a
 * bug nobody would think to look for. content/ftl.js documents the subset.
 *
 * Loaded once, at startup, before any tab can exist -- so everything below is
 * synchronous at its call sites.
 */

let Ftl = require('../content/ftl.js');

const FILE = 'zotero-graph.ftl';
const PREFIX = 'zotero-graph-';
const FALLBACK = 'en-US';

/**
 * The locales this plugin ships, one directory each under addon/locale/.
 *
 * Listed rather than discovered: enumerating a directory inside a packed XPI
 * means an nsIZipReader and a jar: URI, which is a lot of machinery to learn a
 * fact that changes when someone adds a translation. `npm test` checks this list
 * against what is actually on disk, so the two cannot drift.
 */
const LOCALES = ['en-US', 'de-DE'];

let _bundle = null;
let _source = null;
let _locale = FALLBACK;

/**
 * Which of LOCALES to use for Zotero's current locale.
 *
 * Zotero's own plugin loader resolves this per file with
 * Utilities.Internal.resolveLocale (exact -> same language -> en-US), and this
 * asks the same function so a plugin string and a core string can never end up
 * in different languages. The manual pass is for the case where that helper has
 * moved: a German Zotero showing English is a poor result, but a startup that
 * throws over it would be a much worse one.
 */
function pick() {
	let wanted = [];
	try {
		if (Zotero.locale) wanted.push(Zotero.locale);
	}
	catch (e) { /* fall through to Services */ }
	try {
		for (let l of Services.locale.appLocalesAsBCP47) wanted.push(l);
	}
	catch (e) { /* nothing else to ask */ }

	for (let want of wanted) {
		try {
			let got = Zotero.Utilities.Internal.resolveLocale(want, LOCALES, { silent: true });
			if (got) return got;
		}
		catch (e) { /* resolve by hand below */ }
		if (LOCALES.includes(want)) return want;
		let lang = String(want).split('-')[0].toLowerCase();
		let same = LOCALES.find(l => l.split('-')[0].toLowerCase() === lang);
		if (same) return same;
	}
	return FALLBACK;
}

/**
 * Read the .ftl for the resolved locale. A locale whose file will not read
 * falls back to en-US rather than leaving the plugin with no strings at all --
 * which, since a missing id renders as the id, would otherwise put message
 * names on the status line.
 */
async function load(rootURI) {
	let chosen = pick();
	for (let locale of chosen === FALLBACK ? [FALLBACK] : [chosen, FALLBACK]) {
		try {
			let source = await Zotero.File.getResourceAsync(rootURI + 'locale/' + locale + '/' + FILE);
			_locale = locale;
			_source = source;
			_bundle = Ftl.bundle(source, locale, PREFIX);
			return;
		}
		catch (e) {
			Zotero.logError(new Error(`[zotero-graph] could not read ${locale}/${FILE}: ${e}`));
		}
	}
	// Everything below still answers; t() gives back ids, which is visible and
	// says exactly what failed.
	_bundle = Ftl.bundle('', FALLBACK, PREFIX);
}

/** One string. `args` fills variables and picks plural variants. */
function t(id, args) {
	if (!_bundle) return id;
	return _bundle.t(id, args);
}

/** A message's attribute -- `.label` on the menu entry, and nothing else so
 *  far. Attributes are flattened to "id.attribute"; see content/ftl.js. */
function attr(id, name, args) {
	return t(id + '.' + name, args);
}

/**
 * What the graph page needs to format its own strings: the source text, and the
 * locale it was chosen for, which is what Intl.PluralRules is asked about there.
 */
function contentBundle() {
	return { locale: _locale, source: _source || '' };
}

module.exports = { load, t, attr, contentBundle, LOCALES, PREFIX };
