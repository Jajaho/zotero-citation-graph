'use strict';

const { register } = require('../core/registry');
const { edge, externalKey } = require('../core/types');
const { findDois } = require('../core/normalize');
const { readSection } = require('./refSection');

/**
 * Strategy: DOIs printed as visible text in the reference section.
 *
 * Kept for completeness and because it costs nothing on top of the text we
 * already read -- but it is weak. Measured on the sample library: median zero
 * DOIs per PDF, present in only 23%, yielding 18 in-collection edges from 5
 * documents. Most publishers do not print DOIs in bibliographies; they
 * hyperlink them instead (see `pdfLinks`).
 */
module.exports.id = register({
	id: 'text-doi',
	label: 'DOIs printed in reference text',
	requiresNetwork: false,
	defaultEnabled: true,
	defaultConfidence: 0.9,
	options: {
		// 'heading' | 'numbered' | 'tail' -- minimum segmentation quality to trust.
		// DOIs are self-validating strings, so even a sloppy scope is acceptable.
		minSegmentQuality: 'tail',
	},

	async *derive({ adapter, items, index, options, includeExternal, onProgress, refSection }) {
		const rank = { heading: 3, numbered: 2, tail: 1, none: 0 };
		let done = 0;
		for (const item of items) {
			onProgress && onProgress(++done, items.length, item.key);
			for (const att of await adapter.getAttachments(item.key)) {
				const seg = await readSection(adapter, att.key, refSection);
				if (!seg) continue;
				if (rank[seg.quality] < rank[options.minSegmentQuality]) continue;
				for (const d of findDois(seg.flat)) {
					const target = index.lookupDoi(d);
					if (target) {
						if (target !== item.key) {
							yield edge(item.key, target, 'text-doi', 0.9,
								{ doi: d, attachment: att.key, segment: seg.quality });
						}
					}
					else if (includeExternal) {
						// A cited work we do not hold; the DOI is all we know.
						yield edge(item.key, externalKey('doi', d), 'text-doi', 0.9,
							{ doi: d, attachment: att.key, segment: seg.quality, external: true });
					}
				}
			}
		}
	},
});
