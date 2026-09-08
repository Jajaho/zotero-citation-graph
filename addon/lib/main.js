/* global Zotero, console */

/**
 * Plugin orchestration: menu registration, per-window setup/teardown, and the
 * entry point the menu item calls.
 */

let graphTab = require('./graphTab.js');
let l10n = require('./l10n.js');

const MENU_ID = 'zotero-graph-collection';
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
		// Before anything that can produce a string. Every t() call after this
		// point is synchronous, and a tab cannot open until startup returns.
		await l10n.load(config.rootURI);
		this.registerMenu();
	},

	async shutdown() {
		try {
			Zotero.MenuManager.unregisterMenu(MENU_ID);
		}
		catch (e) {
			Zotero.logError(e);
		}
		graphTab.closeAll();
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

		// restoreState is the ONE tab hook that must exist for a custom tab type.
		// tabs.js:611 does `let { itemID } = await restoreStateHook(tab, i)` and the
		// missing-hook default returns undefined, so destructuring would throw and
		// abort restore for every later tab. Returning itemID:null and not re-adding
		// the tab makes graph tabs vanish cleanly on restart.
		// Note the indexing: tabHooks[action][type], per _getHook(type, action).
		let hooks = win.Zotero_Tabs && win.Zotero_Tabs.tabHooks;
		if (hooks) {
			if (!hooks.restoreState) hooks.restoreState = {};
			hooks.restoreState.graph = async () => ({ itemID: null });
		}
	},

	onMainWindowUnload(win) {
		let style = win.document.getElementById(TAB_ICON_STYLE_ID);
		if (style) style.remove();

		let hooks = win.Zotero_Tabs && win.Zotero_Tabs.tabHooks;
		if (hooks && hooks.restoreState) {
			delete hooks.restoreState.graph;
		}
		// Close graph tabs so they never reach session.json, in case the hook is
		// already gone by the time restore runs.
		graphTab.closeAllInWindow(win);
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
