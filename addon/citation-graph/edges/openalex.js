'use strict';

const { register } = require('../core/registry');
const { edge, externalKey } = require('../core/types');
const { normDoi } = require('../core/normalize');
const { toMetadata } = require('../enrich/openalex');

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
		// {get, set} over 'doi:<doi>' -> { id, refs }: each held paper's OpenAlex
		// ID and reference list. A published paper's references do not change, so
		// a paper is asked about once and then again only when the cache ages its
		// answer out -- a warm build makes no request at all. A DOI OpenAlex does
		// not know is remembered as { id: null, refs: [] }, so it is not asked
		// about on every build either.
		cache: null,
		// {set}: where the held papers' own names and counts go. They come back in
		// the same response for the price of naming the fields, so they are kept
		// for the metadata lookup to find rather than asked for twice. Kept, not
		// shown: whether anything is named is that lookup's decision.
		metadataCache: null,
	},

	async derive({ items, index, options, includeExternal, onProgress }) {
		const keyByDoi = new Map();
		for (const it of items) {
			const d = normDoi(it.doi);
			if (d && !keyByDoi.has(d)) keyByDoi.set(d, it.key);
		}
		if (!keyByDoi.size) return [];

		// Every held paper is needed, not only the ones whose references are
		// wanted: a reference arrives as an OpenAlex ID, and resolves to a held
		// paper only if that paper's own ID is known.
		const works = new Map();
		const ask = [];
		for (const d of keyByDoi.keys()) {
			const hit = options.cache && options.cache.get(externalKey('doi', d));
			if (hit) works.set(d, hit);
			else ask.push(d);
		}

		if (ask.length) {
			const fetch_ = options.fetchImpl || globalThis.fetch;
			if (typeof fetch_ !== 'function') throw new Error('no fetch implementation available');
			const headers = { Accept: 'application/json' };
			if (options.apiKey) headers.Authorization = 'Bearer ' + options.apiKey;

			for (let i = 0; i < ask.length; i += options.batchSize) {
				const batch = ask.slice(i, i + options.batchSize);
				const url = new URL(options.endpoint);
				url.searchParams.set('per-page', String(options.batchSize));
				url.searchParams.set('select', 'id,doi,referenced_works,'
					+ 'display_name,publication_year,authorships,cited_by_count,type');
				url.searchParams.set('filter', 'doi:' + batch.join('|'));

				const res = await fetch_(url.toString(), { headers });
				if (!res.ok) throw new Error(`OpenAlex ${res.status} ${res.statusText}`);
				const json = await res.json();
				const answered = new Set();
				for (const w of (json && json.results) || []) {
					const d = normDoi(w.doi);
					if (!d || !keyByDoi.has(d)) continue;
					answered.add(d);
					const key = externalKey('doi', d);
					const entry = { id: w.id || null, refs: w.referenced_works || [] };
					works.set(d, entry);
					if (options.cache) options.cache.set(key, entry);
					if (options.metadataCache) {
						// Only a complete answer, by the same rule core/enrich.js
						// writes the cache by: a half one would stop the lookup
						// from ever completing it.
						const m = toMetadata(w, new Map([[key, key]]));
						if (m && m.title) options.metadataCache.set(key, m);
					}
				}
				for (const d of batch) {
					if (answered.has(d)) continue;
					const entry = { id: null, refs: [] };
					works.set(d, entry);
					if (options.cache) options.cache.set(externalKey('doi', d), entry);
				}
				onProgress && onProgress(Math.min(i + options.batchSize, ask.length), ask.length);
			}
		}

		// Register OpenAlex IDs on the shared index so other providers (and a
		// later ghost-node expansion) can reuse the resolution.
		for (const [d, w] of works) {
			if (w.id) index.setExternal('openalex', w.id, keyByDoi.get(d));
		}

		const out = [];
		for (const [d, w] of works) {
			const from = keyByDoi.get(d);
			for (const ref of w.refs) {
				const to = index.lookupExternal('openalex', ref);
				if (to) {
					if (to !== from) out.push(edge(from, to, 'openalex', 0.98, { openalexId: ref }));
				}
				else if (includeExternal) {
					// A cited work the collection does not hold, known only by its
					// OpenAlex ID. Naming it -- which also brings its DOI, and with
					// that the node the same work has when a PDF links it -- is the
					// metadata lookup's to do, and only when it is switched on.
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
