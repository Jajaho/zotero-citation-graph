/**
 * Where a node points on the web.
 *
 * Separate from graph.js for the same reason nodeScale.js is: it is pure, and
 * the strings it has to cope with arrive from three unrelated places -- a DOI
 * field a user typed into Zotero by hand, a DOI harvested out of raw PDF bytes,
 * an identifier an enricher returned. Only some of those are bare.
 *
 * Loaded as a plain <script> and published as a global; the content page has no
 * module loader. tools/test-cjs-shim.js evaluates this same file, and asserts
 * that normDoi() here still agrees with the core one it was copied from.
 */
(function (global) {
	'use strict';

	/**
	 * Bare, lower-cased DOI, or null.
	 *
	 * Deliberately character-for-character the same rule as
	 * citation-graph/core/normalize.js normDoi(). That tree is CommonJS and this
	 * page has no loader, so it cannot be required -- the duplication is the
	 * price, and the test is what keeps the two from drifting.
	 */
	function normDoi(raw) {
		if (!raw) return null;
		var d = String(raw).trim().toLowerCase()
			.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
			.replace(/^doi:\s*/, '')
			.replace(/[.,;:)\]]+$/, '');
		return /^10\.\d{4,9}\//.test(d) ? d : null;
	}

	/**
	 * A DOI is a path, so '/' and ':' have to survive -- which encodeURI leaves
	 * alone. What it also leaves alone and must not: '#' would truncate the URL
	 * at a fragment and '?' would start a query string, and both occur inside
	 * real DOIs.
	 */
	function encodeDoi(doi) {
		return encodeURI(doi).replace(/#/g, '%23').replace(/\?/g, '%3F');
	}

	function doiUrl(raw) {
		var d = normDoi(raw);
		return d ? 'https://doi.org/' + encodeDoi(d) : null;
	}

	/**
	 * Where an outside reference lives, from the two halves of its namespaced
	 * key (see citation-graph/core/types.js). An unknown namespace returns null
	 * rather than a guess: the menu disables the entry, which is honest, where
	 * an invented URL would open a 404 in the user's browser.
	 */
	function externalUrl(ns, id) {
		if (!id) return null;
		switch (ns) {
			case 'doi': return doiUrl(id);
			case 'arxiv': return 'https://arxiv.org/abs/' + encodeURIComponent(id);
			case 'openalex': return 'https://openalex.org/' + encodeURIComponent(id);
			default: return null;
		}
	}

	/**
	 * Where a held item lives. The URL field first, because that is what the
	 * item's own metadata claims; the DOI only as a fallback, because plenty of
	 * items carry one and no URL.
	 *
	 * http(s) only. The field is free text and routinely holds a local path or a
	 * `zotero://` link, and this URL ends up at the OS browser launcher.
	 */
	function itemUrl(item) {
		var u = item && item.url ? String(item.url).trim() : '';
		if (/^https?:\/\//i.test(u)) return u;
		return doiUrl(item && item.doi);
	}

	global.ZGLinks = {
		normDoi: normDoi,
		doiUrl: doiUrl,
		externalUrl: externalUrl,
		itemUrl: itemUrl,
	};
}(typeof window !== 'undefined' ? window : globalThis));
