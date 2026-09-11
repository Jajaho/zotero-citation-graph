/* global Zotero, console */

/**
 * Plugin orchestration: menu registration, per-window setup/teardown, and the
 * entry point the menu item calls.
 */

let graphTab = require('./graphTab.js');
let tabContext = require('./tabContext.js');
let nodeMenu = require('./nodeMenu.js');
let prefsPane = require('./prefsPane.js');
let l10n = require('./l10n.js');
let trace = require('./trace.js');

// Two entry points, two registrations. MenuManager keys a menu by id and each
// target gets its own popup, so the collection tree's entry and the item
// tree's cannot be one record -- and should not be: they ask different
// questions of the context they are shown in, and answer with different kinds
// of graph. They carry the same label and the same icon, because to the reader
// they are one command: graph what I am pointing at.
const MENU_ID = 'zotero-citation-graph-collection';
const ITEM_MENU_ID = 'zotero-citation-graph-item';

// plugins.js REASONS.APP_SHUTDOWN, the reason Zotero passes when it is quitting
// rather than when the plugin alone is going away. The two want opposite
// teardowns, and the difference is the whole of whether a graph tab comes back.
const REASON_APP_SHUTDOWN = 2;
const TAB_ICON_STYLE_ID = 'zotero-citation-graph-tab-icon-style';

/**
 * The graph tab's icon.
 *
 * Core renders every non-library tab's icon as <span class="icon icon-css
 * icon-item-type" data-item-type="..."> and paints it entirely from CSS
 * (components/icons.js CSSItemTypeIcon, tabBar.js) -- there is no hook for a
 * plugin to hand it an image. So the tab carries data.icon = 'zotero-citation-graph',
 * a name no item type uses, and this rule paints that one name.
 *
 * One flat background rather than core's four theme layers: the file draws
 * itself with context-fill, so `fill: currentColor` takes the tab's own text
 * colour and it follows light and dark without a second file.
 */
const TAB_ICON_CSS = resRoot => `
	.tab-icon.icon-item-type[data-item-type="zotero-citation-graph"] {
		background: url("resource://${resRoot}/content/icons/graph.svg")
			no-repeat center/contain;
		-moz-context-properties: fill;
		fill: currentColor;
	}
`;

let _config = null;

module.exports = {
	// Reached from the Settings pane's inline handlers, which run in the
	// Settings window and see this module only as Zotero.ZoteroCitationGraph.
	prefsPane,

	async startup(config) {
		_config = config;
		// Tab hooks before the await, not after it. Zotero restores its tabs on
		// a schedule of its own -- _loadPane() gets there once the item and
		// collection trees have loaded -- and a graph tab whose restoreState
		// hook is not in place yet is a graph tab that silently vanishes.
		// Nothing in either hook needs a string that has not loaded: tabTitle()
		// falls back to the collection's own name. onMainWindowLoad registers
		// them again for every window, and doing it twice costs nothing.
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) {
				addTabHooks(win);
				addChromeWatch(win);
			}
		}
		// Before anything that can produce a string. Every t() call after this
		// point is synchronous, and a tab cannot open until startup returns.
		await l10n.load(config.rootURI);

		// Restore before registering the menu, and before bootstrap gets as far
		// as onMainWindowLoad: the tab is what the user is waiting to see, and
		// nothing between here and there is needed to draw it. Everything in
		// this loop is idempotent, so onMainWindowLoad repeating it costs
		// nothing -- it is what covers a window opened later.
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			addTabIconStyle(win);
			addTabContext(win);
			graphTab.restoreMissing(win).catch(e => Zotero.logError(e));
		}

		this.registerMenu();
		this.registerItemMenu();
		// Not awaited: nothing a graph tab needs waits on the Settings window.
		prefsPane.register(config).catch(e => Zotero.logError(e));
	},

	/**
	 * @param {Integer} reason - plugins.js REASONS; see REASON_APP_SHUTDOWN.
	 */
	async shutdown(reason) {
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) {
				trace.log(`shutdown reason=${reason}`
					+ `  -> ${reason === REASON_APP_SHUTDOWN ? 'forgetAll (tabs kept)' : 'closeAll (tabs closed)'}`
					+ `  strip=[${graphTab.stripSummary(win)}]`);
			}
		}
		for (let id of [MENU_ID, ITEM_MENU_ID]) {
			try {
				Zotero.MenuManager.unregisterMenu(id);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		prefsPane.unregister();

		// The hooks first: nothing below should be able to call a load hook
		// belonging to the version being torn down.
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) removeWindowIntegration(win);
		}

		// Zotero quitting: Zotero.Session.save() has already snapshotted the tab
		// strip, synchronously, from the quit-application-granted observer that
		// fires before the quit-application starting this teardown. The tabs are
		// recorded and the windows are going regardless, so closing them here
		// would do nothing but take work off the restore.
		//
		// Every other reason -- disable, uninstall, upgrade -- leaves Zotero
		// running while resource://zotero-citation-graph/ stops resolving underneath a
		// live graph page. Those tabs have to go, and they have to go out of
		// session.json with them: a 'graph' entry restored by a Zotero with no
		// restoreState.graph hook is the throw at tabs.js:611 that aborts
		// restore for every tab after it.
		if (reason === REASON_APP_SHUTDOWN) graphTab.forgetAll();
		else graphTab.closeAll();

		// The process is about to end; an unflushed line is a line that never
		// existed, and this one is the whole point of the file.
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) trace.log(`shutdown done  strip=[${graphTab.stripSummary(win)}]`);
		}
		await trace.flush();
	},

	onMainWindowLoad(win) {
		// MenuManager does not call insertFTLIfNeeded (it's commented out in
		// core's menuManager.js), so the plugin has to load its own strings or
		// the menu label renders blank.
		try {
			win.MozXULElement.insertFTLIfNeeded('zotero-citation-graph.ftl');
		}
		catch (e) {
			console.log('insertFTLIfNeeded failed, falling back to a literal label: ' + e);
		}

		addTabIconStyle(win);
		addTabHooks(win);
		addChromeWatch(win);
		addTabContext(win);
		// Was the session carrying a graph tab, and had restore already run by
		// the time this plugin got here? Those two answers together say whether
		// a lost tab was lost on the way out or on the way back in.
		trace.log(`window load  session=[${sessionSummary()}]  strip=[${graphTab.stripSummary(win)}]`);
		// Restore usually finishes before this plugin is loaded, so the hook
		// above is the fast path and this is the one that actually runs. See
		// graphTab.restoreMissing().
		graphTab.restoreMissing(win).catch(e => Zotero.logError(e));
	},

	onMainWindowUnload(win) {
		trace.log(`window unload  strip=[${graphTab.stripSummary(win)}]`);
		removeWindowIntegration(win);
		// Deliberately not closeAllInWindow(): the tabs have to stay in the strip
		// for ZoteroPane.destroy() to hand to Zotero.Session, which is what puts
		// them in session.json for restore() to find. Their side panels still
		// have to be told, which is what this does.
		graphTab.forgetWindow(win);
	},

	registerMenu() {
		Zotero.MenuManager.registerMenu({
			menuID: MENU_ID,
			pluginID: _config.pluginID,
			target: 'main/library/collection',
			menus: [
				{
					menuType: 'menuitem',
					l10nID: 'zotero-citation-graph-view-citation-graph',
					// The same file the manifest lists as the plugin icon. It paints
					// itself with context-fill, which is what Zotero sets on menu
					// images, so it follows the menu's own colour in both themes.
					icon: `resource://${_config.resRoot}/content/icons/graph.svg`,
					onShowing: (event, ctx) => {
						// Never read ctx.collectionTreeRow -- core defines it as a
						// getter that throws for multi-selection.
						let rows = (ctx && ctx.collectionTreeRows) || [];
						let ok = rows.length === 1 && rows[0].isCollection && rows[0].isCollection();
						let el = event.target;
						el.hidden = !ok;
						// Fallback if the FTL string didn't resolve through the
						// window's own bundle -- the same message, read straight
						// out of the file this plugin ships.
						if (ok && !el.getAttribute('label')) {
							el.setAttribute('label', l10n.attr('view-citation-graph', 'label'));
						}
					},
					onCommand: (event, ctx) => {
						let rows = (ctx && ctx.collectionTreeRows) || [];
						if (rows.length !== 1) return;
						let collection = rows[0].ref;
						let win = event.target.ownerGlobal;
						graphTab.open(win, collection, _config).catch(e => Zotero.logError(e));
					},
				},
			],
		});
	},

	/**
	 * The same command on the ITEM tree's context menu, over the papers the user
	 * has selected -- which is the other unit anyone asks this question about.
	 * A collection is the shelf; a selection is the handful you pulled off it,
	 * and "what do these few cite in common" has had no way to be asked until
	 * now except by building a collection and then filtering it back down.
	 *
	 * Note where it lands. MenuManager puts every plugin's entries after a
	 * separator at the foot of the popup, and folds the overflow into a
	 * submenu once the popup would run past 80% of the screen (_groupMenus,
	 * _computeAvailableMenuNum). The item menu is long, so this will not sit
	 * where the collection entry sits -- the icon is what carries it.
	 */
	registerItemMenu() {
		Zotero.MenuManager.registerMenu({
			menuID: ITEM_MENU_ID,
			pluginID: _config.pluginID,
			target: 'main/library/item',
			menus: [
				{
					menuType: 'menuitem',
					// The same string and the same icon as the collection entry:
					// one command, two things to point it at.
					l10nID: 'zotero-citation-graph-view-citation-graph',
					icon: `resource://${_config.resRoot}/content/icons/graph.svg`,
					onShowing: (event, ctx) => {
						let el = event.target;
						el.hidden = !graphableKeys(ctx).length;
						if (!el.hidden && !el.getAttribute('label')) {
							el.setAttribute('label', l10n.attr('view-citation-graph', 'label'));
						}
					},
					onCommand: (event, ctx) => {
						let keys = graphableKeys(ctx);
						if (!keys.length) return;
						let win = event.target.ownerGlobal;
						graphTab.openSelection(
							win, keys[0].libraryID, keys.map(k => k.key), anchorCollection(ctx), _config
						).catch(e => Zotero.logError(e));
					},
				},
			],
		});
	},
};

/**
 * The selected rows reduced to the papers a graph could be built from, as
 * { libraryID, key }. Empty means there is nothing to offer and the entry stays
 * hidden.
 *
 * Four reductions, each of them something the item tree can hand us that the
 * graph cannot draw:
 *
 *  - A FEED's items are not library items, have no attachments and cannot be
 *    read for references. Checked on the tree row rather than per item, since
 *    that is where the answer is cheap and unambiguous.
 *  - A TRASHED item is left out, for the reason a collection's own
 *    getChildItems(false, false) leaves them out: the trash is not the library.
 *  - A CHILD row -- an attachment or note under an expanded item -- stands for
 *    its parent. Right-clicking a PDF is asking about the paper, which is the
 *    rule Locate already goes by (lib/tabContext.js resolve()).
 *  - Anything that is still not a REGULAR item after that -- a standalone note,
 *    an annotation -- has no place in a citation graph.
 *
 * Deliberately NOT reduced here: an item with no title. itemRecord() declines
 * those, and the build reports the shortfall on the stats line rather than the
 * menu quietly pretending the row was never picked. The menu's job is to say
 * whether there is anything worth opening a tab for.
 *
 * One item is enough. A single paper with outside references on is the honest
 * question "what does this cite", and graphTab.openSelection() switches them on
 * for exactly that case.
 */
function graphableKeys(ctx) {
	let rows = (ctx && ctx.collectionTreeRows) || [];
	// Never read ctx.collectionTreeRow -- core defines it as a getter that
	// throws for multi-selection.
	if (rows.length === 1 && rows[0].isFeedsOrFeed && rows[0].isFeedsOrFeed()) return [];

	let out = [];
	let seen = new Set();
	for (let item of (ctx && ctx.items) || []) {
		try {
			let it = item;
			if (it.parentItem) it = it.parentItem;
			if (it.deleted) continue;
			if (!it.isRegularItem()) continue;
			if (seen.has(it.key)) continue;
			seen.add(it.key);
			out.push({ libraryID: it.libraryID, key: it.key });
		}
		catch (e) {
			// One row we cannot read is one row left out, not a menu that
			// throws while it is being built.
			Zotero.logError(e);
		}
	}
	return out;
}

/**
 * The collection a selection was made in, when it was made in one -- the anchor
 * a selection graph keeps for every question that is about a place in the
 * library rather than about the papers: where a newly added work is filed, and
 * whether this can be written to at all. Null in My Library, a saved search, a
 * tag view or unfiled items, where the library itself answers instead. See
 * lib/tabContext.js.
 */
function anchorCollection(ctx) {
	let rows = (ctx && ctx.collectionTreeRows) || [];
	if (rows.length !== 1) return null;
	let row = rows[0];
	return row.isCollection && row.isCollection() ? row.ref : null;
}

/**
 * What session.json held for the main window, as a list of tab types.
 * Zotero.Session.state is the parsed file, so this is what restore was given.
 */
function sessionSummary() {
	try {
		let pane = (Zotero.Session.state.windows || []).find(w => w.type === 'pane');
		return pane ? pane.tabs.map(t => t.type).join(',') : 'no pane window';
	}
	catch (e) {
		return '?';
	}
}

/**
 * The tab-icon rule, in the main window's own document: the tab strip lives
 * outside every tab's container, so this cannot ride along with the tab the
 * way splitPane.js's stylesheet rides with its panel.
 */
/** win -> the function that undoes addChromeWatch() for it. */
let _chromeWatch = new WeakMap();

function addTabIconStyle(win) {
	let doc = win.document;
	if (doc.getElementById(TAB_ICON_STYLE_ID)) return;
	let style = doc.createElement('style');
	style.id = TAB_ICON_STYLE_ID;
	style.textContent = TAB_ICON_CSS(_config.resRoot);
	doc.documentElement.appendChild(style);
}

/**
 * The two tab hooks a graph tab needs, in the window's own Zotero_Tabs.
 *
 * restoreState is the ONE that must exist for a custom tab type: tabs.js:611
 * does `let { itemID } = await restoreStateHook(tab, i)` and the missing-hook
 * default returns undefined, so destructuring would throw and abort restore for
 * every later tab. load is what makes restore lazy -- see graphTab.restore().
 *
 * Note the indexing: tabHooks[action][type], per _getHook(type, action).
 */
function addTabHooks(win) {
	let hooks = win.Zotero_Tabs && win.Zotero_Tabs.tabHooks;
	if (!hooks) return;
	if (!hooks.restoreState) hooks.restoreState = {};
	if (!hooks.load) hooks.load = {};
	hooks.restoreState.graph = (tab, tabIndex) => graphTab.restore(win, tab, tabIndex);
	hooks.load.graph = tab => graphTab.load(win, tab, _config);
}

/**
 * Keep the graph's colours, type size and density agreeing with the window's.
 *
 * The page is told all three when it loads; this is what tells it again when
 * one of them changes under it, so that switching Zotero to dark does not leave
 * one tab light until it is reopened. The listener belongs to the window, so
 * the function that removes it is kept beside everything else this plugin has
 * to take back out.
 */
function addChromeWatch(win) {
	// Once per window, however many times it is asked for. startup() runs this
	// for every window already open and onMainWindowLoad runs it again for the
	// same ones, and a second watch would overwrite the closure that takes the
	// first one back out -- leaving a pair of pref observers that nothing can
	// unregister, still calling pushChrome() long after this plugin is gone.
	// Its neighbours in that pair carry their own guard; this is the one for
	// this one.
	if (_chromeWatch.has(win)) return;
	_chromeWatch.set(win, graphTab.watchChrome(win));
}

/**
 * Teach this window what a graph tab IS -- what it has selected, which
 * collection it is a view of, and whether that collection can be written to --
 * so that core's menus act on the node the user clicked rather than on nothing
 * at all. See lib/tabContext.js for why every one of them is a wrapper.
 */
function addTabContext(win) {
	tabContext.install(win, {
		itemIDs: graphTab.selectedItemIDs,
		collection: graphTab.selectedCollection,
		libraryID: graphTab.selectedLibraryID,
		select: graphTab.selectItems,
	});
}

/** Everything this plugin put into one main window, taken back out. Shared by
 *  the window closing and by the plugin going away under a window that is not. */
function removeWindowIntegration(win) {
	tabContext.uninstall(win);

	let unwatch = _chromeWatch.get(win);
	if (unwatch) {
		_chromeWatch.delete(win);
		unwatch();
	}

	// A node menu still up is this plugin's markup on core's popup. Taking it
	// down is what sweeps that markup off again -- see lib/nodeMenu.js -- and a
	// plugin going away under a window that is staying must not leave it there.
	nodeMenu.close(win);

	let style = win.document.getElementById(TAB_ICON_STYLE_ID);
	if (style) style.remove();

	let hooks = win.Zotero_Tabs && win.Zotero_Tabs.tabHooks;
	if (!hooks) return;
	if (hooks.restoreState) delete hooks.restoreState.graph;
	if (hooks.load) delete hooks.load.graph;
}
