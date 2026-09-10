'use strict';

const { register } = require('../core/registry');
const { edge } = require('../core/types');
const { normTitle, firstYear } = require('../core/normalize');
const { readSection } = require('./refSection');

/**
 * Characters in the fragment each title is screened by.
 *
 * Every reference section used to be searched once per title in the
 * collection -- an indexOf over the whole section for each of them -- so the
 * text phase grew with the square of the collection. Now each title stands
 * for one fragment of itself, the rarest among all the titles, and a section
 * is rolled over once to see which fragments it contains. Only the titles
 * whose fragment turned up are searched for.
 *
 * It is a screen and nothing more. A title that occurs in the text contains
 * every fragment of itself, so no match the old loop found can be screened
 * out; a fragment that turns up by accident, or a hash that collides, costs
 * only the indexOf the old loop paid for every title anyway. The edges, their
 * order and the match position the author check reads are what they were.
 *
 * Well under minTitleLength's tested floor of 30, so every title the matcher
 * accepts has one. A shorter one, if that option is lowered past this, is
 * never screened: it is searched for in every section, as before.
 */
const FRAGMENT = 12;
const BASE = 131;
// BASE^(FRAGMENT-1), wrapped to 32 bits: what the character leaving the
// window contributed to the hash.
const LEAD = (() => {
	let p = 1;
	for (let i = 1; i < FRAGMENT; i++) p = Math.imul(p, BASE);
	return p;
})();

/** Rolling hash of every FRAGMENT-long window of s, in order. */
function fragmentHashes(s) {
	if (s.length < FRAGMENT) return new Int32Array(0);
	const out = new Int32Array(s.length - FRAGMENT + 1);
	let h = 0;
	for (let i = 0; i < FRAGMENT; i++) h = (Math.imul(h, BASE) + s.charCodeAt(i)) | 0;
	out[0] = h;
	for (let i = FRAGMENT; i < s.length; i++) {
		h = (Math.imul((h - Math.imul(s.charCodeAt(i - FRAGMENT), LEAD)) | 0, BASE) + s.charCodeAt(i)) | 0;
		out[i - FRAGMENT + 1] = h;
	}
	return out;
}

/**
 * Index the targets by their rarest fragment. Once per derive(): the targets
 * are the same for every section, and only the sections change.
 */
function screen(targets) {
	const hashes = targets.map((t) => fragmentHashes(t.nt));
	const freq = new Map();
	for (const hs of hashes) {
		for (const h of new Set(hs)) freq.set(h, (freq.get(h) || 0) + 1);
	}
	const byFragment = new Map();
	const always = [];
	for (let i = 0; i < targets.length; i++) {
		const hs = hashes[i];
		if (!hs.length) {
			always.push(i);
			continue;
		}
		let best = hs[0];
		let bestN = freq.get(best);
		for (let j = 1; j < hs.length; j++) {
			const n = freq.get(hs[j]);
			if (n < bestN) {
				best = hs[j];
				bestN = n;
			}
		}
		let list = byFragment.get(best);
		if (!list) byFragment.set(best, list = []);
		list.push(i);
	}
	return { byFragment, always, mark: new Uint8Array(targets.length) };
}

/** Flag, by target index, every title whose fragment occurs in `flat`. The
 *  flags are reused from section to section rather than allocated per one. */
function candidates(sc, flat) {
	const mark = sc.mark;
	mark.fill(0);
	for (const i of sc.always) mark[i] = 1;
	if (flat.length < FRAGMENT) return mark;
	let h = 0;
	for (let i = 0; i < FRAGMENT; i++) h = (Math.imul(h, BASE) + flat.charCodeAt(i)) | 0;
	for (let i = FRAGMENT - 1; ; ) {
		const list = sc.byFragment.get(h);
		if (list) for (let k = 0; k < list.length; k++) mark[list[k]] = 1;
		if (++i >= flat.length) break;
		h = (Math.imul((h - Math.imul(flat.charCodeAt(i - FRAGMENT), LEAD)) | 0, BASE) + flat.charCodeAt(i)) | 0;
	}
	return mark;
}

/**
 * Strategy: the cited paper's title appears verbatim in the citing paper's
 * reference section.
 *
 * The highest-yield offline signal by some margin -- 172 in-collection edges
 * from 75 citing documents on the sample library, more than both DOI strategies
 * combined -- and the only one that works for items with no DOI at all.
 *
 * It is also the least trustworthy: of the title-match edges with no DOI
 * corroboration, only 49% were confirmed by OpenAlex. Confidence is therefore
 * tied to segmentation quality, and edges drawn from a guessed ('tail') scope
 * are emitted at a markedly lower score so the UI can style or hide them.
 *
 * This strategy cannot contribute external nodes and ignores `includeExternal`:
 * it searches the reference text for titles it already holds, so a reference to
 * something outside the collection is invisible to it by construction. Only the
 * DOI strategies can name a work they do not have.
 */
module.exports.id = register({
	id: 'title-match',
	label: 'Title found in reference section',
	requiresNetwork: false,
	defaultEnabled: true,
	defaultConfidence: 0.6,
	options: {
		minTitleLength: 30,      // shorter titles collide; 30 chars was the tested floor
		requireAuthor: false,    // also demand the first author's surname nearby
		authorWindow: 300,       // chars around the title match to search for it
		confidenceBySegment: { heading: 0.8, numbered: 0.75, tail: 0.4 },
		// Reject a match whose year contradicts the cited item's own year.
		rejectImpossibleYear: true,
	},

	async *derive({ adapter, items, index, options, onProgress, refSection }) {
		const targets = index.titleTargets.filter((t) => t.nt.length >= options.minTitleLength);
		const sc = screen(targets);
		let done = 0;
		for (const item of items) {
			onProgress && onProgress(++done, items.length, item.key);
			const citingYear = firstYear(item.date);
			for (const att of await adapter.getAttachments(item.key)) {
				const seg = await readSection(adapter, att.key, refSection);
				if (!seg || seg.quality === 'none') continue;
				const flat = normTitle(seg.flat);
				const conf = options.confidenceBySegment[seg.quality] ?? 0.4;

				// In the targets' own order, so the edges come out in the order the
				// unscreened loop produced them.
				const mark = candidates(sc, flat);
				for (let i = 0; i < targets.length; i++) {
					if (!mark[i]) continue;
					const t = targets[i];
					if (t.key === item.key) continue;
					const at = flat.indexOf(t.nt);
					if (at < 0) continue;

					// A paper cannot cite something published after it. Allow one
					// year of slack for preprint/issue-date mismatches.
					if (options.rejectImpossibleYear && citingYear && t.year && t.year > citingYear + 1) {
						continue;
					}
					if (options.requireAuthor && t.surname) {
						const w = options.authorWindow;
						const around = flat.slice(Math.max(0, at - w), at + t.nt.length + w);
						if (!around.includes(t.surname)) continue;
					}
					yield edge(item.key, t.key, 'title-match', conf,
						{ attachment: att.key, segment: seg.quality, matchedTitleChars: t.nt.length });
				}
			}
		}
	},
});

// For the tests, which hold the screen to the loop it replaced.
module.exports.screen = screen;
module.exports.candidates = candidates;
module.exports.FRAGMENT = FRAGMENT;
