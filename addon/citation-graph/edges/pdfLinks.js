'use strict';

const { register } = require('../core/registry');
const { edge, externalKey } = require('../core/types');
const { normDoi } = require('../core/normalize');

/**
 * Strategy: DOI hyperlinks embedded as PDF /URI link annotations.
 *
 * Highest-precision offline signal -- the DOI was put there by the publisher's
 * typesetter, not inferred. Measured on the sample library: 4,564 distinct DOIs
 * across 127 of 334 PDFs (median 12 each), yielding 156 in-collection edges.
 * Roughly 14x more DOIs than are printed as visible text.
 *
 * Publisher-dependent: strong for APS/Nature/AIP/IOP, weak elsewhere.
 */
module.exports.id = register({
	id: 'pdf-links',
	label: 'DOI hyperlinks in PDF',
	requiresNetwork: false,
	defaultEnabled: true,
	defaultConfidence: 0.95,
	options: {
		// A PDF whose only DOI link is its own is publisher boilerplate, not a
		// bibliography; 34 of 334 sample PDFs looked like that.
		ignoreSelfOnly: true,
	},

	async *derive({ adapter, items, index, options, includeExternal, onProgress }) {
		let done = 0;
		for (const item of items) {
			onProgress && onProgress(++done, items.length, item.key);
			const atts = await adapter.getAttachments(item.key);
			for (const att of atts) {
				if (att.contentType !== 'application/pdf') continue;
				const uris = await adapter.getPdfLinkUris(att.key);
				if (!uris.length) continue;

				const dois = new Set();
				for (const u of uris) {
					const d = normDoi((u.match(/10\.\d{4,9}\/[-._;()\/:a-zA-Z0-9]+/) || [])[0]);
					if (d) dois.add(d);
				}
				if (options.ignoreSelfOnly && dois.size === 1
						&& index.lookupDoi([...dois][0]) === item.key) {
					continue;
				}
				for (const d of dois) {
					const target = index.lookupDoi(d);
					if (target) {
						if (target !== item.key) {
							yield edge(item.key, target, 'pdf-links', 0.95, { doi: d, attachment: att.key });
						}
					}
					else if (includeExternal) {
						// A cited work we do not hold. The DOI is all there is --
						// resolving it to a title would need the network.
						yield edge(item.key, externalKey('doi', d), 'pdf-links', 0.95,
							{ doi: d, attachment: att.key, external: true });
					}
				}
			}
		}
	},
});
