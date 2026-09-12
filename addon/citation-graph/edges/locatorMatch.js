'use strict';

const { register } = require('../core/registry');
const { edge } = require('../core/types');
const { normTitle, firstYear } = require('../core/normalize');
const { readSection } = require('./refSection');

/**
 * Strategy: the cited work's JOURNAL, VOLUME and FIRST PAGE appear together in
 * the citing paper's reference section.
 *
 * This exists because of a measurement. On the sample library the offline
 * strategies missed 95 of the 348 citations Crossref lists between held works,
 * and `explain-misses.js` found evidence in the document for exactly ONE of
 * them: no DOI anywhere in the file, no title anywhere in the text. The reason
 * is not extraction failure. It is that a numeric reference style prints
 * neither:
 *
 *     13 S.-M. Lee and D. G. Cahill, J. Appl. Phys. 81, 2590 (1997).
 *
 * That is a complete, unambiguous citation of a paper the library holds, and
 * every other offline strategy is blind to it -- pdf-links and text-doi want a
 * DOI, title-match wants a title, ref-strings parses a title out of the entry
 * and finds none. Physics, chemistry and mathematics publish this way by
 * default, so the blindness is not evenly spread: it takes out whole fields.
 *
 * Journal, volume and first page identify a paper as tightly as a DOI does --
 * that is what they are for, and what a numeric style relies on. Measured on
 * the sample library before this was written: 140 of the predictions Crossref
 * could grade, 140 of them in its key, and not one edge it does not list.
 *
 * It draws edges between held works only, and contributes no outside nodes: a
 * locator naming a work the library does not hold identifies nothing this
 * graph can resolve, since there is no registry to look it up in.
 */

/** Words dropped before matching a journal name. Abbreviations drop them too. */
const STOP = new Set(['of', 'the', 'and', 'on', 'in', 'for', 'a', 'an',
	'des', 'der', 'die', 'das', 'und', 'fur', 'zur', 'zum', 'de', 'la', 'le']);

/**
 * Is this window naming that journal?
 *
 * Each significant word of the journal's name must appear, in order, as an
 * abbreviation relation: one is a prefix of the other. `Rev. Sci. Instrum.`
 * names `Review of Scientific Instruments` because rev<review, sci<scientific,
 * instrum<instruments; `J. Appl. Phys.` names `Journal of Applied Physics` the
 * same way.
 *
 * Three characters of agreement are demanded wherever there are three to
 * demand. Where there are not -- `J.`, or the `B` of `Phys. Rev. B` -- a
 * prefix test would match anything beginning with that letter, so those have
 * to agree exactly instead. A journal's initial and its series letter are
 * load-bearing: `Phys. Rev. B` and `Phys. Rev. D` are different journals that
 * number their volumes separately, and a rule that let one stand for the other
 * would draw an edge to the wrong paper rather than no edge at all.
 *
 * Order matters and is cheap to demand: it is what stops `Appl. Phys. Lett.`
 * from being read as `Journal of Applied Physics` with the words rearranged.
 */
function namesJournal(windowWords, tokens) {
	let at = 0;
	for (const t of tokens) {
		let hit = -1;
		for (let i = at; i < windowWords.length; i++) {
			const w = windowWords[i];
			const n = Math.min(w.length, t.length);
			const ok = n >= 3
				? (w.startsWith(t.slice(0, n)) || t.startsWith(w.slice(0, n)))
				: w === t;
			if (ok) { hit = i; break; }
		}
		if (hit < 0) return false;
		at = hit + 1;
	}
	return true;
}

function journalTokens(name) {
	return normTitle(name).split(' ').filter((w) => w && !STOP.has(w));
}

/** The page a work starts on: `2590-2595` -> `2590`, `L123-` -> `l123`. */
function firstPage(pages) {
	const p = String(pages || '').split(/[-–—,]/)[0].trim().toLowerCase();
	return /^[a-z]?\d{1,6}$/.test(p) ? p : null;
}

module.exports.id = register({
	id: 'locator-match',
	label: 'Journal, volume and page in reference section',
	requiresNetwork: false,
	// On by default, like the other two that draw edges between works already on
	// screen. It adds no nodes, so it cannot change what a graph is OF -- and it
	// is the only strategy that can see a numeric-style citation at all.
	defaultEnabled: true,
	defaultConfidence: 0.7,
	options: {
		// Characters before the volume/page pair searched for the journal name.
		// One reference entry's worth: long enough for `S.-M. Lee and D. G.
		// Cahill, J. Appl. Phys.`, short enough not to reach the entry above.
		journalWindow: 80,
		// The year must corroborate. Volume and page alone are four digits of
		// coincidence away from a wrong edge, and a numeric style prints the
		// year in the same breath, so demanding it costs almost no recall.
		requireYear: true,
		yearWindow: 40,
		// A locator read out of a guessed section is the same locator, but the
		// scope it came from might be body text; the score says so.
		confidenceBySegment: { heading: 0.85, numbered: 0.8, tail: 0.5 },
	},

	async *derive({ adapter, items, index, options, onProgress, refSection }) {
		// Locator -> the works that claim it. Built once: the targets are the
		// same for every document, and only the sections change.
		const byLocator = locatorIndex(items);
		if (!byLocator.size) return;

		let done = 0;
		for (const item of items) {
			onProgress && onProgress(++done, items.length, item.key);
			for (const att of await adapter.getAttachments(item.key)) {
				const seg = await readSection(adapter, att.key, refSection);
				if (!seg || seg.quality === 'none') continue;
				const conf = options.confidenceBySegment[seg.quality] ?? 0.5;
				for (const hit of scanLocators(normTitle(seg.flat), byLocator, options, item.key)) {
					yield edge(item.key, hit.key, 'locator-match', conf, {
						attachment: att.key, segment: seg.quality,
						locator: hit.journal + ' ' + hit.vol + ', ' + hit.page,
					});
				}
			}
		}
	},
});

/**
 * Every held work that can be named by a locator, indexed by the locator.
 *
 * Exported so the bench can ask the same question about one target that the
 * strategy asks about all of them at once -- `explain-misses.js` has to be able
 * to say "the locator WAS in the text and we dropped it" without owning a
 * second copy of the matching rule, since a second copy is a copy that drifts.
 */
function locatorIndex(items) {
	const byLocator = new Map();
	for (const it of items) {
		const vol = String(it.volume || '').trim();
		const page = firstPage(it.pages);
		const journal = it.journalAbbreviation || it.publication;
		if (!/^\d{1,4}$/.test(vol) || !page || !journal) continue;
		const k = vol + ' ' + page;
		if (!byLocator.has(k)) byLocator.set(k, []);
		byLocator.get(k).push({
			key: it.key, vol, page,
			tokens: journalTokens(journal),
			year: firstYear(it.date),
		});
	}
	return byLocator;
}

/**
 * The locators one reference section names, in one pass over its words.
 *
 * A pass rather than a search per held work: a library of a few hundred items
 * would otherwise pay a few hundred scans of every bibliography it owns, which
 * is the shape of cost title-match had to be rescued from with a rolling hash.
 * Here the numbers do the screening for free -- a locator IS its own index key.
 *
 * @param {string} flat   the section, normTitle'd
 * @param {Map} byLocator from locatorIndex()
 * @param {string} selfKey the citing item, which cannot cite itself
 */
function scanLocators(flat, byLocator, options, selfKey) {
	const words = [], at = [];
	const re = /[a-z0-9]+/g;
	let m;
	while ((m = re.exec(flat))) { words.push(m[0]); at.push(m.index); }

	const out = [], seen = new Set();
	for (let i = 0; i + 1 < words.length; i++) {
		if (!/^\d/.test(words[i])) continue;
		// `81 2590` as printed, and Elsevier's `81 (1997) 2590` with the year
		// sitting between the two halves of the locator.
		const pairs = [[words[i + 1], i + 1]];
		if (i + 2 < words.length && /^(1[5-9]\d\d|20[0-4]\d)$/.test(words[i + 1])) {
			pairs.push([words[i + 2], i + 2]);
		}
		for (const [page, pageIdx] of pairs) {
			const cands = byLocator.get(words[i] + ' ' + page);
			if (!cands) continue;
			for (const t of cands) {
				if (t.key === selfKey || seen.has(t.key)) continue;
				const start = Math.max(0, at[i] - options.journalWindow);
				const before = flat.slice(start, at[i]);
				if (!namesJournal(before.split(' ').filter(Boolean), t.tokens)) continue;
				if (options.requireYear && t.year) {
					const after = flat.slice(at[pageIdx], at[pageIdx] + options.yearWindow);
					if (!after.includes(String(t.year)) && !before.includes(String(t.year))) continue;
				}
				seen.add(t.key);
				out.push({ key: t.key, vol: t.vol, page: t.page, journal: t.tokens.join(' ') });
			}
		}
	}
	return out;
}

// For the tests, and for the bench that has to ask the same question about one
// target that the strategy asks about all of them.
module.exports.namesJournal = namesJournal;
module.exports.firstPage = firstPage;
module.exports.locatorIndex = locatorIndex;
module.exports.scanLocators = scanLocators;
