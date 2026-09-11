'use strict';

const registry = require('./registry');
const { CollectionIndex } = require('./collectionIndex');
const { edgeKey, isExternalKey, parseExternalKey } = require('./types');
const { segment } = require('../edges/refSection');
const { refSignature } = require('../edges/refParse');

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
	// the section is kept, not the whole document text it came from, and the
	// cache dies with this call -- the pdf-links pass is a separate build() and
	// never asks.
	//
	// Both forms of the section are kept. `flat` is what the two DOI and title
	// strategies scan, with line wrapping undone; `text` keeps the line breaks,
	// because ref-strings divides the section into entries and every signal
	// that tells one entry from the next -- a leading marker, a hanging indent,
	// a blank line -- lives in exactly the structure flattening destroys.
	const sections = new Map();
	const refSection = (attKey) => {
		let s = sections.get(attKey);
		if (!s) {
			s = adapter.getAttachmentText(attKey).then((text) => {
				if (!text) return null;
				const seg = segment(text);
				return { text: seg.text, flat: seg.flat, quality: seg.quality };
			});
			sections.set(attKey, s);
		}
		return s;
	};

	// What a provider knows about a node it invented. Only ever written for
	// external keys, and only by a provider that HAS metadata to offer -- which
	// today means ref-strings, whose nodes are identified by a parsed title and
	// would otherwise reach the UI with nothing to draw. The alternative was to
	// widen Edge.evidence and have collectExternalNodes hoist it, which
	// conflates "why this edge exists" with "what this node is".
	/** @type {Object<string, Object>} */
	const described = Object.create(null);
	// First writer wins, matching enrich.js's fill-first rule: two PDFs citing
	// one work parse it independently, and the second reading is no better than
	// the first.
	const describe = (key, meta) => {
		if (key && meta && !described[key]) described[key] = { key, ...meta };
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
				describe,
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
		// Keyed like externalNodes, but deliberately not folded into them: the
		// roll-up is recomputed on every push from the current edge list, while
		// these are derived once and have to survive that.
		described,
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

// Which key wins when several name one work. Lower is better: a node the
// library holds beats any outside reference, and among those a registered
// identifier beats a slug of a parsed title.
const KEY_RANK = { '': 0, doi: 1, arxiv: 2, openalex: 3, ref: 4 };

/**
 * Fold nodes that different strategies identified differently into one.
 *
 * The problem this exists for: one paper prints a DOI for a reference and
 * another does not, so the same work becomes `doi:10.1038/nature12373` from the
 * first and `ref:nanometre-scale-thermometry-in-a-living-cell` from the second
 * -- two nodes cited once each, where the truth is one node cited twice. Since
 * citedBy is what decides whether a ghost is drawn at all, the split does not
 * merely duplicate a node, it can hide one.
 *
 * Keyed on the title, through refSignature, so the rule is exactly the one that
 * made the `ref:` key in the first place -- a work cannot fail to match itself.
 * It works offline because ref-strings names the `doi:` nodes it finds as well
 * as the `ref:` ones; with the metadata lookup on, the enriched titles come
 * through the same `titleOf` and fold in OpenAlex's nodes too.
 *
 * A held item is never re-keyed, only ever re-keyed ONTO: two papers in the
 * library sharing a title are two items, and merging them would delete one.
 *
 * @param {MergedEdge[]} edges
 * @param {Object} ctx
 * @param {(key: string) => boolean} ctx.isInCollection
 * @param {(key: string) => ?{title: ?string}} ctx.titleOf  metadata for any node key
 * @param {import('./types').Item[]} [ctx.items]  held items, to fold ghosts onto
 * @returns {{edges: MergedEdge[], moved: Object<string, string>}}
 */
function consolidateByTitle(edges, { isInCollection, titleOf, items = [] }) {
	const best = new Map();
	const offer = (slug, key, rank) => {
		if (!slug) return;
		const prev = best.get(slug);
		if (!prev || rank < prev.rank) best.set(slug, { key, rank });
	};

	for (const it of items) offer(titleSlug(it.title), it.key, 0);
	const seen = new Set();
	for (const e of edges) {
		const key = e.to;
		if (seen.has(key) || isInCollection(key)) continue;
		seen.add(key);
		const parsed = parseExternalKey(key);
		if (!parsed) continue;
		const m = titleOf(key);
		offer(titleSlug(m && m.title), key, KEY_RANK[parsed.ns] != null ? KEY_RANK[parsed.ns] : 9);
	}

	/** @type {Object<string, string>} */
	const moved = Object.create(null);
	for (const key of seen) {
		const m = titleOf(key);
		const slug = titleSlug(m && m.title);
		const winner = slug && best.get(slug);
		if (winner && winner.key !== key) moved[key] = winner.key;
	}
	if (!Object.keys(moved).length) return { edges, moved };

	const rekeyed = edges
		.map(e => (moved[e.to] ? { ...e, to: moved[e.to] } : e))
		.filter(e => e.from !== e.to);
	return { edges: mergeMerged(rekeyed), moved };
}

/** The same slug refSignature mints, so a `ref:` node matches its own key. */
function titleSlug(title) {
	return title ? refSignature({ title }) : null;
}

/**
 * Re-merge already-merged edges after a re-key, which can collide two of them
 * onto one pair. Same policy as the build loop: confidence is the max, and
 * provenance is never dropped.
 */
function mergeMerged(edges) {
	const out = new Map();
	for (const e of edges) {
		const k = edgeKey(e.from, e.to);
		const prev = out.get(k);
		if (!prev) {
			out.set(k, { ...e, via: [...e.via], evidence: [...(e.evidence || [])] });
			continue;
		}
		prev.confidence = Math.max(prev.confidence, e.confidence);
		for (const v of e.via) if (!prev.via.includes(v)) prev.via.push(v);
		if (e.evidence) prev.evidence.push(...e.evidence);
	}
	return [...out.values()];
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

module.exports = { build, filterEdges, collectExternalNodes, consolidateByTitle };
