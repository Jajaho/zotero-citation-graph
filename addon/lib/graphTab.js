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
let { ZoteroAdapter, itemRecord } = require('./zoteroAdapter.js');
let { PdfLinkCache } = require('./pdfLinkCache.js');
let { MetadataCache } = require('./metadataCache.js');
let cacheStore = require('./cacheStore.js');
let addDialog = require('./addDialog.js');
let itemPane = require('./itemPane.js');
let splitPane = require('./splitPane.js');
let gapsPane = require('./gapsPane.js');
let nodeMenu = require('./nodeMenu.js');
let searchPane = require('./searchPane.js');
let l10n = require('./l10n.js');
let trace = require('./trace.js');
let { normDoi } = require('../citation-graph/core/normalize.js');
let { externalKey } = require('../citation-graph/core/types.js');

// Ordered fastest-first. Every EDGE strategy here is offline; `openalex` is
// registered but never selected, so no edge build reaches the network. The
// separate enrichment phase does, but only when the user has switched it on.
// locator-match belongs here rather than in a phase of its own: it reads the
// same reference sections the other two read, off the same per-build cache, and
// costs about a second over three hundred PDFs. It is also the only one of the
// three that can see a numeric-style reference, which prints no title and no
// DOI -- so leaving it out of this list would leave whole fields' citations
// undrawn while the strategy sat registered and never selected.
const TEXT_STRATEGIES = ['text-doi', 'title-match', 'locator-match'];
const PDF_STRATEGIES = ['pdf-links'];

// Ghosts to name, most-locally-cited first. The payload cap below is 4,000, and
// enriching all of them would be 80 sequential OpenAlex calls for a tail that
// the default "cited by >= 2" filter hides anyway. Ghosts past this point keep
// their DOI label, which is exactly what they had before enrichment existed.
const MAX_ENRICH = 500;

// OpenAlex references are named on top of that, because naming one is what
// merges it with the same work found offline (see rekeyByDoi). 2,500 is 50
// calls, once: the names are cached for a month.
const MAX_ENRICH_REFERENCES = 2500;

// Where the OpenAlex strategy keeps each held paper's reference list, beside
// the metadata cache and aged out on the same schedule.
const REFERENCE_CACHE_FILE = cacheStore.FILES.references;

// Ordered: core/enrich.js merges fill-first, so this list IS the ranking. A
// second enricher added here is only ever asked about what the first could not
// resolve. See design/external-references.md part 3. Overridable by the
// zoteroCitationGraph.enrichers pref; see enricherList().
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
//
// `openalexRefs` is the one edge strategy that reaches the network, so it is
// the one strategy that is switched on rather than filtered off.
//
// `refStrings` is switched rather than filtered for the other reason: it is the
// only offline strategy that ADDS NODES instead of edges between nodes already
// on screen. Every other one can be toggled in the strategy list over a graph
// that is already built, because taking it away leaves the same population with
// fewer connections. Taking this one away would empty the canvas of everything
// it found, which is a rebuild however it is dressed up.
const DEFAULT_OPTIONS = {
	recursive: false, includeExternal: false, enrich: false, openalexRefs: false, refStrings: false,
};

// tabID -> { win, tabID, browser, split, pane, itemPane, scope,
//             generation, options, built, building, addTarget, selection }
// `split` is the box holding the graph and, once opened, the tab's side
// panel; `pane` is splitPane.js's record for that panel and `itemPane` is
// what is in it. `built` is the last completed derivation, which runLookup()
// names in place; `building` says whether a build owns the tab, since a
// lookup must not push over one.
// `selection` is what the tab answers when Zotero asks which items are
// selected -- see lib/tabContext.js.
let open_ = new Map();

// Session entries already turned into a real tab, by whichever of the two
// restore paths reached them first -- core's hook, or restoreMissing() below.
// A WeakSet keyed on the entry rather than a flag written onto it: those
// objects are Zotero.Session's own, and a marker of ours has no business being
// serialised back into session.json.
let claimed_ = new WeakSet();

// Restored from the last session but never selected, so there is a tab in the
// strip with no page behind it yet. Kept apart from open_ rather than entered
// there as a half-record, so nothing that walks live tabs -- a build, a lookup,
// a message from a page -- can reach an entry that has no browser.
// tabID -> { win, tabID }
let pending_ = new Map();

/**
 * What a graph is OF. Two kinds, and everything downstream that used to read a
 * bare Zotero.Collection now reads one of these.
 *
 *   kind         'collection' | 'selection'
 *   libraryID    the library either kind lives in
 *   collection   the collection, for a collection graph -- and for a SELECTION
 *                made inside one, where it is the anchor rather than the scope:
 *                nodes come from itemKeys, but "which collection is open",
 *                "can this be edited" and the Add dialog's default target all
 *                still have an honest answer. Null for a selection made in My
 *                Library, a saved search, a tag view or unfiled items.
 *   itemKeys     the frozen pick, for a selection; null for a collection.
 *
 * Frozen is the point. The keys are taken once, when the tab opens, so clicking
 * around the item tree afterwards cannot move a graph someone is reading -- the
 * same bargain a collection graph already strikes with the collection tree.
 */
function collectionScope(collection) {
	return {
		kind: 'collection',
		libraryID: collection.libraryID,
		collection,
		itemKeys: null,
	};
}

function selectionScope(libraryID, itemKeys, collection) {
	return {
		kind: 'selection',
		libraryID,
		collection: collection || null,
		itemKeys: [...itemKeys],
	};
}

/** A selection graph, as against one of a whole collection. */
function isSelection(scope) {
	return !!scope && scope.kind === 'selection';
}

/**
 * What a graph tab is, reduced to what has to survive a restart.
 *
 * Zotero_Tabs.getState() serialises tab.data wholesale into session.json, so
 * this IS the persisted form: where the graph is, what it is of, and the scope
 * options the user set. Everything else about a graph -- its edges, its layout,
 * its names -- is derived, and re-derived far more cheaply than it could be
 * stored honestly. See pdfLinkCache.js and metadataCache.js, which are where the
 * expensive phases already survive a restart, invalidated per input rather than
 * wholesale.
 *
 * `itemKeys: null` is what says "a collection graph", which is exactly the
 * shape every tab written before selections existed already has -- so old
 * session data restores unchanged, with no migration and no version stamp.
 */
function tabData(scope, options) {
	return {
		collectionKey: scope.collection ? scope.collection.key : null,
		libraryID: scope.libraryID,
		itemKeys: scope.itemKeys ? [...scope.itemKeys] : null,
		// `icon` is read by tabs.js _update(): with one set, it does not go looking
		// for an item to take a type icon from -- a graph tab has no item, and the
		// lookup it would otherwise attempt leaves the tab with no icon at all.
		// The name lands on the tab's <span> as data-item-type, which is what the
		// stylesheet main.js injects paints. See TAB_ICON_CSS there.
		icon: 'zotero-citation-graph',
		options: { ...options },
	};
}

/**
 * The scope a restored tab reopens with. Spread over the defaults rather than
 * used as it comes, so data written by an older version -- which knew fewer
 * options, or different ones -- fills in instead of leaving a scope undefined.
 */
function restoreOptions(data) {
	return { ...DEFAULT_OPTIONS, ...((data && data.options) || null) };
}

/**
 * The tab title. For a collection graph it is the collection's name, read from
 * the live collection on every path including restore, so a collection renamed
 * while its tab was closed comes back under the name it has now rather than the
 * one it had. For a selection it is the count -- with the anchor collection's
 * name in front of it where there is one, since two selection tabs in the strip
 * are otherwise told apart only by a number.
 *
 * Collection first in every form: the tab strip truncates from the right, and
 * which shelf of the library this is is the half that distinguishes one graph
 * tab from another.
 *
 * Control characters are stripped for the reason core's reader hook strips them
 * (tabs.js restoreState): one in a title raises "An invalid or illegal string
 * was specified" and takes the whole restore down with it.
 */
function tabTitle(scope, count) {
	let name = scope.collection ? scope.collection.name : '';
	let title, fallback;
	if (isSelection(scope)) {
		let n = count != null ? count : (scope.itemKeys || []).length;
		title = name
			? l10n.t('tab-title-selection-in', { collection: name, count: n })
			: l10n.t('tab-title-selection', { count: n });
		fallback = name ? name + ' (' + n + ')' : String(n);
	}
	else {
		title = l10n.t('tab-title', { collection: name });
		fallback = name;
	}
	// t() answers with the bare message id when the strings have not landed.
	// Restore can run on a timeline of Zotero's choosing, so this path is not
	// guaranteed to be after startup the way opening from the menu is, and a
	// tab labelled "tab-title" would be a poor way to find that out.
	if (title.startsWith('tab-title')) title = fallback;
	// eslint-disable-next-line no-control-regex
	return title.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

/**
 * What the tab strip actually holds, as a list of types. Diagnostic only, and
 * reaching into Zotero_Tabs._tabs to get it -- the question it answers (was the
 * graph tab still there when Zotero looked?) has no public form.
 */
function stripSummary(win) {
	try {
		return ((win.Zotero_Tabs && win.Zotero_Tabs._tabs) || []).map(t => t.type).join(',') || 'empty';
	}
	catch (e) {
		return '?';
	}
}

/**
 * Which items a graph tab has selected, for the Zotero that is asking --
 * lib/tabContext.js, standing in for the case core's
 * ZoteroPane.getSelectedItems() has no room for.
 *
 * A tab id rather than an entry, because the caller is a patched core
 * function that has Zotero_Tabs.selectedID and nothing else. An id belonging
 * to a closed tab, or to one restored but never selected, answers the same
 * way an unclicked graph does: nothing is selected.
 */
function selectedItemIDs(tabID) {
	let entry = open_.get(tabID);
	return (entry && entry.selection) || [];
}

/**
 * The collection a graph tab is a view of, for the same asker -- which is what
 * lets core answer "which collection is open", "which library" and "can this be
 * edited" for a tab it has never heard of. See lib/tabContext.js.
 *
 * Null rather than a guess for a tab id with no graph behind it: one closed, or
 * restored and never selected. Core's own answer is better than an invented
 * collection. Null too for a selection graph with no anchor -- one opened from
 * My Library, a saved search or a tag view -- where tabContext.js answers from
 * the library row instead. See selectedLibraryID().
 */
function selectedCollection(tabID) {
	let entry = open_.get(tabID);
	return (entry && entry.scope && entry.scope.collection) || null;
}

/**
 * The library a graph tab is in, for the same asker. Always known, even where
 * the collection is not -- which is what lets tabContext.js fall back to a
 * library row rather than to the library tab's stale tree selection.
 */
function selectedLibraryID(tabID) {
	let entry = open_.get(tabID);
	return entry && entry.scope ? entry.scope.libraryID : null;
}

/**
 * Show `itemIDs` in this tab -- what "select this item" means where the tab is
 * a graph rather than a list. See lib/tabContext.js.
 *
 * Core's own answer is the library's item tree plus a switch to that tab, which
 * is the wrong half of the point: the thing being selected is a note just
 * written on the paper under the pointer, or a row clicked in the pane, and all
 * of it belongs beside the graph it came from.
 *
 * The pane is opened if it was put away, unlike a click on a node: everything
 * that reaches here is an explicit request to look at one thing.
 */
async function selectItems(tabID, itemIDs) {
	let entry = open_.get(tabID);
	if (!entry || !itemIDs || !itemIDs.length) return false;
	// The tab's selection, the same way a click on a node sets it -- core has
	// just told us what the user is looking at.
	entry.selection = [...itemIDs];
	await itemPane.show(entry, entry.selection, {
		status: t => send(entry, 'zgSetStatus', t),
		expand: true,
	});
	return true;
}

/**
 * Teardown for a tab that is going away. The container is about to be destroyed
 * anyway, but what is in the side panel is not just markup: an item pane holds
 * observers registered with Zotero.Notifier, and taking it out of the document
 * is what unregisters them.
 */
function dropEntry(tabID) {
	let entry = open_.get(tabID);
	try {
		if (entry) searchPane.drop(entry);
	}
	catch (e) {
		Zotero.logError(e);
	}
	try {
		if (entry) itemPane.close(entry);
	}
	catch (e) {
		// Reached during window teardown as well as on a plain tab close, and
		// by then the panel's own nodes may already be gone. Letting go of the
		// entry matters more than the tidying, and the caller is usually part
		// way through a loop over the rest of them.
		Zotero.logError(e);
	}
	open_.delete(tabID);
	pending_.delete(tabID);
}

async function open(win, collection, config) {
	openScope(win, collectionScope(collection), { ...DEFAULT_OPTIONS }, config);
}

/**
 * A graph of the items the user picked in the item tree, rather than of a whole
 * collection -- the item context menu's entry. See lib/main.js.
 *
 * The keys are frozen here and never taken again: the tab is of THESE papers,
 * and clicking elsewhere in the library afterwards must not move a graph
 * someone is reading. Rebuild re-derives edges over the same keys.
 *
 * One option is decided here rather than left at its default. A single paper
 * with outside references off is one dot and no edges -- a picture that reads
 * as a failed build -- so a selection of one opens with `includeExternal`, which
 * makes it the honest thing to ask of one paper: what does this cite. The page
 * has the matching half of the bargain, since the default "cited by >= 2"
 * threshold cannot be met by a graph holding one paper at all; see the clamp in
 * content/graph.js.
 *
 * @param {Window} win
 * @param {Integer} libraryID
 * @param {String[]} itemKeys      the pick, already reduced to graphable items
 * @param {?Zotero.Collection} collection  the row it was made in, when that row
 *                                 was a collection; null otherwise
 * @param {Object} config
 */
async function openSelection(win, libraryID, itemKeys, collection, config) {
	let scope = selectionScope(libraryID, itemKeys, collection);
	openScope(win, scope, {
		...DEFAULT_OPTIONS,
		includeExternal: scope.itemKeys.length === 1,
	}, config);
}

/** The tab both entry points end in, so the two cannot come to differ. */
function openScope(win, scope, options, config) {
	let { id, container } = win.Zotero_Tabs.add({
		// No hyphen: tabs.js parseTabType() splits the type on '-' to separate
		// the content type from the '-unloaded' state suffix.
		type: 'graph',
		title: tabTitle(scope),
		data: tabData(scope, options),
		select: true,
		onClose: () => dropEntry(id),
	});

	trace.log(`opened a graph tab for ${scopeSummary(scope)}  strip=[${stripSummary(win)}]`);
	mount(win, id, container, scope, config, options)
		.catch(e => Zotero.logError(e));
}

/** What a scope is, in one word and a number, for the lifecycle log. */
function scopeSummary(scope) {
	if (!scope) return '-';
	if (isSelection(scope)) {
		return `a selection of ${(scope.itemKeys || []).length}`
			+ (scope.collection ? ` in ${scope.collection.key}` : ' with no collection');
	}
	return scope.collection ? scope.collection.key : '?';
}

/**
 * Bring a graph tab back from the last session -- tabHooks.restoreState.graph.
 *
 * This hook is mandatory for a custom tab type: tabs.js:611 does
 * `let { itemID } = await restoreStateHook(tab, i)` and the missing-hook default
 * returns undefined, so no hook at all throws and aborts restore for every LATER
 * tab. Returning itemID:null without re-adding is the "drop this one" answer,
 * and is still what a tab that cannot be honoured gets.
 *
 * Re-added unloaded, which is core's own mechanism for reader and note tabs:
 * select() promotes 'graph-unloaded' through 'graph-loading' to 'graph' by
 * calling tabHooks.load.graph. So a window restored with four graph tabs pays
 * for one build -- the selected one -- rather than four concurrent PDF scans at
 * the slowest moment of startup. Note that 'graph' is deliberately NOT added to
 * core's _loadableTypes: that list is what unloadUnusedTabs() reads, and a built
 * graph must not be thrown away behind the user's back after a day unselected.
 */
async function restore(win, tab, tabIndex) {
	// Nothing below may throw: restoreState() is a plain loop over the session's
	// tabs with no per-tab catch, so an exception here does not cost this tab --
	// it costs every tab after it. Dropping one graph tab is the worst outcome
	// this function is allowed to have.
	try {
		// Already ours: the other path got here first. Answering without adding
		// is what makes the two safe to run in either order, or both.
		if (claimed_.has(tab)) return { itemID: null };
		// Claimed in the same breath as the check, before the first await:
		// tested after one, two passes racing on the same entry would both get
		// past the check and both add a tab. An entry claimed and then found
		// unrestorable stays claimed, which is right -- the second pass would
		// only fail at it again.
		claimed_.add(tab);

		let scope = tabScopeSync(tab.data) || await tabScope(tab.data);
		trace.log(`restore  index=${tabIndex}`
			+ `  scope=${scopeSummary(scope)}`
			+ `  -> ${scope ? 'restoring' : 'dropped (nothing left to graph)'}`);
		if (!scope) return { itemID: null };

		let id;
		({ id } = win.Zotero_Tabs.add({
			type: 'graph-unloaded',
			title: tabTitle(scope),
			// add() rejects an index below 1; index 0 is the library tab's, and
			// no hook of ours is called for it.
			index: tabIndex > 0 ? tabIndex : 1,
			data: tab.data,
			select: !!tab.selected,
			onClose: () => dropEntry(id),
		}));
		// add() runs select() inline when select is set, so by the time this
		// line is reached load() may already have mounted the tab and taken it
		// back out of pending_.
		if (!open_.has(id)) pending_.set(id, { win, tabID: id });
	}
	catch (e) {
		Zotero.logError(e);
	}
	return { itemID: null };
}

/**
 * Restore the graph tabs that session restore never asked us about.
 *
 * The restoreState hook only works if it is registered before Zotero restores,
 * and a plugin cannot arrange that. Zotero.Plugins.init() is awaited at the end
 * of Zotero.init(), while ZoteroPane.init() -- and _loadPane(), which restores
 * once the item and collection trees are up -- is gated only on
 * initializationPromise, which resolves before it. Measured on a real profile,
 * restore had finished before this plugin was loaded at all: at
 * onMainWindowLoad the strip already held the session's reader tabs, and the
 * hook had never been called. It is not a race that is usually won; it is one
 * that is usually lost.
 *
 * So the hook is the fast path and this is the truth. Zotero.Session.state is
 * the parsed session.json and is not cleared by restoring from it, so the
 * entries are still there to be read afterwards -- including the graph tab that
 * restore dropped. Anything not already claimed gets a tab now.
 *
 * Safe in either order, and safe run twice: claimed_ is keyed on the session
 * entry, and both paths are handed the very same objects.
 *
 * What this cannot repair: with no hook registered, tabs.js:611 destructures
 * the missing hook's undefined and throws, and zoteroPane.js catches it around
 * the whole loop -- so any tab AFTER a graph tab in the session is lost with
 * it, and those are not ours to restore. A graph tab last in the strip, which
 * is where a newly opened one goes, costs nothing.
 */
function restoreMissing(win) {
	// Serialised behind one chain rather than run concurrently: two passes over
	// the same session would each claim entries the other was still adding, and
	// a caller awaiting the second would return before the first had finished.
	// Chaining also means a second pass simply finds everything claimed.
	restoring_ = restoring_.then(() => restorePass(win)).catch(e => Zotero.logError(e));
	return restoring_;
}

let restoring_ = Promise.resolve();

/** Whatever restore passes are in flight. Exported so a check can wait for the
 *  one onMainWindowLoad starts without starting another of its own. */
function restoreSettled() {
	return restoring_;
}

async function restorePass(win) {
	let entries;
	try {
		let pane = (Zotero.Session.state.windows || []).find(w => w.type === 'pane');
		entries = (pane && pane.tabs) || [];
	}
	catch (e) {
		Zotero.logError(e);
		return;
	}
	for (let i = 0; i < entries.length; i++) {
		let entry = entries[i];
		if (!entry || entry.type !== 'graph' || claimed_.has(entry)) continue;
		trace.log(`late restore  index=${i}  (session restore ran before this plugin loaded)`);
		await restore(win, entry, i);
		trace.log(`late restore done  index=${i}  strip=[${stripSummary(win)}]`);
	}
}

/**
 * Put a page behind a restored tab -- tabHooks.load.graph, on first select.
 *
 * Settles once the bridge is up, NOT once the graph is built: select() holds
 * core's loading cover over the tab until this resolves, and a cold PDF scan is
 * half a minute of it. The build runs on behind the cover coming off, reporting
 * itself through the status line like any other build.
 */
async function load(win, tab, config) {
	// Nor may this throw: select() calls the hook as
	// `loadHook(...).then(() => showLoadingMessage(false))` with no catch, so a
	// rejection here leaves the loading cover over the tab until the tab is
	// closed -- and leaves the rejection unhandled.
	try {
		if (open_.has(tab.id)) return;
		let scope = await tabScope(tab.data);
		if (!scope) {
			// The collection was deleted between sessions, or every item the
			// selection named was. There is nothing to draw and nowhere honest
			// to say so, since the tab IS the graph of it.
			win.Zotero_Tabs.close(tab.id);
			return;
		}
		let container = win.Zotero_Tabs.getTabContent(tab.id);
		if (!container || container.querySelector('.zg-split')) return;

		await Promise.race([
			mount(win, tab.id, container, scope, config, restoreOptions(tab.data)),
			// A page that never fires DOMContentLoaded must not leave the
			// loading cover over the tab for the rest of the session.
			Zotero.Promise.delay(15000),
		]);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

/**
 * The collection, if it can be had without awaiting. Split out so restore() can
 * stay synchronous down to Zotero_Tabs.add() on the path that always applies,
 * and only fall back to the promise for a library still to be loaded.
 */
function tabScopeSync(data) {
	if (!data || !data.libraryID) return null;
	let collection = null;
	if (data.collectionKey) {
		try {
			collection = Zotero.Collections.getByLibraryAndKey(
				data.libraryID, data.collectionKey) || null;
		}
		catch (e) {
			collection = null;
		}
	}
	return finishScope(data, collection);
}

/**
 * The scope a tab's persisted data points at, or null when it cannot be
 * honoured -- data from before any of this was stored, a collection deleted
 * while the tab was closed, or a selection whose every item has since gone.
 */
async function tabScope(data) {
	// getIDFromLibraryAndKey() throws on a falsy library id rather than missing.
	if (!data || !data.libraryID) return null;
	let collection = null;
	if (data.collectionKey) {
		try {
			// The awaiting form only. tabScopeSync() is tried first by every
			// caller that cares about latency, and is deliberately NOT retried
			// here: sharing one try block let a throwing sync call swallow the
			// async fallback with it, which is exactly how a group library would
			// have lost its tabs. Returns false, not null, when there is no such
			// collection.
			collection = await Zotero.Collections.getByLibraryAndKeyAsync(
				data.libraryID, data.collectionKey) || null;
		}
		catch (e) {
			Zotero.logError(e);
			collection = null;
		}
	}
	return finishScope(data, collection);
}

/**
 * Turn persisted data plus whatever became of its collection into a scope.
 *
 * A collection graph is unrestorable the moment its collection is gone: the tab
 * IS the graph of it. A selection is not -- it names its papers itself, and an
 * anchor collection that has since been deleted costs it only the conveniences
 * the anchor bought (see selectedCollection). What kills a selection is running
 * out of papers, and the keys are checked here rather than at build time so a
 * tab that can draw nothing is never put in the strip at all.
 *
 * The surviving keys are what the scope carries, so a graph that lost a paper
 * between sessions does not go on asking for it at every rebuild -- and
 * saveTabData() writes the shortened list back the first time anything else
 * changes.
 */
function finishScope(data, collection) {
	if (!data.itemKeys) {
		return collection ? collectionScope(collection) : null;
	}
	let keys = [];
	for (let key of data.itemKeys) {
		let id = null;
		try {
			id = Zotero.Items.getIDFromLibraryAndKey(data.libraryID, key);
		}
		catch (e) {
			id = null;
		}
		if (id) keys.push(key);
	}
	if (!keys.length) return null;
	return selectionScope(data.libraryID, keys, collection);
}

/**
 * The page itself, inside a tab container that already exists. Shared by a tab
 * opened from the collection menu and one restored from the last session, so
 * the two cannot come to mean different things.
 *
 * @returns {Promise} resolved when the chrome<->content bridge is up. The build
 *          runs on after that, deliberately unawaited -- see load().
 */
function mount(win, tabID, container, scope, config, options) {
	// The graph goes inside a horizontal box rather than straight into the tab
	// container, because splitPane.js appends a splitter and the side panel
	// beside it.
	// Built up front and never rebuilt: reparenting a <browser> tears down its
	// docShell and reloads the page, which would throw the graph away the first
	// time a PDF was opened.
	let split = win.document.createXULElement('hbox');
	split.setAttribute('flex', '1');
	split.className = 'zg-split';

	let browser = win.document.createXULElement('browser');
	browser.setAttribute('class', 'zotero-citation-graph');
	browser.setAttribute('flex', '1');
	browser.setAttribute('type', 'content');
	browser.setAttribute('transparent', 'true');
	browser.setAttribute('src', `resource://${config.resRoot}/content/graph.html`);
	// Lets the graph give width up to the side panel instead of pushing it off
	// the right edge.
	browser.style.minWidth = '0';
	split.appendChild(browser);
	container.appendChild(split);

	open_.set(tabID, {
		win, browser, split, scope,
		// Where this plugin's own files are, for the chrome side to address one:
		// lib/nodeMenu.js draws the isolate row from content/icons/spotlight.svg.
		resRoot: config.resRoot,
		// Handed to <item-details>, which watches tab selection by it and stops
		// rendering while some other tab is on screen.
		tabID,
		pane: null,
		itemPane: null,
		generation: 0,
		options,
		built: null,
		building: false,
		// The nodes the user has pointed at, as item IDs. Empty until the
		// first click, the same way a freshly opened library tab has nothing
		// selected.
		selection: [],
	});
	pending_.delete(tabID);

	return new Promise((resolve) => {
		let onDOMContentLoaded = (event) => {
			if (browser.contentWindow && browser.contentWindow.document === event.target) {
				win.removeEventListener('DOMContentLoaded', onDOMContentLoaded);
				ready(win, tabID, browser.contentWindow, scope)
					.then(() => {
						resolve();
						return runBuild(tabID);
					})
					.catch((e) => {
						Zotero.logError(e);
						resolve();
					});
			}
		};
		win.addEventListener('DOMContentLoaded', onDOMContentLoaded);
	});
}

async function ready(win, tabID, cw, scope) {
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
	// Beside the strings and for the same reason: both are things the page
	// cannot work out for itself, and both decide what the first paint looks
	// like. See chromeProps().
	if (entry) send(entry, 'zgSetChrome', chromeProps(win));
	// And the third of those. The bar's toggle is on screen while the panel is
	// not, and a page that has just loaded is drawn from its own markup until
	// something says otherwise -- which is right for a tab opening, where there
	// is no panel yet, and wrong for any page load that ever happens beside one.
	// splitPane's notifier only fires when the panel MOVES, so this is the state
	// it never reports. See splitPane.watch() below.
	if (entry) send(entry, 'zgSetPane', { open: splitPane.showing(entry) });
	// The Quick Search mode is core's pref, and its name is the field's
	// placeholder. See lib/searchPane.js.
	if (entry) send(entry, 'zgSetSearchMode', searchPane.modeInfo());

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
		handleMessage(win, tabID, scope, msg).catch(e => Zotero.logError(e));
	});
}

/**
 * A message from the pane rather than from the page.
 *
 * The gap list's rows raise exactly two things -- add-item, and the isolate the
 * page answers -- and both already have a case below. So they re-enter the same
 * switch rather than taking a path of their own: two ways into 'add-item' is
 * two places to fix the day it changes, and the row's + and the ghost's context
 * menu are meant to end in the same dialog.
 */
function fromPane(win, tabID, scope) {
	return msg => handleMessage(win, tabID, scope, msg).catch(e => Zotero.logError(e));
}

async function handleMessage(win, tabID, scope, msg) {
	switch (msg.type) {
		case 'rebuild': {
			let entry = open_.get(tabID);
			if (entry && msg.options) Object.assign(entry.options, msg.options);
			if (entry) saveTabData(entry);
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
			saveTabData(entry);
			// Nothing settled to add to: no build has finished, or one is still
			// running and will pick the option up itself.
			if (!entry.built || entry.building) await runBuild(tabID);
			else await runLookup(tabID);
			break;
		}
		case 'add-item':
			if (msg.doi) await addByDoi(win, tabID, scope, msg.doi, msg.title);
			break;
		// The gap list, in the pane beside the graph. Chrome's to draw for the
		// same reason as the item pane it shares a deck with: it is a XUL
		// element in the main window. The RANKING is not chrome's and does not
		// move -- it reads four things that live only in the page -- so what
		// crosses is rows, not a request for them. See lib/gapsPane.js.
		case 'gaps-open': {
			let entry = open_.get(tabID);
			if (entry) gapsPane.open(entry, on => send(entry, 'zgGapsShowing', { showing: on }));
			break;
		}
		case 'gaps-rows': {
			let entry = open_.get(tabID);
			if (entry) gapsPane.rows(entry, msg, fromPane(win, tabID, scope));
			break;
		}
		case 'gaps-close': {
			let entry = open_.get(tabID);
			if (entry) gapsPane.close(entry);
			break;
		}
		// Which rows are in the pick. Worked out on the page for the same reason
		// the ranking is: the selection lives there, and a second model of it
		// over here could only come to disagree.
		case 'gaps-lit': {
			let entry = open_.get(tabID);
			if (entry) gapsPane.marks(entry, msg);
			break;
		}
		// A row clicked, and which of the canvas's four gestures it was. A row
		// is one node -- the ghost for the work the library does not hold -- so
		// its key is the whole of what crosses.
		case 'gaps-focus': {
			let entry = open_.get(tabID);
			if (entry) {
				send(entry, 'zgGapsFocus', JSON.stringify({
					key: msg.key || null,
					isolate: !!msg.isolate,
					add: !!msg.add,
				}));
			}
			break;
		}
		// The bar's search field: Zotero's own Quick Search and Advanced Search,
		// run here because the page cannot reach Zotero.Search, and drawn here
		// because the mode menu and the condition editor are XUL. See
		// lib/searchPane.js.
		case 'quick-search': {
			let entry = open_.get(tabID);
			if (!entry || typeof msg.text !== 'string') break;
			let itemIDs = await searchPane.quickSearch(entry, msg.text);
			send(entry, 'zgQuickSearch', { seq: msg.seq, itemIDs });
			break;
		}
		case 'search-mode': {
			let entry = open_.get(tabID);
			if (entry) send(entry, 'zgSetSearchMode', searchPane.modeInfo());
			break;
		}
		case 'search-mode-menu': {
			let entry = open_.get(tabID);
			if (entry) searchPane.openModeMenu(entry, msg, (fn, value) => send(entry, fn, value));
			break;
		}
		case 'advanced-search': {
			let entry = open_.get(tabID);
			if (entry) await searchPane.advanced(entry, msg, (fn, value) => send(entry, fn, value));
			break;
		}
		case 'advanced-search-rect': {
			let entry = open_.get(tabID);
			if (entry) searchPane.place(entry, msg);
			break;
		}
		// The graph page runs with a content principal and cannot open a browser
		// itself. Only http(s) is passed on: a held item's URL comes from the
		// Zotero `url` field, which is free text and routinely holds a local
		// path -- and this ends up at the OS handler.
		case 'open-url':
			if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
				Zotero.launchURL(msg.url);
			}
			break;
		// Zotero's own item menu, over the node the user right-clicked. Chrome's
		// to build and to open for the same reason as the item pane below: it is
		// a XUL popup in the main window, and the graph page is content. See
		// lib/nodeMenu.js.
		//
		// Like 'item-pane-show', this message carries the selection, and for the
		// same reason: the menu is about what is picked, and every core command
		// on it asks ZoteroPane what is selected. Recorded before the menu is
		// built, because that is what the builder reads.
		//
		// It is a list, not one id: a right click inside a Ctrl-picked set is a
		// menu about the whole set, which is what makes "Add to Collection" over
		// four ringed nodes file the four of them. The page has already made
		// sure the node clicked is in that set -- see openNativeMenu().
		//
		// A node with no item behind it is not turned away: core answers an empty
		// selection with the menu it gives an empty item tree, every row of it
		// disabled, and this plugin's own two entries still mean what they say.
		// Refusing instead would leave the page holding the node it right-clicked,
		// waiting for a menu that never came.
		// TEMPORARY, with content/graph.js's trace(): the page has no log of its
		// own, and the question is what reaches it and in which order.
		case 'trace':
			trace.log('page: ' + msg.text);
			break;
		case 'node-menu': {
			let entry = open_.get(tabID);
			if (!entry) break;
			entry.selection = Array.isArray(msg.itemIDs) ? msg.itemIDs.slice() : [];
			await nodeMenu.open(entry, msg, (fn, value) => send(entry, fn, value));
			break;
		}
		// The page dismissing a menu it no longer wants on screen -- a rebuild
		// landing under one, or a second node asking for its own.
		case 'node-menu-close': {
			let entry = open_.get(tabID);
			if (entry) nodeMenu.close(entry.win);
			break;
		}
		// The button at the far end of the page's top bar, which is only on
		// screen while the panel is away -- the panel takes its sidenav, and
		// core's own Toggle Item Pane with it, down when it collapses. So this
		// is the way back, and it is the reader's way back: the same control in
		// the same place, handed from the sidenav to the toolbar as the toolbar
		// grows into the space the pane leaves.
		//
		// It is also the way IN. A tab that has just opened has no panel yet,
		// and the button used to be hidden until one existed -- which left a
		// fresh graph tab with no way to ask for the pane at all, where the
		// library tab has its item pane beside the list from the start. So a
		// press with no panel builds one, and it carries the pick to build it
		// from: an empty pick is not an empty pane, it is core's own "N items in
		// this view", which is exactly what the library shows with nothing
		// selected. Hence `expand`, the same request selectItems() makes -- a
		// press of this button is an explicit ask to see the pane.
		case 'item-pane-toggle': {
			let entry = open_.get(tabID);
			if (!entry) break;
			if (entry.pane) {
				itemPane.collapse(entry, !splitPane.collapsed(entry));
				break;
			}
			entry.selection = Array.isArray(msg.itemIDs) ? msg.itemIDs.slice() : [];
			await itemPane.show(entry, entry.selection, {
				inView: Number(msg.inView) || 0,
				expand: true,
				status: t => send(entry, 'zgSetStatus', t),
			});
			break;
		}
		// Zotero's own item pane, beside the graph, describing what is picked.
		// Chrome's to open for the same reason as the reader pane:
		// <item-details> is a XUL custom element in the main window, and the
		// graph page is content. See itemPane.js.
		//
		// This is also the message that carries the selection, because a click
		// on a held node IS both questions at once -- which paper to describe,
		// and which paper the user means. A second message raised alongside
		// this one could only ever come to disagree with it.
		//
		// It carries the WHOLE pick, empty sets included, because the pane has
		// something to say about every one of them: one paper's sections,
		// several papers and an offer to edit them together, or -- for an empty
		// pick -- how many items are in the view, which is why `inView` travels
		// with it. That is the library's own item pane, answering as it does
		// for a collection with nothing selected in it.
		case 'item-pane-show': {
			let entry = open_.get(tabID);
			if (entry) {
				// Recorded first, and outside the pane's own guards: show()
				// draws nothing while the pane is collapsed, and the click
				// selected the paper either way. What Locate acts on must not
				// depend on whether the pane was on screen.
				entry.selection = Array.isArray(msg.itemIDs) ? msg.itemIDs.slice() : [];
				await itemPane.show(entry, entry.selection, {
					inView: Number(msg.inView) || 0,
					status: t => send(entry, 'zgSetStatus', t),
				});
			}
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
	let { scope, options } = entry;
	let cache = await PdfLinkCache.forProfile().load();
	let adapter = new ZoteroAdapter(scope, { cache, recursive: options.recursive });
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
		// What a strategy could say about a node it invented, as opposed to what
		// the network was asked. Kept apart from `metadata` because the two are
		// filled at different times and by different means, and because the
		// lookup assigns `metadata` wholesale -- folding these in would lose them
		// the moment it ran.
		described: Object.create(null),
		heldCounts: Object.create(null),
		// How many rows the user picked, for a selection; null for a collection,
		// where the question does not arise. Filled by phase 1 below.
		picked: null,
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
	// Written as one flat conditional with no call inside it: the l10n audit
	// in tools/test-cjs-shim.js scans a t(...) call for quoted ids and stops at
	// the first ')', so a nested call here would hide all three from it.
	status(l10n.t(scope.kind === 'selection' ? 'build-loading-selection'
		: options.recursive ? 'build-loading-collection-recursive'
		: 'build-loading-collection'));
	let items = await adapter.listItems();
	if (!alive()) return;
	state.items = items;
	state.inCollection = new Set(items.map(i => i.key));
	// How many rows were picked against how many became nodes. Only ever
	// different for a selection, and different silently: itemRecord() declines
	// a note, an attachment whose parent is already here, and an untitled
	// record, so ten rows can become seven papers with nothing on screen saying
	// which three went. Carried on every payload from here, since the page
	// re-states it whenever it re-states the count.
	state.picked = adapter.picked;
	// The title is the count, for a selection, and the count is only known now.
	retitle(entry, items.length);
	// Stamped 'done', not 'items': the renderer reads any other phase as work
	// still in flight, and would go on saying "building..." over a canvas that
	// is never going to get anything on it. The one payload an empty collection
	// produces has to be a finished one. The `empty` block is what the page
	// paints its card from, and says whether there is a next thing to try.
	if (!items.length) {
		push([], { phase: 'done', items: 0, empty: emptyReason(scope, options) });
		// The card is the single voice. A pill in the opposite corner saying
		// the same thing in fewer words is half of what made this confusing.
		status('');
		return;
	}
	push([], { phase: 'items', items: items.length });

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

	// --- phase 3b: OpenAlex references ---------------------------------
	// The one strategy that asks the network, so it runs only when its switch
	// is on. Both caches are the point: a paper is asked about once per TTL,
	// and the one request that brings its references brings its own name and
	// count as well, which the metadata lookup then finds instead of asking.
	let oaResult = null;
	if (options.openalexRefs) {
		push(mergeEdges(textResult.edges, pdfResult.edges), {
			phase: 'pdf',
			items: items.length,
			perProvider: { ...textResult.meta.perProvider, ...pdfResult.meta.perProvider },
			errors: [...textResult.meta.errors, ...pdfResult.meta.errors],
		});
		status(l10n.t('build-openalex-references'));
		let [refCache, metaCache] = await Promise.all([
			MetadataCache.forProfile({ file: REFERENCE_CACHE_FILE }).load(),
			MetadataCache.forProfile().load(),
		]);
		oaResult = await cg.build(adapter, {
			enable: ['openalex'],
			includeExternal: options.includeExternal,
			providers: {
				openalex: {
					apiKey: pref('openalex.apiKey') || null,
					cache: refCache,
					metadataCache: metaCache,
				},
			},
			onProgress: throttle(p => status(l10n.t('build-openalex-progress', p))),
		});
		await Promise.all([refCache.flush(), metaCache.flush()]);
		if (!alive()) return;
		logMeta('openalex', oaResult);
	}

	// --- phase 3c: parsed reference strings -----------------------------
	// Offline, but its own phase and its own switch, because it is the only
	// strategy that adds NODES: it names works no identifier was printed for,
	// which is the population every other offline strategy is blind to. It runs
	// last of the deriving phases so that the DOIs the others resolved are
	// already in hand -- an entry whose DOI text-doi matched is a node that
	// exists, and this one joins it rather than inventing a second.
	let refResult = null;
	if (options.refStrings) {
		push(mergeEdges(textResult.edges, pdfResult.edges, ...(oaResult ? [oaResult.edges] : [])), {
			phase: 'pdf',
			items: items.length,
			perProvider: Object.assign({}, textResult.meta.perProvider, pdfResult.meta.perProvider,
				oaResult ? oaResult.meta.perProvider : null),
			errors: [...textResult.meta.errors, ...pdfResult.meta.errors,
				...(oaResult ? oaResult.meta.errors : [])],
		});
		status(l10n.t('build-reading-references'));
		refResult = await cg.build(adapter, {
			enable: ['ref-strings'],
			offline: true,
			includeExternal: options.includeExternal,
			onProgress: throttle(p => status(l10n.t('build-reading-references-progress', p))),
		});
		if (!alive()) return;
		logMeta('ref-strings', refResult);
	}

	let results = [textResult, pdfResult]
		.concat(oaResult ? [oaResult] : [])
		.concat(refResult ? [refResult] : []);
	let edges = mergeEdges(...results.map(r => r.edges));
	// What the strategies could say about the nodes they invented, before any
	// network call. Only ref-strings writes here, and only about outside works:
	// a `ref:` node is identified by a parsed title and has nothing else to be
	// drawn as, so this is the difference between a named ghost and a blank dot.
	state.described = Object.assign(Object.create(null), ...results.map(r => r.described || null));
	// Fold the same work back together where two strategies named it two ways --
	// `doi:` from the paper that printed one, `ref:` from the paper that did not.
	// Offline, because ref-strings describes the DOI nodes as well as its own;
	// the lookup runs it again later over the names OpenAlex brought.
	edges = consolidateRefs(state, edges);
	let baseMeta = {
		items: items.length,
		perProvider: Object.assign({}, ...results.map(r => r.meta.perProvider)),
		errors: [].concat(...results.map(r => r.meta.errors)),
		adapter: adapter.stats,
	};
	// What a lookup would ask for, worked out before the push so the payload can
	// say truthfully whether one is still to come. Ghosts need a name; held
	// items already have one and need only the global count, which is what
	// makes "size by global citations" meaningful for the whole graph rather
	// than half of it. Both are DOIs, so they go in one batched pass -- doiKey
	// is the shared address space, and with outside refs off the held items are
	// the whole of it.
	let heldByDoiKey = new Map();
	for (let it of items) {
		let d = normDoi(it.doi);
		if (d) heldByDoiKey.set(externalKey('doi', d), it.key);
	}
	// The derived graph, kept so that switching the lookup on later costs one
	// phase instead of a whole build. `derivedEdges` is what the strategies
	// found; a lookup may re-key OpenAlex references onto DOIs over a copy of
	// it, and switching the lookup off goes back to it.
	state.edges = edges;
	entry.built = { state, baseMeta, derivedEdges: edges, ghostKeys: ghostKeysOf(state), heldByDoiKey };

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
 * Why the canvas is blank, and whether there is an obvious next thing to try.
 *
 * Only ever asked when the collection produced no regular item at all, which
 * has three causes that look identical on screen: the collection is empty, it
 * holds nothing but attachments and notes, or everything in it is one level
 * down and subcollections are switched off. The last one is the only one the
 * page can offer to fix, so it is the only one worth reporting in detail.
 *
 * getChildCollections(true) returns ids, so this counts them without loading
 * a single collection.
 */
function emptyReason(scope, options) {
	// A selection has no subtree, so there is nothing to offer to widen to and
	// the card must not offer it. What it says instead is why a pick of rows
	// came to nothing: every one of them was a note, an attachment, or a record
	// with no title. See #empty-body in content/graph.js.
	if (isSelection(scope)) {
		return {
			selection: true,
			picked: (scope.itemKeys || []).length,
			recursive: false,
			subcollections: 0,
		};
	}
	let subcollections = 0;
	try {
		subcollections = scope.collection.getChildCollections(true).length;
	}
	catch (e) {
		// A count we cannot take is a hint we cannot offer, not a failed build.
		Zotero.logError(e);
	}
	return { selection: false, picked: null, recursive: !!options.recursive, subcollections };
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
			built.state.edges = built.derivedEdges;
			built.state.metadata = Object.create(null);
			built.state.heldCounts = Object.create(null);
			built.ghostKeys = ghostKeysOf(built.state);
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
 * The outside references a lookup should name: the most-cited DOIs, as
 * before, and the OpenAlex references as well. The latter are not a nicety.
 * One is known only by its OpenAlex ID until it is named, and a work cited
 * once through a PDF's DOI link and once through OpenAlex is two ghosts cited
 * once each until the name brings its DOI -- see rekeyByDoi().
 */
function ghostKeysOf(state) {
	let external = cg.collectExternalNodes(state.edges, k => state.inCollection.has(k));
	// `ref:` nodes are left out entirely: no enricher declares that namespace,
	// so core/enrich.js would never ask about one -- but they would still spend
	// the MAX_ENRICH budget that the DOI ghosts need, and they already carry the
	// only name they are ever going to have.
	let byDoi = external.filter(x => x.ns !== 'openalex' && x.ns !== 'ref').slice(0, MAX_ENRICH);
	let byOpenAlex = external.filter(x => x.ns === 'openalex').slice(0, MAX_ENRICH_REFERENCES);
	return [...byDoi, ...byOpenAlex].map(x => x.key);
}

/**
 * An OpenAlex reference stands in under its OpenAlex ID until the lookup
 * names it, and the name comes with the work's DOI. Re-keyed to 'doi:<doi>'
 * -- or to the held paper with that DOI -- it becomes the very node the same
 * work has when a PDF links it, so a work cited through both is one ghost
 * cited twice rather than two ghosts cited once each.
 *
 * Only ever run by the lookup, because it reads names: with "query node
 * metadata" off an OpenAlex reference stays exactly what the strategy found.
 * The metadata moves with the node, since names are keyed like nodes.
 */
function rekeyByDoi(state, heldByDoiKey) {
	let to = new Map();
	for (let e of state.edges) {
		if (to.has(e.to) || !e.to.startsWith('openalex:')) continue;
		let m = state.metadata[e.to];
		let d = m && normDoi(m.doi);
		if (!d) continue;
		let doiKey = externalKey('doi', d);
		to.set(e.to, heldByDoiKey.get(doiKey) || doiKey);
		if (!state.metadata[doiKey]) state.metadata[doiKey] = { ...m, key: doiKey };
	}
	if (!to.size) return;
	state.edges = mergeEdges(state.edges.map(e => (to.has(e.to) ? { ...e, to: to.get(e.to) } : e)))
		.filter(e => e.from !== e.to);
}

/**
 * What is known about one node, whoever found it out.
 *
 * Fill-first with the lookup ahead of the parse, which is core/enrich.js's own
 * policy and for its own reason: OpenAlex's title came from the publisher's
 * record, the parsed one came out of somebody else's bibliography. But a parsed
 * title is the only one a `ref:` node will ever have -- nothing resolves that
 * namespace -- so the parse fills every field the lookup did not, rather than
 * being replaced by it.
 */
function describeNode(state, key) {
	// Both halves are optional: pushData is reachable with a state assembled by
	// hand -- the tests do exactly that -- and a graph with no parsed references
	// in it never grows a `described` at all.
	let parsed = state.described && state.described[key];
	let looked = state.metadata && state.metadata[key];
	if (!parsed) return looked || null;
	if (!looked) return parsed;
	let out = { ...parsed };
	for (let f of Object.keys(looked)) {
		if (looked[f] == null) continue;
		if (Array.isArray(looked[f]) && !looked[f].length) continue;
		out[f] = looked[f];
	}
	// Both contributed, and the card's "source" line should say so.
	out.source = [...new Set([...(parsed.source || []), ...(looked.source || [])])];
	return out;
}

/**
 * Fold the nodes that name one work into one node.
 *
 * The case it exists for: paper A's bibliography prints a DOI for a reference
 * and paper B's does not, so the work becomes `doi:10.1038/...` from one and
 * `ref:<title slug>` from the other -- two ghosts cited once each where the
 * truth is one ghost cited twice. Since the min-citations filter defaults to 2,
 * that split does not merely duplicate a node, it hides one.
 *
 * Run twice, because the titles it keys on arrive at two different times: once
 * during the build, off the parsed names alone, and again after the lookup with
 * whatever OpenAlex resolved. Both go through the same core function, so the
 * offline answer is a subset of the online one rather than a different rule.
 */
function consolidateRefs(state, edges) {
	let out = cg.consolidateByTitle(edges, {
		isInCollection: k => state.inCollection.has(k),
		titleOf: k => describeNode(state, k),
		items: state.items,
	});
	let moved = Object.keys(out.moved).length;
	if (moved) Zotero.debug(`[zotero-citation-graph] consolidated ${moved} outside reference(s) by title`);
	return out.edges;
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
	// Named now, so the OpenAlex references can join the nodes their DOIs
	// already have. Over the derived edges, so a second pass starts clean.
	state.edges = built.derivedEdges;
	rekeyByDoi(state, heldByDoiKey);
	// Again, now that the lookup has named the DOI ghosts: a `ref:` node whose
	// work is held under a DOI could not be recognised as the same work until
	// that DOI had a title to compare against.
	state.edges = consolidateRefs(state, state.edges);
	built.ghostKeys = ghostKeysOf(state);
	state.heldCounts = Object.create(null);
	for (let [doiKey, itemKey] of heldByDoiKey) {
		let m = enriched.metadata[doiKey];
		if (m && m.citedByGlobal != null) state.heldCounts[itemKey] = m.citedByGlobal;
	}

	pushData(entry, state, { phase: 'done', ...baseMeta, enrich: enriched.meta });
	Zotero.debug(`[zotero-citation-graph] enrich -> ${enriched.meta.resolved}/${enriched.meta.requested}`
		+ ` named (${enriched.meta.fromCache} cached) in ${enriched.meta.ms}ms`);
	for (let err of enriched.meta.errors) {
		Zotero.logError(new Error(`[zotero-citation-graph] enrich ${err.provider}: ${err.message}`));
	}
	status('');
}

/**
 * Assemble one payload and send it. Every push goes through here, so a pass
 * that re-sends a graph it did not derive sends exactly what the build that
 * derived it would have sent.
 */
function pushData(entry, state, meta) {
	let { scope, options } = entry;
	// External nodes are recomputed over the combined edge list rather than
	// carried from each build: a work found by both text-doi and pdf-links is
	// one node cited once, not two.
	let external = options.includeExternal
		? cg.collectExternalNodes(state.edges, k => state.inCollection.has(k))
			.slice(0, MAX_EXTERNAL_NODES)
			.map(x => toWireExternal(x, describeNode(state, x.key)))
		: [];
	send(entry, 'zgSetData', {
		// What the graph is OF, as the page needs to say it: the kind decides
		// which controls apply (a selection has no subcollections to include)
		// and the name is what an empty card and a status line read back.
		scope: {
			kind: scope.kind,
			name: scope.collection ? scope.collection.name : '',
			picked: state.picked != null ? state.picked : null,
		},
		// Kept beside it under its old name, because it is what the page has
		// always read and it is still true wherever there is a collection at
		// all. Null for a selection with no anchor.
		collection: scope.collection
			? { key: scope.collection.key, name: scope.collection.name }
			: null,
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
	// What a search is cut down to -- and a search that is running is asked
	// again, since this push may carry items its last answer never saw.
	entry.heldIDs = new Set(state.items.map(it => it.itemID));
	searchPane.refresh(entry);
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
 *
 * Where it goes and what it is marked with are asked first, in a dialog: this
 * is the one thing the graph does that WRITES to the library, and a paper filed
 * somewhere the user did not choose is cheap to undo but tedious to find. See
 * addDialog.js.
 */
async function addByDoi(win, tabID, scope, doi, title) {
	let entry = open_.get(tabID);
	let status = (t) => entry && send(entry, 'zgSetStatus', t);
	// The gap list disables its row the moment the '+' is pressed and gets it
	// back from the rebuild an add ends in. Every path that does NOT rebuild
	// has to say so, or the row stays dead until the next build.
	let settle = () => entry && send(entry, 'zgAddSettled', '');
	let d = normDoi(doi);
	if (!d) {
		status(l10n.t('add-bad-doi', { doi }));
		settle();
		return;
	}

	// The collection this graph is of, until the tab is told otherwise: filing a
	// missing reference beside the papers that cite it is the common case, and
	// it is the collection the ghost was derived from in the first place. A
	// selection made outside any collection has no such place, and a null
	// collectionID is already what addDialog reads as the library root.
	let target = (entry && entry.addTarget) || {
		libraryID: scope.libraryID,
		collectionID: scope.collection ? scope.collection.id : null,
	};
	let choice = await addDialog.open(win, {
		doi: d,
		title: title || null,
		libraryID: target.libraryID,
		collectionID: target.collectionID,
		tag: typeof pref('addTag') === 'string' ? pref('addTag') : '',
		tagOn: pref('addTagEnabled') !== false,
		anchor: entry ? entry.browser : null,
	});
	// The tab can have been closed while the dialog was up; the add still
	// happens, it just has nowhere to report to and nothing to rebuild.
	entry = open_.get(tabID);
	if (!choice) {
		status('');
		settle();
		return;
	}
	// Both halves, whichever way the box was left: an unticked box this once
	// must not be what forgets the tag someone typed.
	setPref('addTag', choice.tag);
	setPref('addTagEnabled', !!choice.tagOn);
	if (entry) {
		entry.addTarget = {
			libraryID: choice.libraryID,
			collectionID: choice.collectionID,
		};
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
			libraryID: choice.libraryID,
			// Empty is the library root, which is what picking the library
			// itself out of the menu means.
			collections: choice.collectionID ? [choice.collectionID] : [],
			// Zotero's own open-access PDF lookup, for free.
			saveAttachments: true,
		});
	}
	catch (e) {
		Zotero.logError(e);
		status(l10n.t('add-failed', { doi: d, message: e && e.message ? e.message : e }));
		settle();
		return;
	}
	if (!newItems.length) {
		status(l10n.t('add-no-metadata', { doi: d }));
		settle();
		return;
	}

	// After the save rather than through it: Zotero.Translate.ItemSaver takes a
	// library and collections and nothing else, so a tag is a second write.
	// Type 0 is a manual tag -- the kind the tag selector offers and colours --
	// which is what someone typing one into the dialog is asking for.
	if (choice.tagOn && choice.tag) {
		try {
			await Zotero.DB.executeTransaction(async () => {
				for (let item of newItems) {
					if (!item.isRegularItem()) continue;
					item.addTag(choice.tag, 0);
					await item.save();
				}
			});
		}
		catch (e) {
			// The paper is in the library either way. A tag that would not
			// stick is a line in the log, not an add reported as failed.
			Zotero.logError(e);
		}
	}

	entry = open_.get(tabID);
	let added = newItems[0].getDisplayTitle();
	if (!entry) return;

	// The ghost's key was 'doi:<doi>'; the work is now a real item with an
	// 8-character key, and every edge pointing at it has to follow.
	let ghostKey = externalKey('doi', d);
	let one = newItems.length === 1 && newItems[0].isRegularItem() ? newItems[0] : null;
	let names = one ? scopeNames(entry, one) : null;

	if (one && !names) {
		// In the library, but not in this graph. Nothing on screen changed, and
		// re-deriving would say exactly that at the price of the whole layout.
		status(l10n.t('add-elsewhere', { title: added }));
		settle();
		return;
	}
	if (one && await adoptAdded(entry, ghostKey, one, names)) {
		status(l10n.t('add-done', { title: added }));
		return;
	}
	// Whatever the graph could not simply take in -- one DOI that resolved to
	// several works, or a tab with no finished build behind it yet.
	status(l10n.t('add-rebuilding', { title: added }));
	await runBuild(tabID);
}

/**
 * Fold a paper just added to the library into the graph already on screen.
 *
 * A rebuild used to do this, and it was the wrong instrument. Nothing about
 * the derivation changed: the same papers cite the same work, and the work
 * merely stopped being a ghost. What a rebuild does do is push an empty edge
 * list through phase 1, which takes every edge off the layout and re-anneals
 * it from nothing over the next two phases -- so the answer to "add this one
 * paper" was the whole graph rearranging itself around it.
 *
 * So this re-keys instead. Every edge that pointed at 'doi:<doi>' points at
 * the item's key, the item joins the collection's own list, and one payload
 * goes out. pushData() recomputes the outside-reference roll-up from the
 * edges on every push, so the ghost stops being one by construction -- and
 * the payload carries the rename, which is what lets the page put the new
 * node exactly where the ghost was. See zgSetData in content/graph.js.
 *
 * What it does NOT do is read the new paper's own PDF for what IT cites.
 * That needs a build, and it is what the next one will find.
 *
 * @returns {Boolean} false if the graph cannot take it in as it stands
 */
async function adoptAdded(entry, ghostKey, item, names) {
	if (!entry || !entry.built || !names) return false;
	await Zotero.Items.loadDataTypes([item]);
	// The very function the build describes its own items with, so a newcomer
	// cannot be described differently from the papers already there.
	let record = itemRecord(item, names);
	if (!record) return false;

	let state = entry.built.state;
	state.items = [...state.items, record];
	state.inCollection.add(record.key);
	// The derived edges too: they are what switching the lookup off goes back
	// to, and the paper is held now either way.
	for (let e of new Set([...state.edges, ...(entry.built.derivedEdges || [])])) {
		if (e.from === ghostKey) e.from = record.key;
		if (e.to === ghostKey) e.to = record.key;
	}
	// The lookup addresses everything by DOI either way, so the work keeps the
	// global count it was named with rather than losing it on promotion.
	let m = state.metadata[ghostKey];
	if (m && m.citedByGlobal != null) state.heldCounts[record.key] = m.citedByGlobal;
	entry.built.heldByDoiKey.set(ghostKey, record.key);
	entry.built.ghostKeys = entry.built.ghostKeys.filter(k => k !== ghostKey);
	// A selection's pick grows by exactly this one paper, and the next rebuild
	// -- which is what reads the new paper's own PDF for what IT cites -- finds
	// it because of this line. saveTabData() puts it where a restart can read
	// it, and the tab's title restates the count.
	if (isSelection(entry.scope) && !entry.scope.itemKeys.includes(record.key)) {
		entry.scope.itemKeys.push(record.key);
		state.picked = state.picked != null ? state.picked + 1 : null;
		saveTabData(entry);
		retitle(entry, state.items.length);
	}

	pushData(entry, state, {
		...entry.built.baseMeta,
		items: state.items.length,
		phase: 'done',
		adopted: { was: ghostKey, now: record.key },
	});
	return true;
}

/**
 * The names of the collections holding `item` that this graph cares about, or
 * null when the graph does not hold the item at all.
 *
 * A COLLECTION graph is one collection -- and its subcollections when
 * `recursive` is on -- so a paper filed anywhere else is in the library without
 * being in the graph, and gets null.
 *
 * A SELECTION graph is different in kind, and deliberately so. Its papers are
 * the ones someone picked, and the only way a paper arrives afterwards is by
 * being added FROM this graph -- the ghost's menu, its detail card, or the + in
 * "what is missing". That is an explicit act about this graph, unlike filing
 * something into an unrelated collection, so the paper joins: the key goes into
 * the frozen pick and the ghost is adopted in place. Its names are every
 * collection in the library holding it, which is what a selection colours by,
 * and `[]` -- truthy, unlike null -- is the right answer for a paper that is on
 * no shelf at all.
 */
function scopeNames(entry, item) {
	if (isSelection(entry.scope)) {
		let names = [];
		try {
			for (let id of item.getCollections()) {
				let c = Zotero.Collections.get(id);
				if (c && c.name && !names.includes(c.name)) names.push(c.name);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		return names;
	}
	let scope = [entry.scope.collection];
	if (entry.options.recursive) {
		try {
			for (let d of entry.scope.collection.getDescendents(false, 'collection')) {
				let c = Zotero.Collections.get(d.id);
				if (c) scope.push(c);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	}
	let held = new Set(item.getCollections());
	let names = scope.filter(c => held.has(c.id)).map(c => c.name);
	return names.length ? names : null;
}

/**
 * Re-label a tab whose title carries a count -- which is every selection tab,
 * and no collection tab. Called once per build, from the phase that first knows
 * how many rows became papers, and again when an added paper joins the pick.
 */
function retitle(entry, count) {
	if (!isSelection(entry.scope)) return;
	try {
		// rename() is async, so its rejection needs catching on the promise as
		// well as here. A tab that keeps a stale count in the strip is worth a
		// line in the log and nothing more, either way.
		Promise.resolve(entry.win.Zotero_Tabs.rename(entry.tabID, tabTitle(entry.scope, count)))
			.catch(e => Zotero.logError(e));
	}
	catch (e) {
		Zotero.logError(e);
	}
}

/**
 * Write the tab's scope back to where a restart can read it.
 *
 * Zotero_Tabs.setTabData merges into tab.data and debounces a session save;
 * the save at quit reads the live tab strip regardless, so this is about the
 * five-minute autosave and about crash recovery rather than the normal path.
 */
function saveTabData(entry) {
	try {
		entry.win.Zotero_Tabs.setTabData(entry.tabID, {
			options: { ...entry.options },
			// A selection's pick is not quite frozen on disk: restore drops keys
			// whose items have gone, and adopting an added paper puts one in. So
			// the list goes back with the options rather than being written once
			// at open -- otherwise a restored tab would go on asking for a paper
			// that no longer exists at every restart.
			itemKeys: entry.scope.itemKeys ? [...entry.scope.itemKeys] : null,
		});
	}
	catch (e) {
		// A scope that will not persist is worth a line in the log and nothing
		// more -- the graph on screen is unaffected.
		Zotero.logError(e);
	}
}

/** Zotero.Prefs auto-prefixes 'extensions.zotero.'; see addon/prefs.js. */
function pref(name) {
	try {
		return Zotero.Prefs.get('zoteroCitationGraph.' + name);
	}
	catch (e) {
		return null;
	}
}

/** The other half of pref(). Only the add dialog writes back so far: what it
 *  was last told to tag with is the answer it opens with next time. */
function setPref(name, value) {
	try {
		Zotero.Prefs.set('zoteroCitationGraph.' + name, value);
	}
	catch (e) {
		Zotero.logError(e);
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
		Zotero.debug(`[zotero-citation-graph] ignoring unknown enricher '${id}' from prefs`);
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
 * all the way to the renderer. See design/external-references.md part 4.
 */
function toWireExternal(x, m) {
	let out = { key: x.key, ns: x.ns, id: x.id, citedBy: x.citedBy, via: x.via };
	if (m) {
		out.title = m.title || null;
		out.creators = m.creators || [];
		out.year = m.year != null ? m.year : null;
		out.citedByGlobal = m.citedByGlobal != null ? m.citedByGlobal : null;
		// Only ever set by ref-strings, for a node with no identifier to show.
		out.venue = m.venue || null;
		out.source = m.source || [];
	}
	return out;
}

/**
 * What Zotero's own windows look like, for a page that cannot see it.
 *
 * Three things, and the page is wrong about all three on its own:
 *
 *   scheme     Zotero's View > Color Scheme forces light or dark regardless of
 *              the OS. A content document's matchMedia only ever reports the
 *              OS, so a forced scheme is invisible from there -- but the MAIN
 *              window's matchMedia does reflect the override, which is what
 *              makes reading it here the whole of the answer.
 *   fontSize   core's root is 13px scaled by this pref.
 *   fontPx     what that comes to on core's root, measured there. The pref
 *              alone is not enough: core applies it in rem, and a rem is not
 *              the same length in this page as on core's root, so the page
 *              came out a size larger than the library beside it.
 *   density    'compact' or 'comfortable', which core's own rules key off.
 *
 * Core pushes all three onto documents it owns through
 * Zotero.UIProperties.registerRoot(), which cannot reach across the privilege
 * boundary. So this reads the same values and hands them over, and the page
 * sets the same three things registerRoot() would have.
 *
 * Every one of them is optional on the far side: a page that is never told
 * keeps following the OS, which is what it did before this existed.
 */
function chromeProps(win) {
	let props = {};
	try {
		props.scheme = win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}
	catch (e) { /* a window with no matchMedia is a window we let follow the OS */ }
	try {
		props.fontSize = Zotero.Prefs.get('fontSize');
		props.density = Zotero.Prefs.get('uiDensity');
	}
	catch (e) { /* likewise for a Zotero that has renamed either pref */ }
	try {
		let px = parseFloat(win.getComputedStyle(win.document.documentElement).fontSize);
		if (px > 0) props.fontPx = px;
	}
	catch (e) { /* the page falls back to 13px scaled by the pref */ }
	return props;
}

/**
 * The item pane's state, back to the page that carries its button.
 *
 * Registered once, on splitPane's own notifier, rather than pushed from the
 * handful of places that open or collapse the panel: the button in the bar is
 * only one of four gestures that move it, and the one thing every one of them
 * has in common is that it goes through splitPane. See splitPane.watch().
 *
 * One fact, not two: whether the panel is on screen. Whether it has ever been
 * built used to travel with it, so that the bar could hide the button until
 * there was something to bring back -- but a pane with nothing picked has
 * something to say, and a tab whose pane has never been built is exactly the
 * tab that most needs the button. See the 'item-pane-toggle' case above.
 */
splitPane.watch((entry) => {
	if (!entry || !open_.has(entry.tabID)) return;
	send(entry, 'zgSetPane', { open: splitPane.showing(entry) });
});

/** Tell every open tab in this window what its chrome looks like now. */
function pushChrome(win) {
	for (let [, entry] of open_) {
		if (!win || entry.win === win) send(entry, 'zgSetChrome', chromeProps(entry.win));
	}
}

/**
 * Watch the three for changes.
 *
 * Per window for the media query -- it is the window's own -- and once for the
 * two prefs, which are global. Both are registered from main.js's per-window
 * setup and handed back a function that undoes them, because a listener on a
 * window that has gone is a leak and an observer that outlives the plugin is
 * worse.
 *
 * All of it is guarded. Following the scheme live is a nicety; losing the whole
 * per-window setup because a Zotero renamed a pref would not be.
 */
function watchChrome(win) {
	let undo = [];

	try {
		let mq = win.matchMedia('(prefers-color-scheme: dark)');
		let onScheme = () => pushChrome(win);
		mq.addEventListener('change', onScheme);
		undo.push(() => mq.removeEventListener('change', onScheme));
	}
	catch (e) {
		Zotero.logError(e);
	}

	for (let pref of ['fontSize', 'uiDensity']) {
		try {
			let id = Zotero.Prefs.registerObserver(pref, () => pushChrome(null));
			undo.push(() => Zotero.Prefs.unregisterObserver(id));
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	return () => {
		for (let fn of undo) {
			try {
				fn();
			}
			catch (e) { /* going away anyway */ }
		}
		undo = [];
	};
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
	Zotero.debug(`[zotero-citation-graph] ${phase} -> ${per || 'nothing'}`);
	for (let err of result.meta.errors) {
		Zotero.logError(new Error(`[zotero-citation-graph] ${err.provider}: ${err.message}`));
	}
}

/**
 * Close every graph tab in a window, mounted or not.
 *
 * This is the teardown for a plugin going away under a Zotero that is staying:
 * resource://zotero-citation-graph/ is about to stop resolving, so a live graph page
 * cannot survive it -- and a 'graph' entry left in session.json would meet a
 * Zotero with no restoreState.graph hook next time, which tabs.js:611 turns
 * into a thrown restore for every later tab. Unmounted tabs are swept too, for
 * exactly that second reason.
 */
function closeAllInWindow(win) {
	for (let [tabID, entry] of [...open_, ...pending_]) {
		if (entry.win !== win) continue;
		try {
			win.Zotero_Tabs.close(tabID);
		}
		catch (e) { /* tab may already be gone */ }
		open_.delete(tabID);
		pending_.delete(tabID);
	}
}

function closeAll() {
	for (let [, entry] of [...open_, ...pending_]) {
		closeAllInWindow(entry.win);
	}
	open_.clear();
	pending_.clear();
}

/**
 * Let go of a window's tabs without closing them -- the teardown for a Zotero
 * that is quitting under a plugin that is staying.
 *
 * The tabs have to stay in the strip: Zotero.Session.save() reads it to build
 * session.json, and a tab closed here is a tab that does not come back. What
 * still has to happen is the panel teardown, since a reader holds listeners on
 * a window that is about to go and an item pane holds Notifier observers.
 */
function forgetWindow(win) {
	for (let [tabID, entry] of [...open_, ...pending_]) {
		if (entry.win === win) dropEntry(tabID);
	}
}

function forgetAll() {
	for (let [tabID] of [...open_, ...pending_]) dropEntry(tabID);
}

module.exports = {
	open, openSelection, restore, restoreMissing, restoreSettled, load, closeAll, closeAllInWindow,
	watchChrome,
	forgetWindow, forgetAll, stripSummary, selectedItemIDs, selectedCollection,
	selectedLibraryID, selectItems,
	mergeEdges, toWireExternal, adoptAdded, rekeyByDoi,
	// Exported for the parsed-reference tests: which outside nodes a lookup is
	// asked about, and how the two kinds of name are merged into one.
	ghostKeysOf, describeNode, consolidateRefs,
	// Exported for the restore tests: what a graph tab is once reduced to what
	// session.json can hold, and how that reads back.
	tabData, restoreOptions, emptyReason, tabTitle,
	// Exported for the scope tests: the two kinds of thing a graph can be of.
	collectionScope, selectionScope, isSelection,
	// Exported for the payload test: what a lookup pass may and may not change
	// about the graph on screen is the whole reason it is not a rebuild.
	pushData,
};
