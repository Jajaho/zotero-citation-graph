/* global ZGFtl */

/**
 * The graph page's strings.
 *
 * Chrome sends the .ftl source for the locale Zotero resolved -- one more JSON
 * string over the same bridge as everything else -- and this parses it once and
 * answers synchronously from then on. See content/ftl.js for why the page does
 * not simply use document.l10n.
 *
 * Until that arrives, t() gives back the id it was asked for and the static
 * markup keeps the English written into graph.html. Chrome pushes the strings
 * before it pushes any data, so in practice the window between the two is a
 * frame or two of a page that says "Loading…" -- but it is deliberately a
 * window in which the page still works rather than one in which it is blank.
 *
 * Static markup is localised from attributes rather than from a table in here:
 *
 *     data-zg-str          the element's text
 *     data-zg-title        its title attribute
 *     data-zg-placeholder  its placeholder
 *     data-zg-aria-label   its aria-label
 *
 * which keeps the id next to the thing it names, and lets an element carry a
 * tooltip id without its children having to be rebuilt to reach the text.
 */
(function (global) {
	'use strict';

	var PREFIX = 'zotero-graph-';

	var bundle = null;
	var listeners = [];

	var ATTRS = [
		['data-zg-title', 'title'],
		['data-zg-placeholder', 'placeholder'],
		['data-zg-aria-label', 'aria-label'],
	];

	/**
	 * One string. `args` fills the pattern's variables and picks its plural
	 * variant; see content/ftl.js for the subset supported.
	 */
	function t(id, args) {
		if (!bundle) return id;
		return bundle.t(id, args);
	}

	/** Whether the strings have landed. Callers that paint on arrival use
	 *  onReady() instead; this is for the ones that only need to know. */
	function loaded() {
		return !!bundle;
	}

	function locale() {
		return bundle ? bundle.locale : null;
	}

	/**
	 * Run `fn` when the strings arrive, or now if they already have.
	 *
	 * Most of the page needs nothing here: menus, tooltips and chips are built
	 * on demand and ask for their strings as they are built. This is for what is
	 * already painted by then -- the legend, the counts, the toggle tooltips.
	 */
	function onReady(fn) {
		if (bundle) fn();
		else listeners.push(fn);
	}

	function applyStatic(root) {
		if (!bundle) return;
		var nodes = root.querySelectorAll('[data-zg-str]');
		for (var i = 0; i < nodes.length; i++) {
			nodes[i].textContent = t(nodes[i].getAttribute('data-zg-str'));
		}
		for (var a = 0; a < ATTRS.length; a++) {
			var from = ATTRS[a][0];
			var to = ATTRS[a][1];
			var els = root.querySelectorAll('[' + from + ']');
			for (var j = 0; j < els.length; j++) {
				els[j].setAttribute(to, t(els[j].getAttribute(from)));
			}
		}
	}

	// chrome -> content, the same shape as zgSetData: a JSON string, so nothing
	// has to cross the privilege boundary but a primitive.
	global.zgSetStrings = function (json) {
		var data;
		try {
			data = JSON.parse(json);
		}
		catch (e) {
			return;
		}
		bundle = ZGFtl.bundle(data.source, data.locale, PREFIX);
		applyStatic(global.document);
		var fns = listeners;
		listeners = [];
		for (var i = 0; i < fns.length; i++) {
			try {
				fns[i]();
			}
			catch (e) {
				// A listener that throws must not stop the rest of the page
				// from picking up its strings.
				if (global.console) global.console.error(e);
			}
		}
	};

	global.ZGL10n = {
		t: t,
		loaded: loaded,
		locale: locale,
		onReady: onReady,
		applyStatic: applyStatic,
	};
}(typeof window !== 'undefined' ? window : globalThis));
