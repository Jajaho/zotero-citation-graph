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
let addDialog = require('./addDialog.js');
let readerPane = require('./readerPane.js');
let itemPane = require('./itemPane.js');
let splitPane = require('./splitPane.js');
let l10n = require('./l10n.js');
let trace = require('./trace.js');
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

// tabID -> { win, tabID, browser, split, pane, reader, itemPane, collection,
//             generation, options, built, building, addTarget, selection }
// `split` is the box holding the graph and, once opened, the tab's one side
// panel; `pane` is splitPane.js's record for that panel and `reader` /
// `itemPane` belong to whichever of the two has it. `built` is the
// last completed derivation, which runLookup() names in place; `building`
// says whether a build owns the tab, since a lookup must not push over one.
// `selection` is what the tab answers when Zotero asks which items are
// selected -- see lib/locate.js.
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
 * What a graph tab is, reduced to what has to survive a restart.
 *
 * Zotero_Tabs.getState() serialises tab.data wholesale into session.json, so
 * this IS the persisted form: two collection coordinates and the scope the user
 * set. Everything else about a graph -- its edges, its layout, its names -- is
 * derived, and re-derived far more cheaply than it could be stored honestly.
 * See pdfLinkCache.js and metadataCache.js, which are where the expensive
 * phases already survive a restart, invalidated per input rather than wholesale.
 */
function tabData(collection, options) {
	return {
		collectionKey: collection.key,
		libraryID: collection.libraryID,
		// `icon` is read by tabs.js _update(): with one set, it does not go looking
		// for an item to take a type icon from -- a graph tab has no item, and the
		// lookup it would otherwise attempt leaves the tab with no icon at all.
		// The name lands on the tab's <span> as data-item-type, which is what the
		// stylesheet main.js injects paints. See TAB_ICON_CSS there.
		icon: 'zotero-graph',
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
 * The tab title, which is the collection's name. Read from the live collection
 * on every path including restore, so a collection renamed while its tab was
 * closed comes back under the name it has now rather than the one it had.
 * Control characters are stripped for the reason core's reader hook strips them
 * (tabs.js restoreState): one in a title raises "An invalid or illegal string
 * was specified" and takes the whole restore down with it.
 */
function tabTitle(collection) {
	// Collection first: the tab strip truncates from the right, and which
	// collection this is is the half that distinguishes one graph tab from another.
	let title = l10n.t('tab-title', { collection: collection.name });
	// t() answers with the bare message id when the strings have not landed.
	// Restore can run on a timeline of Zotero's choosing, so this path is not
	// guaranteed to be after startup the way opening from the menu is, and a
	// tab labelled "tab-title" would be a poor way to find that out.
	if (title === 'tab-title') title = collection.name;
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
 * lib/locate.js, standing in for the case core's
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
 * Teardown for a tab that is going away. The container is about to be destroyed
 * anyway, but whatever is in the side panel is not just markup: a reader has
 * listeners on the window and state to flush, an item pane has observers
 * registered with Zotero.Notifier. Closing the panel tells its occupant.
 */
function dropEntry(tabID) {
	let entry = open_.get(tabID);
	try {
		if (entry) splitPane.close(entry);
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
	let { id, container } = win.Zotero_Tabs.add({
		// No hyphen: tabs.js parseTabType() splits the type on '-' to separate
		// the content type from the '-unloaded' state suffix.
		type: 'graph',
		title: tabTitle(collection),
		data: tabData(collection, DEFAULT_OPTIONS),
		select: true,
		onClose: () => dropEntry(id),
	});

	trace.log(`opened a graph tab for ${collection.key}  strip=[${stripSummary(win)}]`);
	mount(win, id, container, collection, config, { ...DEFAULT_OPTIONS })
		.catch(e => Zotero.logError(e));
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

		let collection = tabCollectionSync(tab.data) || await tabCollection(tab.data);
		trace.log(`restore  index=${tabIndex}`
			+ `  key=${(tab.data && tab.data.collectionKey) || '-'}`
			+ `  -> ${collection ? 'restoring' : 'dropped (no such collection)'}`);
		if (!collection) return { itemID: null };

		let id;
		({ id } = win.Zotero_Tabs.add({
			type: 'graph-unloaded',
			title: tabTitle(collection),
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
		let collection = await tabCollection(tab.data);
		if (!collection) {
			// The collection went away between sessions. There is nothing to
			// draw and nowhere honest to say so, since the tab IS the graph of it.
			win.Zotero_Tabs.close(tab.id);
			return;
		}
		let container = win.Zotero_Tabs.getTabContent(tab.id);
		if (!container || container.querySelector('.zg-split')) return;

		await Promise.race([
			mount(win, tab.id, container, collection, config, restoreOptions(tab.data)),
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
function tabCollectionSync(data) {
	if (!data || !data.libraryID || !data.collectionKey) return null;
	try {
		return Zotero.Collections.getByLibraryAndKey(data.libraryID, data.collectionKey) || null;
	}
	catch (e) {
		return null;
	}
}

/**
 * The collection a tab's persisted data points at, or null when it cannot be
 * honoured -- data from before any of this was stored, or a collection deleted
 * while the tab was closed.
 */
async function tabCollection(data) {
	// getIDFromLibraryAndKey() throws on a falsy library id rather than missing.
	if (!data || !data.libraryID || !data.collectionKey) return null;
	try {
		// The awaiting form only. tabCollectionSync() is tried first by every
		// caller that cares about latency, and is deliberately NOT retried here:
		// sharing one try block let a throwing sync call swallow the async
		// fallback with it, which is exactly how a group library would have lost
		// its tabs. Returns false, not null, when there is no such collection.
		let c = await Zotero.Collections.getByLibraryAndKeyAsync(
			data.libraryID, data.collectionKey);
		return c || null;
	}
	catch (e) {
		Zotero.logError(e);
		return null;
	}
}

/**
 * The page itself, inside a tab container that already exists. Shared by a tab
 * opened from the collection menu and one restored from the last session, so
 * the two cannot come to mean different things.
 *
 * @returns {Promise} resolved when the chrome<->content bridge is up. The build
 *          runs on after that, deliberately unawaited -- see load().
 */
function mount(win, tabID, container, collection, config, options) {
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

	open_.set(tabID, {
		win, browser, split, collection,
		// Handed to <item-details>, which watches tab selection by it and stops
		// rendering while some other tab is on screen.
		tabID,
		pane: null,
		reader: null,
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
				ready(win, tabID, browser.contentWindow, collection)
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
			if (msg.doi) await addByDoi(win, tabID, collection, msg.doi, msg.title);
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
				// Asking to read a paper is asking for the panel, and there is
				// one panel: this takes it off the item pane, and opens it
				// again if the panel's chevron had hidden it.
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
		// Zotero's own item pane, beside the graph, describing the node just
		// clicked. Chrome's to open for the same reason as the reader pane:
		// <item-details> is a XUL custom element in the main window, and the
		// graph page is content. See itemPane.js.
		//
		// This is also the message that carries the selection, because a click
		// on a held node IS both questions at once -- which paper to describe,
		// and which paper the user means. A second message raised alongside
		// this one could only ever come to disagree with it.
		case 'item-pane-show': {
			let entry = open_.get(tabID);
			if (entry && msg.itemID) {
				// Recorded first, and outside the pane's own guards: show()
				// draws nothing when the panel is collapsed or the reader has
				// it, and the click selected the paper either way. What Locate
				// acts on must not depend on whether the pane was on screen.
				entry.selection = [msg.itemID];
				await itemPane.show(entry, msg.itemID, {
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
	// Stamped 'done', not 'items': the renderer reads any other phase as work
	// still in flight, and would go on saying "building..." over a canvas that
	// is never going to get anything on it. The one payload an empty collection
	// produces has to be a finished one. The `empty` block is what the page
	// paints its card from, and says whether there is a next thing to try.
	if (!items.length) {
		push([], { phase: 'done', items: 0, empty: emptyReason(collection, options) });
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
function emptyReason(collection, options) {
	let subcollections = 0;
	try {
		subcollections = collection.getChildCollections(true).length;
	}
	catch (e) {
		// A count we cannot take is a hint we cannot offer, not a failed build.
		Zotero.logError(e);
	}
	return { recursive: !!options.recursive, subcollections };
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
 *
 * Where it goes and what it is marked with are asked first, in a dialog: this
 * is the one thing the graph does that WRITES to the library, and a paper filed
 * somewhere the user did not choose is cheap to undo but tedious to find. See
 * addDialog.js.
 */
async function addByDoi(win, tabID, collection, doi, title) {
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
	// it is the collection the ghost was derived from in the first place.
	let target = (entry && entry.addTarget)
		|| { libraryID: collection.libraryID, collectionID: collection.id };
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
	for (let e of state.edges) {
		if (e.from === ghostKey) e.from = record.key;
		if (e.to === ghostKey) e.to = record.key;
	}
	// The lookup addresses everything by DOI either way, so the work keeps the
	// global count it was named with rather than losing it on promotion.
	let m = state.metadata[ghostKey];
	if (m && m.citedByGlobal != null) state.heldCounts[record.key] = m.citedByGlobal;
	entry.built.heldByDoiKey.set(ghostKey, record.key);
	entry.built.ghostKeys = entry.built.ghostKeys.filter(k => k !== ghostKey);

	pushData(entry, state, {
		...entry.built.baseMeta,
		items: state.items.length,
		phase: 'done',
		adopted: { was: ghostKey, now: record.key },
	});
	return true;
}

/**
 * The names of the in-scope collections holding `item`, or null when this
 * graph does not hold it at all. A graph is one collection -- and its
 * subcollections when `recursive` is on -- so a paper filed anywhere else is
 * in the library without being in the graph.
 */
function scopeNames(entry, item) {
	let scope = [entry.collection];
	if (entry.options.recursive) {
		try {
			for (let d of entry.collection.getDescendents(false, 'collection')) {
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
 * Write the tab's scope back to where a restart can read it.
 *
 * Zotero_Tabs.setTabData merges into tab.data and debounces a session save;
 * the save at quit reads the live tab strip regardless, so this is about the
 * five-minute autosave and about crash recovery rather than the normal path.
 */
function saveTabData(entry) {
	try {
		entry.win.Zotero_Tabs.setTabData(entry.tabID, { options: { ...entry.options } });
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
		return Zotero.Prefs.get('zoteroGraph.' + name);
	}
	catch (e) {
		return null;
	}
}

/** The other half of pref(). Only the add dialog writes back so far: what it
 *  was last told to tag with is the answer it opens with next time. */
function setPref(name, value) {
	try {
		Zotero.Prefs.set('zoteroGraph.' + name, value);
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

/**
 * Close every graph tab in a window, mounted or not.
 *
 * This is the teardown for a plugin going away under a Zotero that is staying:
 * resource://zotero-graph/ is about to stop resolving, so a live graph page
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
	open, restore, restoreMissing, restoreSettled, load, closeAll, closeAllInWindow,
	forgetWindow, forgetAll, stripSummary, selectedItemIDs,
	mergeEdges, toWireExternal, adoptAdded,
	// Exported for the restore tests: what a graph tab is once reduced to what
	// session.json can hold, and how that reads back.
	tabData, restoreOptions, emptyReason,
	// Exported for the payload test: what a lookup pass may and may not change
	// about the graph on screen is the whole reason it is not a rebuild.
	pushData,
};
