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
let readerPane = require('./readerPane.js');
let l10n = require('./l10n.js');
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
// All three default to off, and for the same reason in two different keys:
// the cheapest, most literal reading of the collection is the one to open
// with. `includeExternal` multiplies the node count by an order of magnitude
// -- thousands of ghosts against a hundred held items -- so a first look at a
// collection should be the papers you actually have. `enrich` is the only
// thing here that touches the network at all, and that is not a property to
// turn on for someone silently.
const DEFAULT_OPTIONS = { recursive: false, includeExternal: false, enrich: false };

// tabID -> { win, browser, split, pane, collection, generation, options,
//             built, building }
// `split` is the box holding the graph and, once opened, the reader pane;
// `pane` is readerPane.js's record for that reader, or null. `built` is the
// last completed derivation, which runLookup() names in place; `building`
// says whether a build owns the tab, since a lookup must not push over one.
let open_ = new Map();

async function open(win, collection, config) {
	// Collection first: the tab strip truncates from the right, and which
	// collection this is is the half that distinguishes one graph tab from another.
	let title = l10n.t('tab-title', { collection: collection.name });

	let { id, container } = win.Zotero_Tabs.add({
		// No hyphen: tabs.js parseTabType() splits the type on '-' to separate
		// the content type from the '-unloaded' state suffix.
		type: 'graph',
		title,
		data: { collectionKey: collection.key, libraryID: collection.libraryID },
		select: true,
		onClose: () => {
			let entry = open_.get(id);
			// The container is about to be destroyed anyway, but the reader inside it
			// still has listeners registered on the window and state to flush.
			if (entry) readerPane.close(entry);
			open_.delete(id);
		},
	});

	// The graph goes inside a horizontal box rather than straight into the tab
	// container, because readerPane.js appends a splitter and a reader beside it.
	// Built up front and never rebuilt: reparenting a <browser> tears down its
	// docShell and reloads the page, which would throw the graph away the first
	// time a PDF was opened.
	let split = win.document.createXULElement('hbox');
	split.setAttribute('flex', '1');
	split.className = 'zg-split';

	let browser = win.document.createXULElement('browser');
	browser.setAttribute('class', 'zotero-graph');
	browser.setAttribute('flex', '1');
	browser.setAttribute('type', 'content');
	browser.setAttribute('transparent', 'true');
	browser.setAttribute('src', `resource://${config.resRoot}/content/graph.html`);
	// Lets the graph give width up to the reader pane instead of pushing it off
	// the right edge.
	browser.style.minWidth = '0';
	split.appendChild(browser);
	container.appendChild(split);

	open_.set(id, {
		win, browser, split, collection,
		pane: null,
		generation: 0,
		options: { ...DEFAULT_OPTIONS },
		built: null,
		building: false,
	});

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

	// Strings first, before any status or payload can be pushed: the page paints
	// the English in its own markup until this lands, and the sooner it lands
	// the less of it anyone sees. See content/l10n.js.
	let entry = open_.get(tabID);
	if (entry) send(entry, 'zgSetStrings', l10n.contentBundle());

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
		// The lookup derives no node and no edge -- it puts names and counts on
		// a graph that is already built. Running it as a phase over the last
		// build, rather than as a rebuild, is what lets the layout the user is
		// reading survive it: a rebuild starts by pushing an empty edge list,
		// which takes every edge off the graph and re-anneals it from nothing.
		case 'lookup': {
			let entry = open_.get(tabID);
			if (!entry) break;
			entry.options.enrich = !!msg.on;
			// Nothing settled to add to: no build has finished, or one is still
			// running and will pick the option up itself.
			if (!entry.built || entry.building) await runBuild(tabID);
			else await runLookup(tabID);
			break;
		}
		case 'add-item':
			if (msg.doi) await addByDoi(win, tabID, collection, msg.doi);
			break;
		// The graph page runs with a content principal and cannot open a browser
		// itself. Only http(s) is passed on: a held item's URL comes from the
		// Zotero `url` field, which is free text and routinely holds a local
		// path -- and this ends up at the OS handler.
		case 'open-url':
			if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
				Zotero.launchURL(msg.url);
			}
			break;
		// The item's own PDF, beside the graph rather than in place of it. Only
		// chrome can do this: the pane is a <browser> in the tab container that
		// core renders a reader into. See readerPane.js.
		case 'open-pdf': {
			let entry = open_.get(tabID);
			if (entry && msg.itemID) {
				await readerPane.open(entry, msg.itemID, {
					status: t => send(entry, 'zgSetStatus', t),
				});
			}
			break;
		}
		// The same file in Zotero's own reader tab: the full reader, with the
		// sidebar, search and annotation the read-only pane cannot offer. It
		// takes the graph off screen, which is exactly why both are offered
		// rather than one -- the pane is for reading beside the graph, this is
		// for settling into a paper.
		case 'open-pdf-tab': {
			let entry = open_.get(tabID);
			if (!entry || !msg.itemID) break;
			let status = t => send(entry, 'zgSetStatus', t);
			let found = await readerPane.readable(msg.itemID, status);
			if (!found) break;
			// No options: this is the same call, and so the same tab, that
			// double-clicking the item in the library gets you.
			await Zotero.Reader.open(found.att.id);
			status('');
			break;
		}
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

	entry.building = true;
	try {
		await buildPhases(entry, alive);
	}
	finally {
		// A build that has already been superseded must not clear the flag the
		// build that superseded it set.
		if (alive()) entry.building = false;
	}
}

async function buildPhases(entry, alive) {
	let { collection, options } = entry;
	let cache = await PdfLinkCache.forProfile().load();
	let adapter = new ZoteroAdapter(collection, { cache, recursive: options.recursive });
	// Everything a payload is assembled from, in one object so that a later
	// pass -- see runLookup() -- can be handed the build this one produced.
	// `metadata` and `heldCounts` live here rather than in the payload so a
	// re-push before enrichment finishes simply carries no names, instead of
	// dropping the ones it had.
	let state = {
		items: [],
		inCollection: new Set(),
		edges: [],
		metadata: Object.create(null),
		heldCounts: Object.create(null),
	};

	let push = (edges, meta) => {
		if (!alive()) return;
		state.edges = edges;
		pushData(entry, state, meta);
	};
	let status = (text) => {
		if (alive()) send(entry, 'zgSetStatus', text);
	};

	// --- phase 1: nodes -------------------------------------------------
	status(l10n.t(options.recursive
		? 'build-loading-collection-recursive'
		: 'build-loading-collection'));
	let items = await adapter.listItems();
	if (!alive()) return;
	state.items = items;
	state.inCollection = new Set(items.map(i => i.key));
	push([], { phase: 'items', items: items.length });
	if (!items.length) {
		status(l10n.t('build-no-items'));
		return;
	}

	// --- phase 2: text strategies ---------------------------------------
	status(l10n.t('build-reading-text'));
	let textResult = await cg.build(adapter, {
		enable: TEXT_STRATEGIES,
		offline: true,
		includeExternal: options.includeExternal,
		onProgress: throttle(p => status(l10n.t('build-reading-text-progress', p))),
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
	status(pdfs
		? l10n.t('build-scanning-pdfs-count', { count: pdfs })
		: l10n.t('build-scanning-pdfs'));
	let pdfResult = await cg.build(adapter, {
		enable: PDF_STRATEGIES,
		offline: true,
		includeExternal: options.includeExternal,
		onProgress: throttle(p => status(l10n.t('build-scanning-pdfs-progress', p))),
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
		? cg.collectExternalNodes(edges, k => state.inCollection.has(k))
		: [];
	// What a lookup would ask for, worked out before the push so the payload can
	// say truthfully whether one is still to come. Ghosts need a name; held
	// items already have one and need only the global count, which is what
	// makes "size by global citations" meaningful for the whole graph rather
	// than half of it. Both are DOIs, so they go in one batched pass -- doiKey
	// is the shared address space, and with outside refs off the held items are
	// the whole of it.
	let ghostKeys = external.slice(0, MAX_ENRICH).map(x => x.key);
	let heldByDoiKey = new Map();
	for (let it of items) {
		let d = normDoi(it.doi);
		if (d) heldByDoiKey.set(externalKey('doi', d), it.key);
	}
	// The derived graph, kept so that switching the lookup on later costs one
	// phase instead of a whole build. Recorded before phase 4 runs: what a
	// lookup needs is exactly what is on screen by now.
	entry.built = { state, baseMeta, ghostKeys, heldByDoiKey };

	let toLookUp = options.enrich ? lookupKeys(entry.built) : [];
	push(edges, { phase: toLookUp.length ? 'edges' : 'done', ...baseMeta });
	logMeta('pdf-links', pdfResult);

	// --- phase 4: name the ghosts ---------------------------------------
	// Last on purpose: it is the only network phase, it is optional, and a
	// failure here must cost names and nothing else -- the graph is already
	// on screen and correct by this point.
	if (!toLookUp.length) {
		status('');
		return;
	}
	await lookUpNames(entry, alive, entry.built);
}

/**
 * Turn the lookup on or off over the graph that is already on screen.
 *
 * The lookup is the one option that derives nothing: no item enters or leaves
 * the collection for it, and no edge is found or lost. Re-deriving the graph to
 * apply it would push an empty edge list through phase 1, strip every edge off
 * the layout the user is reading, and re-anneal it from nothing over the next
 * two phases -- all to apply a change that only ever writes names and citation
 * counts onto nodes that are already there.
 */
async function runLookup(tabID) {
	let entry = open_.get(tabID);
	if (!entry || !entry.built) return;

	let generation = ++entry.generation;
	let alive = () => open_.get(tabID) === entry && entry.generation === generation;
	let built = entry.built;

	entry.building = true;
	try {
		if (!entry.options.enrich) {
			// Switching it off takes the names back off and nothing else: same
			// items, same edges, so the graph does not move.
			built.state.metadata = Object.create(null);
			built.state.heldCounts = Object.create(null);
			pushData(entry, built.state, { phase: 'done', ...built.baseMeta });
			send(entry, 'zgSetStatus', '');
			return;
		}
		if (!lookupKeys(built).length) {
			send(entry, 'zgSetStatus', l10n.t('lookup-nothing'));
			return;
		}
		await lookUpNames(entry, alive, built);
	}
	finally {
		if (alive()) entry.building = false;
	}
}

/**
 * What one lookup pass asks about: every ghost that needs a name, and every
 * held item that needs only its global count. One batched pass, because doiKey
 * is the address space both live in.
 */
function lookupKeys(built) {
	return [...new Set([...built.ghostKeys, ...built.heldByDoiKey.keys()])];
}

/**
 * The naming phase itself, over a build that already exists. Shared by the
 * build that produced it and by a later switch-on, so the two cannot disagree
 * about what a named graph looks like.
 */
async function lookUpNames(entry, alive, built) {
	let { state, baseMeta, heldByDoiKey } = built;
	let status = (text) => {
		if (alive()) send(entry, 'zgSetStatus', text);
	};
	let toLookUp = lookupKeys(built);

	let metaCache = await MetadataCache.forProfile().load();
	status(l10n.t('lookup-works', { count: toLookUp.length }));
	let enriched = await cg.enrich(toLookUp, {
		enable: enricherList(),
		cache: metaCache,
		providers: { openalex: { apiKey: pref('openalex.apiKey') || null } },
		onProgress: throttle(p => status(l10n.t('lookup-progress', p))),
	});
	await metaCache.flush();
	if (!alive()) return;

	state.metadata = enriched.metadata;
	state.heldCounts = Object.create(null);
	for (let [doiKey, itemKey] of heldByDoiKey) {
		let m = enriched.metadata[doiKey];
		if (m && m.citedByGlobal != null) state.heldCounts[itemKey] = m.citedByGlobal;
	}

	pushData(entry, state, { phase: 'done', ...baseMeta, enrich: enriched.meta });
	Zotero.debug(`[zotero-graph] enrich -> ${enriched.meta.resolved}/${enriched.meta.requested}`
		+ ` named (${enriched.meta.fromCache} cached) in ${enriched.meta.ms}ms`);
	for (let err of enriched.meta.errors) {
		Zotero.logError(new Error(`[zotero-graph] enrich ${err.provider}: ${err.message}`));
	}
	status('');
}

/**
 * Assemble one payload and send it. Every push goes through here, so a pass
 * that re-sends a graph it did not derive sends exactly what the build that
 * derived it would have sent.
 */
function pushData(entry, state, meta) {
	let { collection, options } = entry;
	// External nodes are recomputed over the combined edge list rather than
	// carried from each build: a work found by both text-doi and pdf-links is
	// one node cited once, not two.
	let external = options.includeExternal
		? cg.collectExternalNodes(state.edges, k => state.inCollection.has(k))
			.slice(0, MAX_EXTERNAL_NODES)
			.map(x => toWireExternal(x, state.metadata[x.key]))
		: [];
	send(entry, 'zgSetData', {
		collection: { key: collection.key, name: collection.name },
		options,
		// citedByGlobal is folded in rather than carried on the item objects
		// themselves, so the adapter's output stays exactly what the CLI sees.
		items: state.items.map(it => (state.heldCounts[it.key] != null
			? { ...it, citedByGlobal: state.heldCounts[it.key] }
			: it)),
		external,
		edges: state.edges.map(toWireEdge),
		meta,
	});
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
		status(l10n.t('add-bad-doi', { doi }));
		return;
	}

	status(l10n.t('add-adding', { doi: d }));
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
		status(l10n.t('add-failed', { doi: d, message: e && e.message ? e.message : e }));
		return;
	}
	if (!newItems.length) {
		status(l10n.t('add-no-metadata', { doi: d }));
		return;
	}

	// The ghost's key was 'doi:<doi>'; the work is now a real item with an
	// 8-character key, and every edge pointing at it has to be re-derived.
	// A rebuild is the only way to get that consistently, and it is cheap here:
	// phase 3 comes off the warm pdfLinkCache and phase 4 off the metadata cache.
	status(l10n.t('add-done', { title: newItems[0].getDisplayTitle() }));
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

module.exports = {
	open, closeAll, closeAllInWindow, mergeEdges, toWireExternal,
	// Exported for the payload test: what a lookup pass may and may not change
	// about the graph on screen is the whole reason it is not a rebuild.
	pushData,
};
