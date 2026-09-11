'use strict';

const { register } = require('../core/registry');
const { edge, externalKey } = require('../core/types');
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
 * Cost: one list call per 50 items (10 credits each, post-Feb-2026 pricing). A
 * 500-item collection is ~10 calls. OpenAlex has required an API key since
 * 13 Feb 2026; anonymous access still works at a tenth of the free daily
 * allowance, which is why this runs without configuration.
 *
 * The `mailto` polite-pool parameter was removed on the same date and is now
 * ignored by the server, so it is not sent. The key goes in an Authorization
 * header rather than the query string to keep it out of URLs and error text.
 */
module.exports.id = register({
	id: 'openalex',
	label: 'OpenAlex referenced_works',
	requiresNetwork: true,
	defaultEnabled: false,       // opt-in: the offline stack is the default
	defaultConfidence: 0.98,
	options: {
		apiKey: null,
		batchSize: 50,
		endpoint: 'https://api.openalex.org/works',
		fetchImpl: null,         // see enrich/openalex.js for why this is injectable
		// Item keys whose references to report; null reports every item's.
		// Every item with a DOI is still ASKED about, because a reference
		// arrives as an OpenAlex ID and resolves to a held paper only if that
		// paper's own ID came back too -- asking about the citing papers alone
		// would turn every reference to the collection into a ghost of itself.
		citing: null,
	},

	async derive({ items, index, options, includeExternal, onProgress }) {
		const dois = [];
		const keyByDoi = new Map();
		for (const it of items) {
			const d = normDoi(it.doi);
			if (d && !keyByDoi.has(d)) { keyByDoi.set(d, it.key); dois.push(d); }
		}
		if (!dois.length) return [];
		const only = options.citing ? new Set(options.citing) : null;

		const fetch_ = options.fetchImpl || globalThis.fetch;
		if (typeof fetch_ !== 'function') throw new Error('no fetch implementation available');
		const headers = { Accept: 'application/json' };
		if (options.apiKey) headers.Authorization = 'Bearer ' + options.apiKey;

		const works = [];
		for (let i = 0; i < dois.length; i += options.batchSize) {
			const batch = dois.slice(i, i + options.batchSize);
			const url = new URL(options.endpoint);
			url.searchParams.set('per-page', String(options.batchSize));
			url.searchParams.set('select', 'id,doi,referenced_works');
			url.searchParams.set('filter', 'doi:' + batch.join('|'));

			const res = await fetch_(url.toString(), { headers });
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
			if (!from || (only && !only.has(from))) continue;
			for (const ref of w.referenced_works || []) {
				const to = index.lookupExternal('openalex', ref);
				if (to) {
					if (to !== from) out.push(edge(from, to, 'openalex', 0.98, { openalexId: ref }));
				}
				else if (includeExternal) {
					// A cited work the collection does not hold, known only by its
					// OpenAlex ID until a lookup names it -- which brings its DOI,
					// and with that the node the same work has when a PDF links it.
					out.push(edge(from, externalKey('openalex', shortId(ref)), 'openalex', 0.98,
						{ openalexId: ref, external: true }));
				}
			}
		}
		return out;
	},
});

/** 'https://openalex.org/W123' | 'W123' -> 'W123' */
function shortId(id) {
	const s = String(id || '');
	return s.slice(s.lastIndexOf('/') + 1);
}
