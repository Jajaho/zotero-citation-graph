/**
 * What the collection keeps citing and does not hold.
 *
 * The graph already draws these as ghosts, sized by how many of your papers
 * cite them. What it cannot do is answer the question in one look: with the
 * long tail on screen the interesting ones are somewhere in a cloud of several
 * thousand, and with the tail filtered off you are reading a graph rather than
 * a list. So: the same data, ranked, as a list.
 *
 * Two numbers decide the order, and they are not the same number:
 *
 *   citedBy        how many papers in THIS collection cite it -- the gap
 *   citedByGlobal  how often the whole literature cites it -- the fame
 *
 * Ranking on the first alone puts the field's landmarks at the top, which is
 * the one answer nobody needs: you already know about the 41,000-citation
 * paper, and if you do not hold it that is a decision rather than an oversight.
 * Dividing by the log of the second asks the better question -- how hard is
 * this library leaning on it, for how well known it is -- and that surfaces the
 * obscure work four of your papers quietly depend on, which is the thing you
 * actually did not know.
 *
 * Loaded as a plain <script> and published as a global; the content page has no
 * module loader. tools/test-cjs-shim.js evaluates this same file.
 */
(function (global) {
	'use strict';

	/**
	 * Works cited once are mostly noise -- 3,172 of them on the sample library
	 * against 47 cited five times or more, and a single harvested DOI is as
	 * likely to be a licence URL as a reference. Two citers is the same floor
	 * the graph's own "cited by >=" control defaults to.
	 */
	var MIN_CITED_BY = 2;

	/** Rows worth reading. Past this the tail is the tail. */
	var LIMIT = 25;

	/**
	 * A cluster owns a gap when it holds more than this share of the citers --
	 * a strict majority of ALL of them, unplaced ones included.
	 *
	 * Strict, because an even split has no owner and naming one of the two
	 * halves would be reporting a tie-break as a finding. Counted against every
	 * citer rather than only the ones a subfield could be found for, because a
	 * gap cited by four papers of which one is placed is not a hole in that
	 * one's subfield -- it is a gap we cannot attribute, and saying so is the
	 * honest output.
	 */
	var DOMINANT = 0.5;

	/**
	 * Local weight per unit of fame.
	 *
	 * log10(10 + n) rather than log(n): it is 1 at zero citations, 2 at ninety,
	 * 3 at a thousand and about 4.6 at forty thousand, so a work four of your
	 * papers cite and the literature barely notices (score 4) outranks one five
	 * of them cite that the world has cited 41,000 times (score 1.1). The curve
	 * discounts fame without ever cancelling the local count outright -- a work
	 * eleven of your papers cite is a gap however famous it is.
	 *
	 * A count that was never resolved scores exactly as a resolved zero does --
	 * the divisor is 1 either way -- which is deliberate rather than an
	 * oversight. It means that with the lookup off, where no count is resolved
	 * at all, the whole list falls back to plain "most cited here", and that is
	 * the right answer to a question asked with no fame data to discount by.
	 */
	function score(citedBy, citedByGlobal) {
		if (citedByGlobal == null) return citedBy;
		return citedBy / Math.log10(10 + Math.max(0, citedByGlobal));
	}

	/**
	 * The gaps, best first.
	 *
	 * @param {{from: string, to: string}[]} edges  believed citation edges
	 * @param {Object[]} externals  the wire shape of an outside work: key, ns,
	 *   id, citedBy, via, and title/creators/year/citedByGlobal once looked up
	 * @param {Object} [opts]
	 * @param {Map<string, string>} [opts.clusterOf]  item key -> subfield name
	 * @param {number} [opts.minCitedBy]
	 * @param {number} [opts.limit]
	 * @returns {{rows: Object[], total: number}}  `total` counts every gap over
	 *   the floor, so a capped list can say what it is not showing.
	 */
	function rank(edges, externals, opts) {
		opts = opts || {};
		var floor = opts.minCitedBy == null ? MIN_CITED_BY : opts.minCitedBy;
		var limit = opts.limit == null ? LIMIT : opts.limit;
		var clusterOf = opts.clusterOf || new Map();

		// Recomputed from the edges rather than taken from externals[].citedBy:
		// that count came off the whole build, and the caller has already
		// dropped edges the confidence slider or a strategy toggle disowns.
		var citers = new Map();
		for (var i = 0; i < (edges || []).length; i++) {
			var e = edges[i];
			if (!e || !e.from || !e.to) continue;
			var list = citers.get(e.to);
			if (!list) citers.set(e.to, list = []);
			if (list.indexOf(e.from) < 0) list.push(e.from);
		}

		var rows = [];
		for (var x = 0; x < (externals || []).length; x++) {
			var g = externals[x];
			var who = citers.get(g.key);
			if (!who || who.length < floor) continue;
			who = who.slice().sort();
			var global = g.citedByGlobal == null ? null : g.citedByGlobal;
			rows.push({
				key: g.key,
				ns: g.ns,
				id: g.id,
				title: g.title || null,
				creators: g.creators || [],
				year: g.year == null ? null : g.year,
				citedBy: who.length,
				citedByGlobal: global,
				citers: who,
				via: g.via || [],
				score: score(who.length, global),
				subfields: attribute(who, clusterOf),
			});
		}

		// Score, then the raw local count, then the key: two gaps a library
		// leans on equally must not swap places between two renders.
		rows.sort(function (a, b) {
			return b.score - a.score || b.citedBy - a.citedBy
				|| (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
		});
		return { rows: rows.slice(0, limit), total: rows.length };
	}

	/**
	 * Which subfields are doing the citing.
	 *
	 * A gap five papers of one subfield cite is a hole in that subfield and can
	 * be named as one. A gap five papers spread over five subfields cite is the
	 * collection's common ground, which is a different kind of missing and gets
	 * said differently -- hence `top` only when one cluster actually owns it.
	 *
	 * @returns {{counts: {name: string, count: number}[], top: ?string, spread: number}}
	 */
	function attribute(citers, clusterOf) {
		var counts = new Map();
		for (var i = 0; i < citers.length; i++) {
			var name = clusterOf.get(citers[i]);
			if (!name) continue;
			counts.set(name, (counts.get(name) || 0) + 1);
		}
		var list = [];
		counts.forEach(function (count, name) { list.push({ name: name, count: count }); });
		list.sort(function (a, b) {
			return b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		});
		var top = list.length && citers.length
			&& list[0].count / citers.length > DOMINANT ? list[0].name : null;
		return { counts: list, top: top, spread: list.length };
	}

	global.ZGGaps = {
		MIN_CITED_BY: MIN_CITED_BY,
		LIMIT: LIMIT,
		score: score,
		attribute: attribute,
		rank: rank,
	};
}(typeof window !== 'undefined' ? window : globalThis));
