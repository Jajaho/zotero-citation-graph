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

// Ordered fastest-first. Everything here is offline; `openalex` is registered
// but never selected, so no build can reach the network by accident.
const TEXT_STRATEGIES = ['text-doi', 'title-match'];
const PDF_STRATEGIES = ['pdf-links'];

// External nodes are unbounded in principle -- 4,564 distinct DOIs across 127
// PDFs on the sample library, nearly all cited exactly once. The renderer's
// min-citations control does the real filtering; this only stops a pathological
// payload from crossing the bridge. Sorted most-cited first, so the cut only
// ever loses singletons.
const MAX_EXTERNAL_NODES = 4000;

// Rebuild-triggering options. Everything else the toolbar offers is a filter
// over an already-built graph and never comes back to chrome.
const DEFAULT_OPTIONS = { recursive: false, includeExternal: true };

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

	let push = (edges, meta) => {
		if (!alive()) return;
		// External nodes are recomputed over the combined edge list rather than
		// carried from each build: a work found by both text-doi and pdf-links is
		// one node cited once, not two.
		let external = options.includeExternal
			? cg.collectExternalNodes(edges, k => inCollection.has(k))
				.slice(0, MAX_EXTERNAL_NODES)
				.map(toWireExternal)
			: [];
		send(entry, 'zgSetData', {
			collection: { key: collection.key, name: collection.name },
			options,
			items,
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
	push(edges, {
		phase: 'done',
		items: items.length,
		perProvider: { ...textResult.meta.perProvider, ...pdfResult.meta.perProvider },
		errors: [...textResult.meta.errors, ...pdfResult.meta.errors],
		adapter: adapter.stats,
	});
	logMeta('pdf-links', pdfResult);
	status('');
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

/** citedByKeys is only needed for the count, which is already computed. */
function toWireExternal(x) {
	return { key: x.key, ns: x.ns, id: x.id, citedBy: x.citedBy, via: x.via };
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

module.exports = { open, closeAll, closeAllInWindow, mergeEdges };
