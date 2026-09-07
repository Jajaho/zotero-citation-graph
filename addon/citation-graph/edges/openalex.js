'use strict';

const { register } = require('../core/registry');
const { edge } = require('../core/types');
const { normDoi } = require('../core/normalize');

/**
 * Strategy: OpenAlex `referenced_works`.
 *
 * The one network-dependent provider wired up so far, kept as an *enrichment*
 * layer rather than the default. On the sample library it produced 259
 * in-collection edges to the offline stack's 260 -- but only 177 were shared,
 * so the union beat either alone by 32%. That complementarity is the reason to
 * keep it switchable rather than pick a winner.
 *
 * Cost: one list call per 50 items (1 credit each). A 500-item collection is
 * ~10 calls. OpenAlex has required an API key since Feb 2026; anonymous access
 * still works at a tenth of the free daily allowance.
 */
module.exports.id = register({
	id: 'openalex',
	label: 'OpenAlex referenced_works',
	requiresNetwork: true,
	defaultEnabled: false,       // opt-in: the offline stack is the default
	defaultConfidence: 0.98,
	options: {
		apiKey: null,
		mailto: null,            // polite-pool identification
		batchSize: 50,
		endpoint: 'https://api.openalex.org/works',
	},

	async derive({ items, index, options, onProgress }) {
		const dois = [];
		const keyByDoi = new Map();
		for (const it of items) {
			const d = normDoi(it.doi);
			if (d && !keyByDoi.has(d)) { keyByDoi.set(d, it.key); dois.push(d); }
		}
		if (!dois.length) return [];

		const works = [];
		for (let i = 0; i < dois.length; i += options.batchSize) {
			const batch = dois.slice(i, i + options.batchSize);
			const url = new URL(options.endpoint);
			url.searchParams.set('per-page', String(options.batchSize));
			url.searchParams.set('select', 'id,doi,referenced_works');
			url.searchParams.set('filter', 'doi:' + batch.join('|'));
			if (options.mailto) url.searchParams.set('mailto', options.mailto);
			if (options.apiKey) url.searchParams.set('api_key', options.apiKey);

			const res = await fetch(url, { headers: { Accept: 'application/json' } });
			if (!res.ok) throw new Error(`OpenAlex ${res.status} ${res.statusText}`);
			const json = await res.json();
			if (json.results) works.push(...json.results);
			onProgress && onProgress(Math.min(i + options.batchSize, dois.length), dois.length);
		}

		// Register OpenAlex IDs on the shared index so other providers (and a
		// later ghost-node expansion) can reuse the resolution.
		for (const w of works) {
			const k = keyByDoi.get(normDoi(w.doi));
			if (k) index.setExternal('openalex', w.id, k);
		}

		const out = [];
		for (const w of works) {
			const from = keyByDoi.get(normDoi(w.doi));
			if (!from) continue;
			for (const ref of w.referenced_works || []) {
				const to = index.lookupExternal('openalex', ref);
				if (to && to !== from) {
					out.push(edge(from, to, 'openalex', 0.98, { openalexId: ref }));
				}
			}
		}
		return out;
	},
});
