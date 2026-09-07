/**
 * Filter masks over the held items.
 *
 * A filter is one predicate over one item. Several of them stack by AND, so
 * every filter added narrows what is left and none can ever widen it -- the
 * "overlaying mask" model, where what you end up looking at is the intersection
 * of every mask you laid down.
 *
 * Separate from graph.js for the same reason nodeScale.js and nodeLinks.js are:
 * this is pure. Parsing "year:>2010" into a range, and ranking the values worth
 * offering as completions, are exactly the kind of thing that is tedious to
 * check by clicking around a graph and trivial to check in a test.
 *
 * Loaded as a plain <script> and published as a global; the content page has no
 * module loader. tools/test-cjs-shim.js evaluates this same file.
 */
(function (global) {
	'use strict';

	/**
	 * The facets an item can be masked on, in the order they are offered as
	 * completions. `author` leads because it is the one people reach for.
	 *
	 * Only held items have any of this. An outside reference is a DOI and, with
	 * lookup on, a title -- so they are not masked directly; they survive on
	 * whether a held item that survived still cites them. See render() in
	 * graph.js.
	 */
	var FIELDS = [
		{ name: 'author', label: 'author' },
		{ name: 'year', label: 'year' },
		{ name: 'type', label: 'item type' },
		{ name: 'publication', label: 'publication' },
		{ name: 'collection', label: 'collection' },
		{ name: 'title', label: 'title' },
	];

	var NAMES = FIELDS.map(function (f) { return f.name; });

	/**
	 * An item flattened to the values each facet can match on. Every facet is a
	 * list, because two of them genuinely are: an item has several authors and
	 * can sit in several collections, and matching only the first would make
	 * "author:Kucsko" miss every paper he is second on.
	 */
	function facets(item) {
		item = item || {};
		return {
			author: item.creators || [],
			year: item.year == null ? [] : [String(item.year)],
			type: item.itemType ? [item.itemType] : [],
			publication: item.publication ? [item.publication] : [],
			collection: item.collections || [],
			title: item.title ? [item.title] : [],
		};
	}

	// --- parsing ----------------------------------------------------------

	/**
	 * Year accepts comparisons and ranges, because "papers since 2015" is a
	 * question people actually ask, and stacking eleven year filters to ask it
	 * would be absurd. Every other facet is a string and gets no operators.
	 *
	 * Returns { lo, hi }, inclusive, either end null for an open one, or null
	 * when the term is not a year expression at all -- the caller then falls
	 * back to matching the year as text. That fallback is why a year here is
	 * four digits exactly: it leaves "year:201" free to mean the 2010s.
	 */
	function parseYear(term) {
		var m;
		if ((m = term.match(/^(\d{4})\s*(?:-|–|\.\.)\s*(\d{4})$/))) {
			var a = Number(m[1]);
			var b = Number(m[2]);
			return { lo: Math.min(a, b), hi: Math.max(a, b) };
		}
		if ((m = term.match(/^(?:>=|=>|≥)\s*(\d{4})$/))) return { lo: Number(m[1]), hi: null };
		if ((m = term.match(/^(?:<=|=<|≤)\s*(\d{4})$/))) return { lo: null, hi: Number(m[1]) };
		if ((m = term.match(/^>\s*(\d{4})$/))) return { lo: Number(m[1]) + 1, hi: null };
		if ((m = term.match(/^<\s*(\d{4})$/))) return { lo: null, hi: Number(m[1]) - 1 };
		if ((m = term.match(/^=?\s*(\d{4})$/))) return { lo: Number(m[1]), hi: Number(m[1]) };
		return null;
	}

	/**
	 * Split "author:soc" into its halves. An unrecognised prefix is not a field
	 * and not an error either -- "10.1038:x" is a string someone is looking for,
	 * so the whole of it stays the search term.
	 */
	function split(text) {
		var s = String(text == null ? '' : text);
		var i = s.indexOf(':');
		if (i < 0) return { field: null, term: s.trim() };
		var name = s.slice(0, i).trim().toLowerCase();
		if (NAMES.indexOf(name) < 0) return { field: null, term: s.trim() };
		return { field: name, term: s.slice(i + 1).trim() };
	}

	/**
	 * Text the user typed -> a filter, or null when there is nothing to filter
	 * on. Typed text always matches as a substring: someone who types "soc"
	 * means Socrates, and making them spell the surname out exactly would
	 * defeat the point of typing at all. Picking a value off the completion
	 * list pins it in full instead -- see exact().
	 */
	function parse(text) {
		var p = split(text);
		if (!p.term) return null;
		if (p.field === 'year') {
			var r = parseYear(p.term);
			if (r) return { field: 'year', op: 'range', lo: r.lo, hi: r.hi, value: p.term };
		}
		return { field: p.field, op: 'contains', value: p.term };
	}

	/** A filter pinned to one value in full, which is what a completion means. */
	function exact(field, value) {
		return { field: field, op: 'is', value: String(value) };
	}

	// --- matching ---------------------------------------------------------

	function hit(values, op, needle) {
		for (var i = 0; i < values.length; i++) {
			var s = String(values[i]).toLowerCase();
			if (op === 'is' ? s === needle : s.indexOf(needle) >= 0) return true;
		}
		return false;
	}

	function matches(filter, fac) {
		if (!filter) return true;
		if (filter.op === 'range') {
			var ys = fac.year || [];
			for (var i = 0; i < ys.length; i++) {
				var y = Number(ys[i]);
				if (filter.lo != null && y < filter.lo) continue;
				if (filter.hi != null && y > filter.hi) continue;
				return true;
			}
			return false;
		}
		var needle = String(filter.value).toLowerCase();
		if (filter.field) return hit(fac[filter.field] || [], filter.op, needle);
		// A bare term is asked of every facet at once. That is what lets
		// "Tales" work without the user having to know which field it lives in.
		for (var j = 0; j < NAMES.length; j++) {
			if (hit(fac[NAMES[j]] || [], filter.op, needle)) return true;
		}
		return false;
	}

	function matchesAll(filters, fac) {
		for (var i = 0; i < filters.length; i++) if (!matches(filters[i], fac)) return false;
		return true;
	}

	/** Identity, so the same mask cannot be laid down twice. */
	function key(f) {
		if (f.op === 'range') return 'year|range|' + f.lo + '|' + f.hi;
		return (f.field || '*') + '|' + f.op + '|' + String(f.value).toLowerCase();
	}

	/** The chip's text. Short, because it sits in a 220px panel. */
	function describe(f) {
		if (f.op === 'range') {
			if (f.lo != null && f.hi != null) {
				return f.lo === f.hi ? 'year: ' + f.lo : 'year: ' + f.lo + '–' + f.hi;
			}
			return f.lo != null ? 'year: ≥' + f.lo : 'year: ≤' + f.hi;
		}
		// ':' for a pinned value and '~' for a substring. The two behave
		// differently often enough that the chip has to say which it is.
		var head = f.field || 'any';
		return head + (f.op === 'is' ? ': ' : ' ~ ') + f.value;
	}

	// --- completions ------------------------------------------------------

	/**
	 * What to offer for the half-typed text, given the items that survive the
	 * masks already laid down.
	 *
	 * Drawing from the SURVIVORS rather than from the whole collection is the
	 * point: a value on this list always leaves something on screen, so
	 * stacking masks walks down a narrowing tree instead of dead-ending on a
	 * combination that matches nothing.
	 *
	 * @param {string} text        what is in the box
	 * @param {Object[]} entries   facets() of each surviving item
	 * @param {number} [limit]
	 * @returns {Object[]} { kind, label, hint, count?, filter?, insert? }
	 */
	function suggest(text, entries, limit) {
		limit = limit || 12;
		var p = split(text);
		var term = p.term.toLowerCase();
		var out = [];

		// A field name still being typed. Only while nothing is committed to a
		// field yet, and only while the term still looks like one -- past that
		// the user is plainly after a value.
		if (!p.field) {
			for (var i = 0; i < FIELDS.length; i++) {
				var f = FIELDS[i];
				if (term && f.name.indexOf(term) !== 0) continue;
				out.push({
					kind: 'field',
					label: f.name + ':',
					hint: 'filter by ' + f.label,
					insert: f.name + ':',
				});
			}
		}

		// Year comparisons cannot be enumerated, so a parsed range is offered as
		// its own entry rather than as one of the values below.
		if (p.field === 'year' && p.term) {
			var r = parseYear(p.term);
			if (r && !(r.lo != null && r.lo === r.hi)) {
				var range = { field: 'year', op: 'range', lo: r.lo, hi: r.hi, value: p.term };
				out.push({
					kind: 'range',
					label: describe(range),
					hint: 'a span of years',
					filter: range,
				});
			}
		}

		// Values, commonest first: the ones covering most of the graph are the
		// ones worth reaching for.
		var fields = p.field ? [p.field] : NAMES;
		var counts = new Map();
		for (var e = 0; e < entries.length; e++) {
			// Per item, not per occurrence: an item counts once towards a value
			// however many of its creators happen to share a surname.
			var seen = new Set();
			for (var k = 0; k < fields.length; k++) {
				var name = fields[k];
				var values = entries[e][name] || [];
				for (var v = 0; v < values.length; v++) {
					var value = String(values[v]);
					if (!value) continue;
					if (term && value.toLowerCase().indexOf(term) < 0) continue;
					var id = name + ' ' + value;
					if (seen.has(id)) continue;
					seen.add(id);
					var rec = counts.get(id);
					if (rec) rec.count++;
					else counts.set(id, { field: name, value: value, count: 1 });
				}
			}
		}
		var ranked = [];
		counts.forEach(function (rec) { ranked.push(rec); });
		// Titles are unique per item, so every one of them counts 1 and a
		// hundred of them would crowd out the facets that actually group
		// things. They stay reachable through "title:" and the free-text entry.
		if (!p.field) ranked = ranked.filter(function (x) { return x.field !== 'title'; });
		ranked.sort(function (a, b) {
			return b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
		});
		for (var s = 0; s < ranked.length && out.length < limit; s++) {
			out.push({
				kind: 'value',
				label: ranked[s].value,
				hint: ranked[s].field,
				count: ranked[s].count,
				filter: exact(ranked[s].field, ranked[s].value),
			});
		}

		// The escape hatch: whatever was typed, as a substring. Last, and
		// dropped when a value already on the list says the same thing.
		var free = parse(text);
		if (free && free.op !== 'range') {
			var dup = out.some(function (o) {
				return o.filter && String(o.filter.value).toLowerCase()
					=== String(free.value).toLowerCase();
			});
			if (!dup) {
				out.push({
					kind: 'free',
					label: describe(free),
					hint: 'anything containing this',
					filter: free,
				});
			}
		}

		return out.slice(0, limit);
	}

	global.ZGFilters = {
		FIELDS: FIELDS,
		facets: facets,
		parse: parse,
		exact: exact,
		parseYear: parseYear,
		matches: matches,
		matchesAll: matchesAll,
		describe: describe,
		key: key,
		suggest: suggest,
	};
}(typeof window !== 'undefined' ? window : globalThis));
