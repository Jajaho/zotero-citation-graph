/**
 * Node sizing maths, kept separate from graph.js because it is pure and
 * therefore testable -- the first version of this shipped a scale that drew a
 * 4,000-citation paper the same size as a 100-citation one, and it took an eye
 * rather than a test to catch it.
 *
 * Loaded as a plain <script> (like force-graph) and published as a global; the
 * content page has no module loader. tools/test-cjs-shim.js evaluates this same
 * file to assert the curve.
 */
(function (global) {
	'use strict';

	// force-graph draws a node as a circle of sqrt(val) * nodeRelSize, in graph
	// coordinates. Everything here works in radius and converts at the end.
	var NODE_REL_SIZE = 4;

	var R_UNKNOWN = 2;   // no resolved citation count
	var R_MIN = 3;       // a resolved count of zero
	var R_REF = 20;      // at the reference percentile
	var R_HARD = 28;     // absolute ceiling for the tail above the reference

	var REF_PERCENTILE = 0.95;
	var MIN_FOR_PERCENTILE = 20;

	/** Undo force-graph's own sqrt, so the number we control is the radius. */
	function areaFor(radius) {
		var r = radius / NODE_REL_SIZE;
		return r * r;
	}

	/**
	 * The count that maps to R_REF.
	 *
	 * The 95th percentile, not the maximum. Citation counts are heavy-tailed: in
	 * a collection where one paper has 41,000 citations and the rest have
	 * hundreds, normalising on the maximum renders the rest as identical specks.
	 *
	 * Under MIN_FOR_PERCENTILE counted nodes a percentile is indistinguishable
	 * from the max, so it falls back rather than claiming a precision it lacks.
	 *
	 * @param {number[]} counts  non-null citation counts currently on screen
	 */
	function referenceCount(counts) {
		if (!counts || !counts.length) return 1;
		var s = counts.slice().sort(function (a, b) { return a - b; });
		var idx = s.length >= MIN_FOR_PERCENTILE
			? Math.floor(REF_PERCENTILE * (s.length - 1))
			: s.length - 1;
		// A reference of 0 (nothing on screen is cited) would divide by zero.
		return Math.max(1, s[idx]);
	}

	/**
	 * Radius for a global citation count.
	 *
	 * AREA proportional to the count (so radius by sqrt) up to the reference,
	 * which is the standard encoding for a magnitude and the only one that reads
	 * proportionally. Above the reference it keeps growing logarithmically: a
	 * hard clamp there drew the 41,000-citation landmark at exactly the size of
	 * the 4,000-citation one.
	 *
	 * The scale this replaced applied log10 to the domain and then let
	 * force-graph's sqrt compress it again, turning a 40x difference in
	 * citations into a 1.27x difference in radius.
	 *
	 * @param {?number} count  null when the identifier was never resolved
	 * @param {number} ref     from referenceCount()
	 */
	function globalRadius(count, ref) {
		if (count == null) return R_UNKNOWN;
		var frac = Math.sqrt(count / Math.max(1, ref));
		if (frac > 1) frac = 1 + Math.log10(frac);
		return Math.min(R_HARD, R_MIN + (R_REF - R_MIN) * frac);
	}

	/** What nodeVal() returns for the "global citations" mode. */
	function globalVal(count, ref) {
		return areaFor(globalRadius(count, ref));
	}

	global.ZGScale = {
		NODE_REL_SIZE: NODE_REL_SIZE,
		R_UNKNOWN: R_UNKNOWN,
		R_MIN: R_MIN,
		R_REF: R_REF,
		R_HARD: R_HARD,
		areaFor: areaFor,
		referenceCount: referenceCount,
		globalRadius: globalRadius,
		globalVal: globalVal,
	};
}(typeof window !== 'undefined' ? window : globalThis));
