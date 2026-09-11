'use strict';

const { register } = require('../core/registry');
const { edge, externalKey } = require('../core/types');
const { readSection } = require('./refSection');
const { splitEntries, detectStyle, parseEntry, refSignature } = require('./refParse');

/**
 * Strategy: every work named in the reference section, whether or not anything
 * identifies it.
 *
 * The other offline strategies can only name a cited work that carries an
 * identifier -- a hyperlinked DOI (pdf-links) or a printed one (text-doi) --
 * and DOIs are printed in under a quarter of PDFs. title-match needs no
 * identifier but can only find titles the collection ALREADY HOLDS, so it
 * contributes no outside nodes by construction. Between them they leave a
 * systematic hole: the works a library cites and does not hold, in fields whose
 * publishers print no DOIs, are invisible to the graph entirely.
 *
 * This reads the reference strings themselves. Each entry is parsed into a
 * title, and a work that resolves to no identifier and to nothing held becomes
 * a node keyed by a slug of that title (`ref:<slug>`) -- the only node in the
 * graph whose identity is a title rather than a registered identifier.
 *
 * That identity is weaker than a DOI and the confidence says so. Two entries
 * are one node when their first eight title words agree, which is tolerant of
 * punctuation, casing and a dropped subtitle, and intolerant of OCR damage
 * early in a title. See refParse.js refSignature for why the author and year
 * are deliberately kept out of the key.
 *
 * It also describes what it parses -- including for the `doi:` nodes it shares
 * with text-doi. Nothing can resolve a `ref:` key (no enricher declares the
 * namespace, and there is no URL to open), so unlike every other outside
 * reference these have to arrive from the build already carrying their name.
 * Naming the DOI ones too is what lets consolidateRefs fold a work cited both
 * ways into one node WITHOUT the network lookup having run.
 */

// How far a guessed section scope is trusted. A 'tail' segmentation is the
// feasibility study's prime suspect for title-match's false positives, and a
// ghost invented out of body text is worse than a missing edge -- it is a node
// that was never cited by anyone.
const SEGMENT_FACTOR = { heading: 1, numbered: 0.95, tail: 0.6, none: 0 };
const QUALITY_RANK = { heading: 3, numbered: 2, tail: 1, none: 0 };

module.exports.id = register({
	id: 'ref-strings',
	label: 'Parsed reference strings',
	requiresNetwork: false,
	// It has its own switch rather than a filter: it is the only offline
	// strategy that ADDS NODES rather than edges between nodes already on
	// screen, so leaving it on by default would change what every existing
	// graph is of. See graphTab.js phase 3c.
	defaultEnabled: false,
	defaultConfidence: 0.5,
	options: {
		// A guessed scope still yields usable entries when the split succeeds,
		// and the split failing is the real guard -- so this is deliberately
		// permissive and SEGMENT_FACTOR carries the doubt instead.
		minSegmentQuality: 'tail',
		// A title match against a held item, with and without the first author
		// agreeing. Below title-match's 0.8 heading score when uncorroborated,
		// because one parsed entry is less evidence than a whole section.
		titleConfidence: 0.8,
		titleConfidenceNoAuthor: 0.65,
		// A paper cannot cite something published after it; one year of slack
		// for preprint/issue-date mismatches. Same rule as title-match.
		rejectImpossibleYear: true,
		// Ghosts are inferred nodes, never asserted ones, and the ceiling says
		// so however confident the parse was.
		maxGhostConfidence: 0.55,
	},

	async *derive({ adapter, items, index, options, includeExternal, onProgress, refSection, describe }) {
		let done = 0;
		for (const item of items) {
			onProgress && onProgress(++done, items.length, item.key);
			const citingYear = yearOf(item.date);

			for (const att of await adapter.getAttachments(item.key)) {
				const seg = await readSection(adapter, att.key, refSection);
				if (!seg) continue;
				if (QUALITY_RANK[seg.quality] < QUALITY_RANK[options.minSegmentQuality]) continue;

				// The line structure, not the flattened form: every boundary
				// signal lives in exactly what flattening destroys.
				const { entries, layout } = splitEntries(seg.text);
				// An honest failure. The section is real but its structure was
				// unreadable, so nothing here is trustworthy enough to make a
				// node out of -- and title-match has already read it anyway.
				if (!entries.length) continue;

				const style = detectStyle(entries);
				const factor = SEGMENT_FACTOR[seg.quality] || 0;
				const where = { attachment: att.key, segment: seg.quality, layout, style };

				for (const entry of entries) {
					const p = parseEntry(entry, style);
					const e = resolve(item, p, { index, options, includeExternal, citingYear, factor, where, describe });
					if (e) yield e;
				}
			}
		}
	},
});

/**
 * One parsed entry to one edge, first hit wins.
 *
 * The order is by strength of identity, not by convenience: an identifier beats
 * a title, and a title we hold beats a title we do not. Resolving a DOI here
 * rather than minting a `ref:` node for it is what makes this strategy
 * reconcile with text-doi for free -- the same work, the same key, one node
 * carrying both provenances.
 */
function resolve(item, p, ctx) {
	const { index, options, includeExternal, citingYear, factor, where, describe } = ctx;
	if (!factor) return null;

	// 1-2. A printed DOI. Self-validating, so it outranks everything parsed.
	if (p.doi) {
		const held = index.lookupDoi(p.doi);
		if (held) {
			return held === item.key ? null
				: edge(item.key, held, 'ref-strings', 0.9, { ...where, doi: p.doi });
		}
		if (!includeExternal) return null;
		const key = externalKey('doi', p.doi);
		// Named even though the DOI would label it: a name parsed offline is
		// what lets this node meet a `ref:` one for the same work without the
		// lookup ever running.
		note(describe, key, p);
		return edge(item.key, key, 'ref-strings', 0.9, { ...where, doi: p.doi, external: true });
	}

	// 3. An arXiv id. First producer of the namespace -- types.js has declared
	//    it and normalize.js has found them since before anything asked.
	if (p.arxivId) {
		const held = index.lookupExternal('arxiv', p.arxivId);
		if (held) {
			return held === item.key ? null
				: edge(item.key, held, 'ref-strings', 0.85, { ...where, arxiv: p.arxivId });
		}
		if (!includeExternal) return null;
		const key = externalKey('arxiv', p.arxivId);
		note(describe, key, p);
		return edge(item.key, key, 'ref-strings', 0.85, { ...where, arxiv: p.arxivId, external: true });
	}

	if (!p.title) return null;

	// 4. A title the collection holds. Exact match on the normalized form --
	//    this is a lookup, not the substring scan title-match does, so a short
	//    title is safe here where it would collide there.
	const held = index.lookupTitle(p.title);
	if (held && held !== item.key) {
		const target = index.byKey.get(held);
		if (impossibleYear(options, citingYear, target)) return null;
		// The author is in the same entry as the title, which is the one thing
		// a per-entry strategy has that a per-section one cannot: title-match
		// has to go looking in a window of surrounding characters and settle
		// for whatever is nearby.
		const agrees = surnameAgrees(p.surname, target);
		const conf = agrees ? options.titleConfidence : options.titleConfidenceNoAuthor;
		return edge(item.key, held, 'ref-strings', round(conf * factor),
			{ ...where, matchedTitle: true, author: agrees });
	}
	if (held) return null;

	// 5. A work named but not identified and not held.
	if (!includeExternal) return null;
	const sig = refSignature(p);
	// No usable title is a parse failure, not a discovery. Minting a node here
	// would key it on a fragment, and a fragment collides with every other
	// fragment -- which would show up as one enormous ghost, not as noise.
	if (!sig) return null;
	const key = externalKey('ref', sig);
	note(describe, key, p);
	const conf = Math.min(p.parseConfidence * factor, options.maxGhostConfidence);
	return edge(item.key, key, 'ref-strings', round(conf), { ...where, external: true });
}

/** What the node IS, as opposed to why the edge exists. */
function note(describe, key, p) {
	if (!describe) return;
	describe(key, {
		title: p.title || null,
		creators: p.surname ? [p.surname] : [],
		year: p.year != null ? p.year : null,
		doi: p.doi || null,
		// Not one of enrich.js's FIELDS, so no enricher will ever overwrite it.
		// It is the one thing the ghost card can show that the heading and the
		// two counts do not already say, and a node with no identifier needs
		// every scrap of provenance it can be given.
		venue: p.venue || null,
		source: ['ref-strings'],
	});
}

function impossibleYear(options, citingYear, target) {
	if (!options.rejectImpossibleYear || !citingYear || !target) return false;
	const y = yearOf(target.date);
	return !!y && y > citingYear + 1;
}

/**
 * Does the parsed first author match the held item's?
 *
 * Compared on the surname alone and case-insensitively, because the two sides
 * come from different worlds: one was typed into Zotero by a human or a
 * translator, the other was read out of a PDF in whatever order its stylesheet
 * imposed. Anything stricter rejects correct matches far more often than it
 * catches wrong ones.
 */
function surnameAgrees(surname, target) {
	if (!surname || !target) return false;
	const want = String(surname).toLowerCase();
	return (target.creators || []).some((c) => {
		const s = String(c || '').toLowerCase();
		return s === want || s.endsWith(' ' + want);
	});
}

function yearOf(date) {
	const m = String(date || '').match(/\b(1[89]\d\d|20\d\d)\b/);
	return m ? Number(m[1]) : null;
}

/** Two places compute a confidence from a factor; neither wants 0.44999999. */
function round(n) {
	return Math.round(n * 1000) / 1000;
}
