'use strict';

const enrichRegistry = require('./enrichRegistry');
const { parseExternalKey } = require('./types');

/**
 * Which Metadata fields the fill-first merge carries. `key` is the identity and
 * `source` is provenance, so neither is merged.
 */
const FIELDS = ['title', 'creators', 'year', 'itemType', 'doi', 'url', 'citedByGlobal'];

/**
 * Resolve identifiers to names, running the selected enrichers in order.
 *
 * Merge policy is FILL-FIRST, per field: the first enricher to produce a
 * non-null value for a field wins it, and later enrichers only fill what is
 * still missing. That is what makes a second API worth adding -- OpenAlex names
 * most DOIs, and a Crossref or Semantic Scholar enricher behind it would be
 * asked only about the tail it could not resolve, not about all of them again.
 *
 * The corollary is that ORDER IS THE RANKING. Put the enricher you trust most
 * first; there is no confidence score here, unlike edges, because a title is
 * either right or wrong and two sources disagreeing about one is a data bug
 * rather than something to average.
 *
 * @param {(string|{key:string,ns:string,id:string})[]} keys
 *        External node keys ('doi:10.1038/nature12373'), or pre-parsed refs.
 * @param {Object} [config]  enable/disable/offline/providers, as registry.select
 * @param {Function} [config.onProgress]  ({ provider, done, total }) => void
 * @returns {Promise<{metadata: Object<string, Metadata>, meta: Object}>}
 */
async function enrich(keys, config = {}) {
	const t0 = Date.now();
	const { providers, skippedForOffline } = enrichRegistry.select(config);

	/** @type {Object<string, import('./types').Metadata>} */
	const metadata = Object.create(null);
	const perProvider = {};
	const errors = [];

	const allRefs = [];
	const seen = new Set();
	for (const k of keys) {
		const ref = typeof k === 'string' ? withKey(k) : k;
		if (!ref || seen.has(ref.key)) continue;
		seen.add(ref.key);
		allRefs.push(ref);
	}

	for (const p of providers) {
		const started = Date.now();
		// Only refs this enricher can address, and only those still missing
		// something -- the second half is the whole point of the chain.
		const refs = allRefs.filter(r =>
			p.supports.includes(r.ns) && !isComplete(metadata[r.key]));
		let resolved = 0;
		if (refs.length) {
			try {
				const out = await p.resolve({
					refs,
					options: p.options,
					signal: config.signal,
					onProgress: (done, total, note) =>
						config.onProgress && config.onProgress({ provider: p.id, done, total, note }),
				});
				for (const m of out || []) {
					if (!m || !m.key || !seen.has(m.key)) continue;
					if (mergeInto(metadata, m, p.id)) resolved++;
				}
			}
			catch (err) {
				// One failing enricher must not lose the others' work, and must
				// not lose the graph either -- names are a nicety, edges are not.
				errors.push({ provider: p.id, message: err && err.message });
			}
		}
		perProvider[p.id] = { asked: refs.length, resolved, ms: Date.now() - started };
	}

	return {
		metadata,
		meta: {
			ran: providers.map(p => p.id),
			skippedForOffline,
			perProvider,
			errors,
			requested: allRefs.length,
			resolved: Object.keys(metadata).length,
			ms: Date.now() - t0,
		},
	};
}

/** Parse a key into a ref, dropping anything that is not a namespaced key. */
function withKey(key) {
	const parsed = parseExternalKey(key);
	return parsed ? { key, ns: parsed.ns, id: parsed.id } : null;
}

/**
 * Enough to stop asking. A title is the point of the exercise; a citation count
 * without one is not worth a second round trip, but a title without a count is
 * still worth completing, so both are required.
 */
function isComplete(m) {
	return !!(m && m.title && m.citedByGlobal != null);
}

/** @returns {boolean} whether anything was actually added. */
function mergeInto(metadata, m, providerId) {
	let target = metadata[m.key];
	if (!target) {
		target = metadata[m.key] = { key: m.key, source: [] };
	}
	let changed = false;
	for (const f of FIELDS) {
		if (m[f] == null || target[f] != null) continue;
		// An empty creators array carries no more information than a null and
		// would block a later enricher that does know the authors.
		if (Array.isArray(m[f]) && !m[f].length) continue;
		target[f] = m[f];
		changed = true;
	}
	if (changed && !target.source.includes(providerId)) target.source.push(providerId);
	return changed;
}

module.exports = { enrich, FIELDS };
