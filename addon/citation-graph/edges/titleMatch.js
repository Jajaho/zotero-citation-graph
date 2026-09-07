'use strict';

const { register } = require('../core/registry');
const { edge } = require('../core/types');
const { normTitle, firstYear } = require('../core/normalize');
const { segment } = require('./refSection');

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

	async *derive({ adapter, items, index, options, onProgress }) {
		const targets = index.titleTargets.filter((t) => t.nt.length >= options.minTitleLength);
		let done = 0;
		for (const item of items) {
			onProgress && onProgress(++done, items.length, item.key);
			const citingYear = firstYear(item.date);
			for (const att of await adapter.getAttachments(item.key)) {
				const text = await adapter.getAttachmentText(att.key);
				if (!text) continue;
				const seg = segment(text);
				if (seg.quality === 'none') continue;
				const flat = normTitle(seg.flat);
				const conf = options.confidenceBySegment[seg.quality] ?? 0.4;

				for (const t of targets) {
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
