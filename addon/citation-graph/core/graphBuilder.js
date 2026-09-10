'use strict';

const registry = require('./registry');
const { CollectionIndex } = require('./collectionIndex');
const { edgeKey, isExternalKey, parseExternalKey } = require('./types');
const { segment } = require('../edges/refSection');

/**
 * Runs the selected providers and merges their output into one graph.
 *
 * Merge policy: an edge produced by several providers is kept once, with
 * `confidence` = the maximum any provider assigned and `via` listing all of
 * them. Provenance is never collapsed -- the UI needs it to explain an edge,
 * to style inferred edges differently from publisher-asserted ones, and to let
 * a user disable a noisy strategy without re-deriving everything else.
 *
 * `config.includeExternal` additionally keeps edges pointing at works that are
 * NOT in the collection, as namespaced keys (see types.js externalKey). They
 * are reported separately in `externalNodes` with a citedBy count, because
 * there are far too many to show unfiltered -- 4,564 distinct DOIs across 127
 * PDFs on the sample library. The count is the useful filter: a work several of
 * your papers cite but you do not hold is a gap; one cited once is noise.
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

	// Each attachment's reference section, read and segmented once for the
	// whole build. text-doi and title-match run back to back over the same
	// attachments, and each used to read the file and segment it again. Only
	// the section is kept, not the text it came from, and the cache dies with
	// this call -- the pdf-links pass is a separate build() and never asks.
	const sections = new Map();
	const refSection = (attKey) => {
		let s = sections.get(attKey);
		if (!s) {
			s = adapter.getAttachmentText(attKey).then((text) => {
				if (!text) return null;
				const seg = segment(text);
				return { flat: seg.flat, quality: seg.quality };
			});
			sections.set(attKey, s);
		}
		return s;
	};

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
				// Global rather than per-provider: it changes what the graph *is*,
				// not how one strategy behaves. Providers that cannot produce
				// external targets (title-match searches for titles it already
				// knows) simply ignore it.
				includeExternal: !!config.includeExternal,
				signal: config.signal,
				refSection,
				onProgress: (done, total, note) =>
					config.onProgress && config.onProgress({ provider: p.id, done, total, note }),
			};
			const out = await p.derive(ctx);
			for await (const e of toAsyncIterable(out)) {
				if (!e || !e.from || !e.to || e.from === e.to) continue;
				// The citing side must always be a real collection item -- an edge
				// between two works we do not hold says nothing about this library.
				if (!index.byKey.has(e.from)) continue;
				if (!index.byKey.has(e.to)
						&& !(config.includeExternal && isExternalKey(e.to))) {
					continue;
				}
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
	const externalNodes = collectExternalNodes(edges, k => index.byKey.has(k));

	return {
		items,
		edges,
		externalNodes,
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

/**
 * Roll edges pointing outside the collection up into one node each.
 *
 * Exported because a caller that stitches several build() results together (the
 * plugin runs the fast text strategies and the slow PDF scan as separate
 * builds) has to recompute this over the combined edge list -- summing two
 * builds' counts would double-count a work both strategies found.
 *
 * @param {import('./types').MergedEdge[]} edges
 * @param {(key: string) => boolean} isInCollection
 */
function collectExternalNodes(edges, isInCollection) {
	const externals = new Map();
	for (const e of edges) {
		if (isInCollection(e.to)) continue;
		let x = externals.get(e.to);
		if (!x) {
			const parsed = parseExternalKey(e.to) || { ns: '', id: e.to };
			x = { key: e.to, ns: parsed.ns, id: parsed.id, citedBy: 0, citedByKeys: [], confidence: 0, via: [] };
			externals.set(e.to, x);
		}
		// Edges are already unique per ordered pair, so one edge is one citer.
		x.citedBy++;
		x.citedByKeys.push(e.from);
		x.confidence = Math.max(x.confidence, e.confidence);
		for (const v of e.via) if (!x.via.includes(v)) x.via.push(v);
	}
	// Most-cited first: the head of this list is "works several of your papers
	// cite but you do not hold", which is the reason to compute it at all.
	return [...externals.values()].sort((a, b) => b.citedBy - a.citedBy);
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

module.exports = { build, filterEdges, collectExternalNodes };
