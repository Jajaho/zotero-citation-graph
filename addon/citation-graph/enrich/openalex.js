'use strict';

const { register } = require('../core/enrichRegistry');
const { normDoi } = require('../core/normalize');

/**
 * Enricher: OpenAlex /works.
 *
 * Chosen as the first one because a single list call answers all three
 * questions we have about a cited work -- what is it called, who wrote it, and
 * how often is it cited -- in one response:
 *
 *   filter=doi:a|b|...  select=id,doi,display_name,publication_year,
 *                              authorships,cited_by_count,type,primary_location
 *
 * 50 DOIs per call. The sample library's 4,564 ghost DOIs are 92 calls; at the
 * post-Feb-2026 pricing of 10 credits per list request that is 920 credits,
 * inside even the keyless daily allowance.
 *
 * AUTH, as of 13 Feb 2026: `mailto` and the polite pool are gone -- the
 * parameter is ignored by the server -- and requests are billed against an API
 * key. Keyless access still works at roughly a tenth of the daily budget, which
 * is why this is usable with no configuration at all. The key travels in an
 * Authorization header rather than the query string so it stays out of URLs,
 * logs and thrown error messages.
 */
module.exports.id = register({
	id: 'openalex',
	label: 'OpenAlex (names + citation counts)',
	requiresNetwork: true,
	defaultEnabled: false,
	supports: ['doi', 'openalex'],
	options: {
		apiKey: null,
		batchSize: 50,
		endpoint: 'https://api.openalex.org/works',
		// Injected so the caller can supply a host-appropriate transport --
		// Zotero.HTTP.request honours the client's proxy and offline settings,
		// where bare fetch does not -- and so the tests can run without network.
		fetchImpl: null,
	},

	async resolve({ refs, options, signal, onProgress }) {
		const fetch_ = options.fetchImpl || globalThis.fetch;
		if (typeof fetch_ !== 'function') throw new Error('no fetch implementation available');

		// OpenAlex filters by bare DOI but returns it as a resolver URL, so both
		// directions go through normDoi and the round trip stays lossless.
		const byFilterValue = new Map();
		for (const r of refs) {
			if (r.ns === 'doi') {
				const d = normDoi(r.id);
				if (d) byFilterValue.set('doi:' + d, r.key);
			}
			else if (r.ns === 'openalex') {
				byFilterValue.set('openalex:' + shortOpenAlexId(r.id), r.key);
			}
		}
		const values = [...byFilterValue.keys()];
		if (!values.length) return [];

		const headers = { Accept: 'application/json' };
		if (options.apiKey) headers.Authorization = 'Bearer ' + options.apiKey;

		const out = [];
		for (let i = 0; i < values.length; i += options.batchSize) {
			if (signal && signal.aborted) break;
			const batch = values.slice(i, i + options.batchSize);

			// One filter key per namespace: OpenAlex ORs values within a key with
			// '|' but ANDs across keys, so mixing doi: and openalex: into a single
			// filter would ask for works that are both at once and return nothing.
			const byNs = new Map();
			for (const v of batch) {
				const c = v.indexOf(':');
				const ns = v.slice(0, c);
				const id = v.slice(c + 1);
				if (!byNs.has(ns)) byNs.set(ns, []);
				byNs.get(ns).push(id);
			}

			for (const [ns, ids] of byNs) {
				const url = new URL(options.endpoint);
				url.searchParams.set('per-page', String(Math.max(ids.length, 1)));
				url.searchParams.set('select',
					'id,doi,display_name,publication_year,authorships,cited_by_count,type');
				url.searchParams.set('filter',
					(ns === 'doi' ? 'doi:' : 'ids.openalex:') + ids.join('|'));

				const res = await fetch_(url.toString(), { headers, signal });
				if (!res.ok) throw new Error(`OpenAlex ${res.status} ${res.statusText}`);
				const json = await res.json();
				for (const w of (json && json.results) || []) {
					const m = toMetadata(w, byFilterValue);
					if (m) out.push(m);
				}
			}
			onProgress && onProgress(Math.min(i + options.batchSize, values.length), values.length);
		}
		return out;
	},
});

/**
 * An OpenAlex work back into the shape core/enrich.js merges. Only the fields
 * we actually know are set: a null lets a later enricher in the chain fill it.
 */
function toMetadata(w, byFilterValue) {
	if (!w) return null;
	const doi = normDoi(w.doi);
	// Match on whichever identifier we asked by. The response carries both, so a
	// work requested by OpenAlex ID still resolves if only its DOI was keyed.
	const key = (doi && byFilterValue.get('doi:' + doi))
		|| (w.id && byFilterValue.get('openalex:' + shortOpenAlexId(w.id)))
		|| null;
	if (!key) return null;

	return {
		key,
		title: w.display_name || null,
		creators: (w.authorships || [])
			.map(a => surname(a && a.author && a.author.display_name))
			.filter(Boolean),
		year: w.publication_year != null ? Number(w.publication_year) : null,
		itemType: w.type || null,
		doi: doi || null,
		url: w.id || null,
		// Deliberately NOT called citedBy: externalNodes[].citedBy already means
		// "how many papers in this collection cite it", which is a different
		// number and the one the graph is actually about.
		citedByGlobal: w.cited_by_count != null ? Number(w.cited_by_count) : null,
	};
}

/** 'https://openalex.org/W123' | 'W123' -> 'W123' */
function shortOpenAlexId(id) {
	const s = String(id || '');
	const slash = s.lastIndexOf('/');
	return slash >= 0 ? s.slice(slash + 1) : s;
}

/**
 * OpenAlex gives full display names ("Georg Kucsko"); the rest of the graph
 * labels nodes by surname, so take the last whitespace-separated word. Wrong
 * for a handful of multi-word surnames, and still better than a first name.
 */
function surname(displayName) {
	const parts = String(displayName || '').trim().split(/\s+/);
	return parts.length ? parts[parts.length - 1] : '';
}

module.exports.toMetadata = toMetadata;
module.exports.surname = surname;
