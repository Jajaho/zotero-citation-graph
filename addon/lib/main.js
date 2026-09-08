/* global Zotero, console */

/**
 * Plugin orchestration: menu registration, per-window setup/teardown, and the
 * entry point the menu item calls.
 */

let graphTab = require('./graphTab.js');
let l10n = require('./l10n.js');

const MENU_ID = 'zotero-graph-collection';

// plugins.js REASONS. Which of these a shutdown carries decides what happens
// to the open graph tabs, and they want three different answers -- see
// shutdown() below.
const REASON_APP_SHUTDOWN = 2;
const REASON_ADDON_UPGRADE = 7;
const REASON_ADDON_DOWNGRADE = 8;
const TAB_ICON_STYLE_ID = 'zotero-graph-tab-icon-style';

/**
 * The graph tab's icon.
 *
 * Core renders every non-library tab's icon as <span class="icon icon-css
 * icon-item-type" data-item-type="..."> and paints it entirely from CSS
 * (components/icons.js CSSItemTypeIcon, tabBar.js) -- there is no hook for a
 * plugin to hand it an image. So the tab carries data.icon = 'zotero-graph',
 * a name no item type uses, and this rule paints that one name.
 *
 * One flat background rather than core's four theme layers: the file draws
 * itself with context-fill, so `fill: currentColor` takes the tab's own text
 * colour and it follows light and dark without a second file.
 */
const TAB_ICON_CSS = resRoot => `
	.tab-icon.icon-item-type[data-item-type="zotero-graph"] {
		background: url("resource://${resRoot}/content/icons/graph.svg")
			no-repeat center/contain;
		-moz-context-properties: fill;
		fill: currentColor;
	}
`;

let _config = null;

module.exports = {
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
			if (win.ZoteroPane) addTabHooks(win);
		}
		// Before anything that can produce a string. Every t() call after this
		// point is synchronous, and a tab cannot open until startup returns.
		await l10n.load(config.rootURI);
		this.registerMenu();
	},

	/**
	 * @param {Integer} reason - plugins.js REASONS; see REASON_APP_SHUTDOWN.
	 */
	async shutdown(reason) {
		try {
			Zotero.MenuManager.unregisterMenu(MENU_ID);
		}
		catch (e) {
			Zotero.logError(e);
		}

		// The hooks first: nothing below should be able to call a load hook
		// belonging to the version being torn down.
		for (let win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) removeWindowIntegration(win);
		}

		// Three reasons, three answers.
		//
		// Zotero quitting: Zotero.Session.save() has already snapshotted the tab
		// strip, synchronously, from the quit-application-granted observer that
		// fires before the quit-application starting this teardown. The tabs are
		// recorded and the windows are going regardless, so closing them here
		// would do nothing but take work off the restore.
		//
		// Being replaced by another version of ourselves: the pages cannot
		// survive it, because resource://zotero-graph/ is about to be
		// re-registered against a new rootURI -- but the tabs can, and an
		// upgrade is much the most common reason this runs at all. They are
		// unloaded rather than closed, so the version coming in inherits them.
		//
		// Being disabled or uninstalled: nothing is coming back, and a 'graph'
		// entry left in session.json meets a Zotero with no restoreState.graph
		// hook -- which is the tabs.js:611 destructure that aborts restore for
		// every tab after it. Those tabs have to go, out of the strip and so
		// out of the session with it.
		if (reason === REASON_APP_SHUTDOWN) graphTab.forgetAll();
		else if (reason === REASON_ADDON_UPGRADE || reason === REASON_ADDON_DOWNGRADE) {
			graphTab.unloadAll();
		}
		else graphTab.closeAll();
	},

	onMainWindowLoad(win) {
		// MenuManager does not call insertFTLIfNeeded (it's commented out in
		// core's menuManager.js), so the plugin has to load its own strings or
		// the menu label renders blank.
		try {
			win.MozXULElement.insertFTLIfNeeded('zotero-graph.ftl');
		}
		catch (e) {
			console.log('insertFTLIfNeeded failed, falling back to a literal label: ' + e);
		}

		addTabIconStyle(win);

		addTabHooks(win);
	},

	onMainWindowUnload(win) {
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
					l10nID: 'zotero-graph-view-citation-graph',
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
};

/**
 * The tab-icon rule, in the main window's own document: the tab strip lives
 * outside every tab's container, so this cannot ride along with the tab the
 * way splitPane.js's stylesheet rides with its panel.
 */
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

/** Everything this plugin put into one main window, taken back out. Shared by
 *  the window closing and by the plugin going away under a window that is not. */
function removeWindowIntegration(win) {
	let style = win.document.getElementById(TAB_ICON_STYLE_ID);
	if (style) style.remove();

	let hooks = win.Zotero_Tabs && win.Zotero_Tabs.tabHooks;
	if (!hooks) return;
	if (hooks.restoreState) delete hooks.restoreState.graph;
	if (hooks.load) delete hooks.load.graph;
}
