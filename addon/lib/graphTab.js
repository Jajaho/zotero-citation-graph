/* global Zotero, console */

/**
 * Tab creation, the chrome<->content bridge, and the phased graph build.
 *
 * Mirrors core's ReaderTab (xpcom/reader.js:1976-2090): Zotero_Tabs.add() returns
 * a <tab-content> container, we append a <browser type="content">, wait for
 * DOMContentLoaded filtered to that browser's document, then poll until the page
 * has published its API.
 *
 * Payloads cross the privilege boundary as JSON *strings*. A string is a
 * primitive, so it needs no Cu.cloneInto, no Xray waiver and no structured-clone
 * of nested objects -- which removes the fiddliest part of the integration.
 */

let cg = require('../citation-graph/index.js');
let { ZoteroAdapter } = require('./zoteroAdapter.js');
let { PdfLinkCache } = require('./pdfLinkCache.js');
let { MetadataCache } = require('./metadataCache.js');
let { normDoi } = require('../citation-graph/core/normalize.js');
let { externalKey } = require('../citation-graph/core/types.js');

// Ordered fastest-first. Every EDGE strategy here is offline; `openalex` is
// registered but never selected, so no edge build reaches the network. The
// separate enrichment phase does, but only when the user has switched it on.
const TEXT_STRATEGIES = ['text-doi', 'title-match'];
const PDF_STRATEGIES = ['pdf-links'];

// Ghosts to name, most-locally-cited first. The payload cap below is 4,000, and
// enriching all of them would be 80 sequential OpenAlex calls for a tail that
// the default "cited by >= 2" filter hides anyway. Ghosts past this point keep
// their DOI label, which is exactly what they had before enrichment existed.
const MAX_ENRICH = 500;

// Ordered: core/enrich.js merges fill-first, so this list IS the ranking. A
// second enricher added here is only ever asked about what the first could not
// resolve. See docs/external-references.md part 3. Overridable by the
// zoteroGraph.enrichers pref; see enricherList().
const ENRICHERS = ['openalex'];

// External nodes are unbounded in principle -- 4,564 distinct DOIs across 127
// PDFs on the sample library, nearly all cited exactly once. The renderer's
// min-citations control does the real filtering; this only stops a pathological
// payload from crossing the bridge. Sorted most-cited first, so the cut only
// ever loses singletons.
const MAX_EXTERNAL_NODES = 4000;

// Rebuild-triggering options. Everything else the toolbar offers is a filter
// over an already-built graph and never comes back to chrome.
//
// `enrich` defaults to off: until this feature the plugin could not reach the
// network at all, and that is not a property to drop silently.
const DEFAULT_OPTIONS = { recursive: false, includeExternal: true, enrich: false };

let open_ = new Map(); // tabID -> { win, browser, collection, generation, options }

async function open(win, collection, config) {
	let title = 'Citation Graph — ' + collection.name;

	let { id, container } = win.Zotero_Tabs.add({
		// No hyphen: tabs.js parseTabType() splits the type on '-' to separate
		// the content type from the '-unloaded' state suffix.
		type: 'graph',
		title,
		data: { collectionKey: collection.key, libraryID: collection.libraryID },
		select: true,
		onClose: () => {
			open_.delete(id);
		},
	});

	let browser = win.document.createXULElement('browser');
	browser.setAttribute('class', 'zotero-graph');
	browser.setAttribute('flex', '1');
	browser.setAttribute('type', 'content');
	browser.setAttribute('transparent', 'true');
	browser.setAttribute('src', `resource://${config.resRoot}/content/graph.html`);
	container.appendChild(browser);

	open_.set(id, { win, browser, collection, generation: 0, options: { ...DEFAULT_OPTIONS } });

	let onDOMContentLoaded = (event) => {
		if (browser.contentWindow && browser.contentWindow.document === event.target) {
			win.removeEventListener('DOMContentLoaded', onDOMContentLoaded);
			ready(win, id, browser.contentWindow, collection).catch(e => Zotero.logError(e));
		}
	};
	win.addEventListener('DOMContentLoaded', onDOMContentLoaded);
}

async function ready(win, tabID, cw, collection) {
	cw.addEventListener('error', e => Zotero.logError(e.error));

	// The content page defines window.zgSetData synchronously as its script parses,
	// but poll anyway -- same shape as reader.js _waitForReader().
	let n = 0;
	while (!cw.wrappedJSObject.zgSetData) {
		if (n++ > 500) throw new Error('graph page never published zgSetData');
		await Zotero.Promise.delay(20);
	}

	// content -> chrome. event.detail is a JSON string (a primitive), so there is
	// nothing to unwrap.
	cw.addEventListener('zg-event', (event) => {
		let msg;
		try {
			msg = JSON.parse(event.detail);
		}
		catch (e) {
			return;
		}
		handleMessage(win, tabID, collection, msg).catch(e => Zotero.logError(e));
	});

	await runBuild(tabID);
}

async function handleMessage(win, tabID, collection, msg) {
	switch (msg.type) {
		case 'open-item':
			if (msg.itemID) {
				win.Zotero_Tabs.select('zotero-pane');
				await win.ZoteroPane.selectItem(msg.itemID);
			}
			break;
		case 'rebuild': {
			let entry = open_.get(tabID);
			if (entry && msg.options) Object.assign(entry.options, msg.options);
			await runBuild(tabID);
			break;
		}
		case 'add-item':
			if (msg.doi) await addByDoi(win, tabID, collection, msg.doi);
			break;
		default:
			console.log('unhandled message from graph page: ' + msg.type);
	}
}

/**
 * Build in phases, pushing a payload after each, because the phases differ in
 * cost by more than an order of magnitude:
 *
 *   items      instant        nodes on screen straight away
 *   text       ~1-2s          reads Zotero's existing .zotero-ft-cache files
 *   pdf-links  ~30s uncached  reads every PDF whole; cached per file thereafter
 *
 * Doing this as one build would mean staring at an empty tab for half a minute
 * on first open. The renderer keeps node positions across pushes, so later
 * phases add edges to a settled layout instead of restarting it.
 */
async function runBuild(tabID) {
	let entry = open_.get(tabID);
	if (!entry) return;

	// Guards against a rebuild racing the build it replaced.
	let generation = ++entry.generation;
	let alive = () => open_.get(tabID) === entry && entry.generation === generation;

	let { collection, options } = entry;
	let cache = await PdfLinkCache.forProfile().load();
	let adapter = new ZoteroAdapter(collection, { cache, recursive: options.recursive });
	let items = [];
	let inCollection = new Set();
	// key -> Metadata, filled by the enrichment phase and folded into every
	// later push. Held here rather than in the payload so a re-push before
	// enrichment finishes simply carries no names, instead of dropping them.
	let metadata = Object.create(null);
	// Zotero item key -> global citation count, for the held items. Separate
	// from `metadata` because these nodes already have a name from the library;
	// the only thing enrichment adds is the count.
	let heldCounts = Object.create(null);

	let push = (edges, meta) => {
		if (!alive()) return;
		// External nodes are recomputed over the combined edge list rather than
		// carried from each build: a work found by both text-doi and pdf-links is
		// one node cited once, not two.
		let external = options.includeExternal
			? cg.collectExternalNodes(edges, k => inCollection.has(k))
				.slice(0, MAX_EXTERNAL_NODES)
				.map(x => toWireExternal(x, metadata[x.key]))
			: [];
		send(entry, 'zgSetData', {
			collection: { key: collection.key, name: collection.name },
			options,
			// citedByGlobal is folded in rather than carried on the item objects
			// themselves, so the adapter's output stays exactly what the CLI sees.
			items: items.map(it => (heldCounts[it.key] != null
				? { ...it, citedByGlobal: heldCounts[it.key] }
				: it)),
			external,
			edges: edges.map(toWireEdge),
			meta,
		});
	};
	let status = (text) => {
		if (alive()) send(entry, 'zgSetStatus', text);
	};

	// --- phase 1: nodes -------------------------------------------------
	status(options.recursive ? 'Loading collection and subcollections…' : 'Loading collection…');
	items = await adapter.listItems();
	inCollection = new Set(items.map(i => i.key));
	if (!alive()) return;
	push([], { phase: 'items', items: items.length });
	if (!items.length) {
		status('This collection has no regular items.');
		return;
	}

	// --- phase 2: text strategies ---------------------------------------
	status('Reading indexed text…');
	let textResult = await cg.build(adapter, {
		enable: TEXT_STRATEGIES,
		offline: true,
		includeExternal: options.includeExternal,
		onProgress: throttle(p => status(
			`Reading indexed text… ${p.done}/${p.total} (${p.provider})`)),
	});
	if (!alive()) return;
	push(textResult.edges, {
		phase: 'text',
		items: items.length,
		perProvider: textResult.meta.perProvider,
		errors: textResult.meta.errors,
	});
	logMeta('text', textResult);

	// --- phase 3: PDF hyperlink scan ------------------------------------
	let pdfs = adapter.pdfCount();
	status(pdfs ? `Scanning ${pdfs} PDFs for DOI links…` : 'Scanning PDFs…');
	let pdfResult = await cg.build(adapter, {
		enable: PDF_STRATEGIES,
		offline: true,
		includeExternal: options.includeExternal,
		onProgress: throttle(p => status(
			`Scanning PDFs for DOI links… ${p.done}/${p.total}`)),
	});
	await cache.flush();
	if (!alive()) return;

	let edges = mergeEdges(textResult.edges, pdfResult.edges);
	let baseMeta = {
		items: items.length,
		perProvider: { ...textResult.meta.perProvider, ...pdfResult.meta.perProvider },
		errors: [...textResult.meta.errors, ...pdfResult.meta.errors],
		adapter: adapter.stats,
	};
	let external = options.includeExternal
		? cg.collectExternalNodes(edges, k => inCollection.has(k))
		: [];
	push(edges, { phase: options.enrich && external.length ? 'edges' : 'done', ...baseMeta });
	logMeta('pdf-links', pdfResult);

	// --- phase 4: name the ghosts ---------------------------------------
	// Last on purpose: it is the only network phase, it is optional, and a
	// failure here must cost names and nothing else -- the graph is already
	// on screen and correct by this point.
	if (!options.enrich) {
		status('');
		return;
	}

	// Ghosts need a name; held items already have one and need only the global
	// count, which is what makes "size by global citations" meaningful for the
	// whole graph rather than half of it. Both are DOIs, so they go in one
	// batched pass -- doiKey is the shared address space.
	let ghostKeys = external.slice(0, MAX_ENRICH).map(x => x.key);
	let heldByDoiKey = new Map();
	for (let it of items) {
		let d = normDoi(it.doi);
		if (d) heldByDoiKey.set(externalKey('doi', d), it.key);
	}
	let toLookUp = [...new Set([...ghostKeys, ...heldByDoiKey.keys()])];
	if (!toLookUp.length) {
		status('');
		return;
	}

	let metaCache = await MetadataCache.forProfile().load();
	status(`Looking up ${toLookUp.length} works…`);
	let enriched = await cg.enrich(toLookUp, {
		enable: enricherList(),
		cache: metaCache,
		providers: { openalex: { apiKey: pref('openalex.apiKey') || null } },
		onProgress: throttle(p => status(
			`Looking up works… ${p.done}/${p.total} (${p.provider})`)),
	});
	await metaCache.flush();
	if (!alive()) return;

	metadata = enriched.metadata;
	heldCounts = Object.create(null);
	for (let [doiKey, itemKey] of heldByDoiKey) {
		let m = enriched.metadata[doiKey];
		if (m && m.citedByGlobal != null) heldCounts[itemKey] = m.citedByGlobal;
	}

	push(edges, { phase: 'done', ...baseMeta, enrich: enriched.meta });
	Zotero.debug(`[zotero-graph] enrich -> ${enriched.meta.resolved}/${enriched.meta.requested}`
		+ ` named (${enriched.meta.fromCache} cached) in ${enriched.meta.ms}ms`);
	for (let err of enriched.meta.errors) {
		Zotero.logError(new Error(`[zotero-graph] enrich ${err.provider}: ${err.message}`));
	}
	status('');
}

/**
 * Add an outside reference to the library, by DOI.
 *
 * This is Zotero's own add-by-identifier path (chrome/content/zotero/lookup.js,
 * Zotero_Lookup.addItemsFromIdentifier) called directly. Handing the whole
 * translator list to setTranslator() is deliberate and load-bearing: on no
 * result, Zotero.Translate.Search#complete shifts to the next one and retries,
 * so this inherits the entire DOI fallback chain for free.
 *
 * extractIdentifiers() is not needed -- a ghost's key already holds a DOI that
 * normDoi produced.
 */
async function addByDoi(win, tabID, collection, doi) {
	let entry = open_.get(tabID);
	let status = (t) => entry && send(entry, 'zgSetStatus', t);
	let d = normDoi(doi);
	if (!d) {
		status('Not a usable DOI: ' + doi);
		return;
	}

	status('Adding ' + d + '…');
	let translate = new Zotero.Translate.Search();
	translate.setIdentifier({ DOI: d });
	let newItems = [];
	try {
		let translators = await translate.getTranslators();
		if (!translators.length) throw new Error('no translator accepted the DOI');
		translate.setTranslator(translators);
		newItems = await translate.translate({
			libraryID: collection.libraryID,
			collections: [collection.id],
			// Zotero's own open-access PDF lookup, for free.
			saveAttachments: true,
		});
	}
	catch (e) {
		Zotero.logError(e);
		status('Could not add ' + d + ': ' + (e && e.message ? e.message : e));
		return;
	}
	if (!newItems.length) {
		status('No metadata found for ' + d);
		return;
	}

	// The ghost's key was 'doi:<doi>'; the work is now a real item with an
	// 8-character key, and every edge pointing at it has to be re-derived.
	// A rebuild is the only way to get that consistently, and it is cheap here:
	// phase 3 comes off the warm pdfLinkCache and phase 4 off the metadata cache.
	status('Added "' + newItems[0].getDisplayTitle() + '" — rebuilding…');
	await runBuild(tabID);
}

/** Zotero.Prefs auto-prefixes 'extensions.zotero.'; see addon/prefs.js. */
function pref(name) {
	try {
		return Zotero.Prefs.get('zoteroGraph.' + name);
	}
	catch (e) {
		return null;
	}
}

/**
 * The enricher chain, from the pref, ordered. Unknown ids are dropped rather
 * than passed through: enrichRegistry.get() throws on one, and a typo in a pref
 * must not be able to take down a build that has already produced its graph.
 */
function enricherList() {
	let known = new Set(cg.enrichRegistry.all().map(e => e.id));
	let configured = String(pref('enrichers') || '')
		.split(',').map(s => s.trim()).filter(Boolean);
	let chosen = configured.filter((id) => {
		if (known.has(id)) return true;
		Zotero.debug(`[zotero-graph] ignoring unknown enricher '${id}' from prefs`);
		return false;
	});
	return chosen.length ? chosen : ENRICHERS;
}

/**
 * Same merge policy as core's graphBuilder: one edge per ordered pair, keeping
 * the highest confidence any strategy assigned and the union of provenance.
 * Applied here because the phases are separate build() calls.
 */
function mergeEdges(...groups) {
	let merged = new Map();
	for (let group of groups) {
		for (let e of group) {
			let k = e.from + ' ' + e.to;
			let prev = merged.get(k);
			if (!prev) {
				merged.set(k, { ...e, via: [...e.via], evidence: [...(e.evidence || [])] });
				continue;
			}
			prev.confidence = Math.max(prev.confidence, e.confidence);
			for (let v of e.via) if (!prev.via.includes(v)) prev.via.push(v);
			if (e.evidence) prev.evidence.push(...e.evidence);
		}
	}
	return [...merged.values()];
}

/** Evidence can be large; the renderer only needs enough to explain an edge. */
function toWireEdge(e) {
	return {
		from: e.from,
		to: e.to,
		confidence: e.confidence,
		via: e.via,
		doi: (e.evidence || []).map(x => x.doi).find(Boolean) || null,
	};
}

/**
 * citedByKeys is only needed for the count, which is already computed.
 *
 * `citedBy` (citers inside this collection) and `citedByGlobal` (citations in
 * the whole literature) are two different numbers and stay two different fields
 * all the way to the renderer. See docs/external-references.md part 4.
 */
function toWireExternal(x, m) {
	let out = { key: x.key, ns: x.ns, id: x.id, citedBy: x.citedBy, via: x.via };
	if (m) {
		out.title = m.title || null;
		out.creators = m.creators || [];
		out.year = m.year != null ? m.year : null;
		out.citedByGlobal = m.citedByGlobal != null ? m.citedByGlobal : null;
		out.source = m.source || [];
	}
	return out;
}

function send(entry, fn, value) {
	let cw = entry.browser.contentWindow;
	if (!cw || !cw.wrappedJSObject[fn]) return;
	try {
		cw.wrappedJSObject[fn](typeof value === 'string' ? value : JSON.stringify(value));
	}
	catch (e) {
		Zotero.logError(e);
	}
}

/** Progress fires per item; the bridge does not need 400 crossings a second. */
function throttle(fn, ms = 200) {
	let last = 0;
	return (...args) => {
		let now = Date.now();
		if (now - last < ms) return;
		last = now;
		fn(...args);
	};
}

function logMeta(phase, result) {
	let per = Object.entries(result.meta.perProvider)
		.map(([id, s]) => `${id}: ${s.newEdges} edges in ${s.ms}ms`)
		.join(', ');
	Zotero.debug(`[zotero-graph] ${phase} -> ${per || 'nothing'}`);
	for (let err of result.meta.errors) {
		Zotero.logError(new Error(`[zotero-graph] ${err.provider}: ${err.message}`));
	}
}

function closeAllInWindow(win) {
	for (let [tabID, entry] of [...open_]) {
		if (entry.win === win) {
			try {
				win.Zotero_Tabs.close(tabID);
			}
			catch (e) { /* tab may already be gone */ }
			open_.delete(tabID);
		}
	}
}

function closeAll() {
	for (let [, entry] of [...open_]) {
		closeAllInWindow(entry.win);
	}
	open_.clear();
}

module.exports = { open, closeAll, closeAllInWindow, mergeEdges, toWireExternal };
