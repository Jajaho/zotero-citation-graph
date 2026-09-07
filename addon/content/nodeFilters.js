/**
 * Filter masks over the held items.
 *
 * A filter is one field and a list of terms. Terms inside a filter OR; filters
 * AND. That pairing is the whole grammar:
 *
 *     publication: Nature, Nature Reviews, APL     one mask, three ways to pass
 *     + author: Kucsko                             a second mask over the first
 *
 * Widening happens inside a chip and narrowing happens between them, so every
 * chip added narrows what is left and none can widen it -- the "overlaying
 * mask" model, where what you end up looking at is the intersection of every
 * mask you laid down.
 *
 * Separate from graph.js for the same reason nodeScale.js and nodeLinks.js are:
 * this is pure. Parsing "year:>2010" into a range, splitting a quoted list on
 * its top-level commas, and ranking the values worth offering as completions
 * are exactly the kind of thing that is tedious to check by clicking around a
 * graph and trivial to check in a test.
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
	 * question people actually ask, and listing eleven years to ask it would be
	 * absurd. Every other facet is a string and gets no operators.
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
	 * Split a term list on its commas, leaving anything inside quotes alone --
	 * "Ann. Phys., Lpz." is one journal, not two. Quotes are kept in the pieces
	 * for parseTerm() to read, because whether a value was quoted is what says
	 * how it matches.
	 */
	function splitTerms(s) {
		var out = [];
		var cur = '';
		var quoted = false;
		for (var i = 0; i < s.length; i++) {
			var c = s.charAt(i);
			if (c === '"') {
				// A doubled quote inside a quoted value is one literal quote,
				// the way it is everywhere else that quotes a comma-separated
				// list. It stays doubled here and is folded in parseTerm().
				if (quoted && s.charAt(i + 1) === '"') {
					cur += '""';
					i++;
					continue;
				}
				quoted = !quoted;
				cur += c;
				continue;
			}
			if (c === ',' && !quoted) {
				out.push(cur);
				cur = '';
				continue;
			}
			cur += c;
		}
		out.push(cur);
		return out;
	}

	/**
	 * Split "publication: Nature, Science" into its field and its raw terms. An
	 * unrecognised prefix is not a field and not an error either -- "10.1038:x"
	 * is a string someone is looking for, so the whole of it stays the term.
	 */
	function split(text) {
		var s = String(text == null ? '' : text);
		var i = s.indexOf(':');
		if (i >= 0) {
			var name = s.slice(0, i).trim().toLowerCase();
			if (NAMES.indexOf(name) >= 0) return { field: name, raw: splitTerms(s.slice(i + 1)) };
		}
		return { field: null, raw: splitTerms(s) };
	}

	/**
	 * One term of a list.
	 *
	 * A bare value is a substring: someone who types "soc" means Socrates, and
	 * making them spell the surname out would defeat the point of typing at
	 * all. A quoted value is pinned to exactly that string, which is what
	 * picking a value off the completion list writes -- otherwise `type:
	 * "book"` would drag in every bookSection. A leading `~` forces the
	 * substring reading back on, so a substring containing a comma can still be
	 * quoted against splitTerms().
	 */
	function parseTerm(field, raw) {
		var t = String(raw).trim();
		var loose = false;
		if (t.charAt(0) === '~') {
			loose = true;
			t = t.slice(1).trim();
		}
		var quoted = t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"';
		if (quoted) t = t.slice(1, -1).replace(/""/g, '"');
		if (!t) return null;
		if (quoted && !loose) return { op: 'is', value: t };
		if (field === 'year' && !quoted) {
			var r = parseYear(t);
			if (r) return { op: 'range', lo: r.lo, hi: r.hi };
		}
		return { op: 'contains', value: t };
	}

	/** Text in the box -> a filter, or null when there is nothing to mask on. */
	function parse(text) {
		var p = split(text);
		var terms = [];
		for (var i = 0; i < p.raw.length; i++) {
			var t = parseTerm(p.field, p.raw[i]);
			// Duplicates inside one mask do nothing, and a trailing comma --
			// which is exactly what the box holds mid-edit -- is not a term.
			if (t && !terms.some(function (x) { return termKey(x) === termKey(t); })) terms.push(t);
		}
		return terms.length ? { field: p.field, terms: terms } : null;
	}

	/** A filter pinned to one value in full, which is what a completion means. */
	function exact(field, value) {
		return { field: field, terms: [{ op: 'is', value: String(value) }] };
	}

	// --- writing it back out ----------------------------------------------

	function quote(v) {
		return '"' + String(v).replace(/"/g, '""') + '"';
	}

	function rangeText(t) {
		if (t.lo != null && t.hi != null) {
			return t.lo === t.hi ? String(t.lo) : t.lo + '-' + t.hi;
		}
		return t.lo != null ? '>=' + t.lo : '<=' + t.hi;
	}

	/** One term as the box would spell it. parse(toInput(f)) must give f back:
	 *  the chips are editable, so this round trip is load-bearing. */
	function termText(t) {
		if (t.op === 'range') return rangeText(t);
		if (t.op === 'is') return quote(t.value);
		return /[,"]/.test(t.value) || t.value.charAt(0) === '~'
			? '~' + quote(t.value)
			: t.value;
	}

	function toInput(f) {
		return (f.field ? f.field + ': ' : '') + f.terms.map(termText).join(', ');
	}

	/**
	 * The box text after a completion is taken: the half-typed term at the end
	 * is replaced by the chosen one, and a comma is left behind so the next
	 * value can follow without any punctuation being typed.
	 *
	 * Taking a value from a field the box is not scoped to rescopes the box.
	 * There is no way to say "publication:X or author:Y" in one mask -- terms
	 * OR within a single field -- and the value pointed at is the unambiguous
	 * half of the two.
	 */
	function spliceTerm(text, field, term) {
		var p = split(text);
		var kept = p.field === field ? p.raw.slice(0, -1) : [];
		// Trimmed on the way back out, or the space after each comma the box
		// itself left behind would double every time a term is added.
		kept = kept.map(function (t) { return t.trim(); }).filter(Boolean);
		kept.push(term);
		return (field ? field + ': ' : '') + kept.join(', ') + ', ';
	}

	// --- matching ---------------------------------------------------------

	function hit(values, op, needle) {
		for (var i = 0; i < values.length; i++) {
			var s = String(values[i]).toLowerCase();
			if (op === 'is' ? s === needle : s.indexOf(needle) >= 0) return true;
		}
		return false;
	}

	function matchTerm(field, t, fac) {
		if (t.op === 'range') {
			var ys = fac.year || [];
			for (var i = 0; i < ys.length; i++) {
				var y = Number(ys[i]);
				if (t.lo != null && y < t.lo) continue;
				if (t.hi != null && y > t.hi) continue;
				return true;
			}
			return false;
		}
		var needle = String(t.value).toLowerCase();
		if (field) return hit(fac[field] || [], t.op, needle);
		// A bare term is asked of every facet at once. That is what lets
		// "Tales" work without the user having to know which field it lives in.
		for (var j = 0; j < NAMES.length; j++) {
			if (hit(fac[NAMES[j]] || [], t.op, needle)) return true;
		}
		return false;
	}

	/** Terms OR: any one of them passing is what the mask asks for. */
	function matches(filter, fac) {
		if (!filter || !filter.terms.length) return true;
		for (var i = 0; i < filter.terms.length; i++) {
			if (matchTerm(filter.field, filter.terms[i], fac)) return true;
		}
		return false;
	}

	/** Filters AND: this is the narrowing half of the grammar. */
	function matchesAll(filters, fac) {
		for (var i = 0; i < filters.length; i++) if (!matches(filters[i], fac)) return false;
		return true;
	}

	function termKey(t) {
		return t.op === 'range'
			? 'r|' + t.lo + '|' + t.hi
			: t.op + '|' + String(t.value).toLowerCase();
	}

	/** Identity, so the same mask cannot be laid down twice. Terms are sorted:
	 *  they OR, so the order they were picked in means nothing. */
	function key(f) {
		return (f.field || '*') + '|' + f.terms.map(termKey).sort().join('|');
	}

	function termLabel(t) {
		if (t.op === 'range') {
			if (t.lo != null && t.hi != null) {
				return t.lo === t.hi ? String(t.lo) : t.lo + '–' + t.hi;
			}
			return t.lo != null ? '≥' + t.lo : '≤' + t.hi;
		}
		// '~' marks a substring. Pinned values are the common case and read
		// plainly; the odd one out is the one that has to be marked. A value
		// with a comma in it is quoted, or a three-value chip would read as
		// four and there would be no telling where one value ended.
		var v = t.value.indexOf(',') >= 0 ? '"' + t.value + '"' : t.value;
		return (t.op === 'contains' ? '~' : '') + v;
	}

	/** The chip's text. Short, because it sits in a 220px panel -- the chip's
	 *  title attribute carries the long form. */
	function describe(f) {
		return (f.field || 'any') + ': ' + f.terms.map(termLabel).join(', ');
	}

	// --- completions ------------------------------------------------------

	/**
	 * What to offer for the half-typed text, given the items that survive the
	 * masks already down.
	 *
	 * Drawing candidates from the SURVIVORS rather than from the whole
	 * collection is the point: a value on this list always leaves something on
	 * screen, so stacking masks walks down a narrowing tree instead of
	 * dead-ending on a combination that matches nothing. The mask being edited
	 * is not one of the survivors' constraints -- see masked() in graph.js --
	 * because its terms OR, and widening it cannot empty anything either way.
	 *
	 * @param {string} text        what is in the box
	 * @param {Object[]} entries   facets() of each surviving item
	 * @param {number} [limit]
	 * @returns {Object[]} { kind, label, hint, count?, field?, term?, insert? }
	 *   `insert` replaces the whole box; `term` is spliced in by spliceTerm().
	 */
	function suggest(text, entries, limit) {
		limit = limit || 12;
		var p = split(text);
		var partial = p.raw[p.raw.length - 1].trim().replace(/^~/, '').replace(/^"|"$/g, '');
		var term = partial.toLowerCase();
		var out = [];

		// Values already in this mask. Offering one again would be a no-op, and
		// a list whose top row does nothing is worse than a shorter list.
		var chosen = new Set();
		for (var c = 0; c < p.raw.length - 1; c++) {
			var t = parseTerm(p.field, p.raw[c]);
			if (t && t.op !== 'range') chosen.add(String(t.value).toLowerCase());
		}

		// A field name still being typed. Only before any term is committed to
		// this mask -- past the first comma the field is settled -- and only
		// while the text still looks like a field name.
		if (!p.field && p.raw.length === 1) {
			for (var i = 0; i < FIELDS.length; i++) {
				var f = FIELDS[i];
				if (term && f.name.indexOf(term) !== 0) continue;
				out.push({
					kind: 'field',
					label: f.name + ':',
					hint: 'filter by ' + f.label,
					insert: f.name + ': ',
				});
			}
		}

		// Year comparisons cannot be enumerated, so a parsed range is offered as
		// its own entry rather than as one of the values below.
		if (p.field === 'year' && partial) {
			var r = parseYear(partial);
			if (r && !(r.lo != null && r.lo === r.hi)) {
				out.push({
					kind: 'range',
					label: termLabel({ op: 'range', lo: r.lo, hi: r.hi }),
					hint: 'a span of years',
					field: 'year',
					term: partial,
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
					if (chosen.has(value.toLowerCase())) continue;
					var id = name + ' ' + value;
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
				field: ranked[s].field,
				term: quote(ranked[s].value),
			});
		}

		// The escape hatch: whatever was typed, as a substring. Last, and
		// dropped when a value already on the list says the same thing.
		var free = partial ? parseTerm(p.field, p.raw[p.raw.length - 1]) : null;
		if (free && free.op === 'contains') {
			var dup = out.some(function (o) {
				return o.kind === 'value' && o.label.toLowerCase() === term;
			});
			if (!dup) {
				out.push({
					kind: 'free',
					label: termLabel(free),
					hint: 'anything containing this',
					field: p.field,
					term: termText(free),
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
		splitTerms: splitTerms,
		matches: matches,
		matchesAll: matchesAll,
		describe: describe,
		toInput: toInput,
		spliceTerm: spliceTerm,
		key: key,
		suggest: suggest,
	};
}(typeof window !== 'undefined' ? window : globalThis));
