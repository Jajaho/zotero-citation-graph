'use strict';

const registry = require('./registry');
const { CollectionIndex } = require('./collectionIndex');
const { edgeKey } = require('./types');

/**
 * Runs the selected providers and merges their output into one graph.
 *
 * Merge policy: an edge produced by several providers is kept once, with
 * `confidence` = the maximum any provider assigned and `via` listing all of
 * them. Provenance is never collapsed -- the UI needs it to explain an edge,
 * to style inferred edges differently from publisher-asserted ones, and to let
 * a user disable a noisy strategy without re-deriving everything else.
 */
async function build(adapter, config = {}) {
	const t0 = Date.now();
	const { providers, skippedForOffline } = registry.select(config);

	const items = await adapter.listItems();
	const index = new CollectionIndex(items, { minTitleLength: config.minTitleLength });

	/** @type {Map<string, import('./types').MergedEdge>} */
	const merged = new Map();
	const perProvider = {};
	const errors = [];

	for (const p of providers) {
		const started = Date.now();
		let produced = 0;
		let unique = 0;
		try {
			const ctx = {
				adapter,
				items,
				index,
				options: p.options,
				signal: config.signal,
				onProgress: (done, total, note) =>
					config.onProgress && config.onProgress({ provider: p.id, done, total, note }),
			};
			const out = await p.derive(ctx);
			for await (const e of toAsyncIterable(out)) {
				if (!e || !e.from || !e.to || e.from === e.to) continue;
				if (!index.byKey.has(e.from) || !index.byKey.has(e.to)) continue;
				produced++;
				const k = edgeKey(e.from, e.to);
				const conf = e.confidence != null ? e.confidence : p.defaultConfidence;
				const prev = merged.get(k);
				if (prev) {
					prev.confidence = Math.max(prev.confidence, conf);
					if (!prev.via.includes(e.via || p.id)) prev.via.push(e.via || p.id);
					if (e.evidence) prev.evidence.push({ via: e.via || p.id, ...e.evidence });
				}
				else {
					unique++;
					merged.set(k, {
						from: e.from,
						to: e.to,
						confidence: conf,
						via: [e.via || p.id],
						evidence: e.evidence ? [{ via: e.via || p.id, ...e.evidence }] : [],
					});
				}
			}
		}
		catch (err) {
			// One failing strategy must not lose the others' work.
			errors.push({ provider: p.id, message: err && err.message });
		}
		perProvider[p.id] = { produced, newEdges: unique, ms: Date.now() - started };
	}

	const edges = [...merged.values()];
	const nodes = new Set();
	for (const e of edges) { nodes.add(e.from); nodes.add(e.to); }

	return {
		items,
		edges,
		nodeKeys: [...nodes],
		index,
		meta: {
			ran: providers.map((p) => p.id),
			skippedForOffline,
			perProvider,
			errors,
			indexStats: index.stats(),
			ms: Date.now() - t0,
		},
	};
}

/** Accept a provider returning an array, a promise, or an async generator. */
async function* toAsyncIterable(v) {
	if (!v) return;
	if (typeof v[Symbol.asyncIterator] === 'function') { yield* v; return; }
	for (const x of await v) yield x;
}

/**
 * Post-hoc filter, so the UI can re-scope an already-built graph without
 * re-running any provider. This is what a strategy toggle in the settings pane
 * should call first -- only fall back to a rebuild if the user enables a
 * provider that has not run yet.
 */
function filterEdges(edges, { minConfidence = 0, via = null, excludeVia = [] } = {}) {
	return edges.filter((e) => {
		if (e.confidence < minConfidence) return false;
		if (via && !e.via.some((v) => via.includes(v))) return false;
		if (excludeVia.length && e.via.every((v) => excludeVia.includes(v))) return false;
		return true;
	});
}

module.exports = { build, filterEdges };
