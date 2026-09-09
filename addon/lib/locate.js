/* global Zotero */

/**
 * What a graph tab tells Zotero about itself when the Locate menu is built.
 *
 * Core answers two questions before it draws that menu, and derives both from
 * the type of the selected tab. A graph tab is a type core has never heard of,
 * so both come out wrong, and both come out wrong in the same place: a `switch`
 * or an `else` with no case for us. Neither has a hook. So this wraps the two
 * functions, answers for the one tab type it knows, and hands every other call
 * straight through.
 *
 * WHICH ITEMS ARE SELECTED. Every Locate action ends up in
 * Zotero_LocateMenu._getSelectedItems(), which is one call to
 * ZoteroPane.getSelectedItems() -- a switch over Zotero_Tabs.selectedType
 * (zoteroPane.js:3606) with a case for `library`, `reader` and `note`, and
 * `default: []`. A graph tab took the default, so the menu built itself out of
 * an empty list: one disabled row reading "0 items selected", whichever node
 * the user had just clicked. The same switch is what makes Locate work in a
 * reader tab, so the shape of the fix is core's own -- a graph tab needs its
 * case. Note the reach: several other core menus route through this function
 * too, and they now see the clicked node as well, which is the same deal a
 * reader tab gets. Chief among them is the item context menu, which lib/
 * nodeMenu.js opens over a node: every command on it asks this question, and
 * the Locate rows at the top of it ask it through _getSelectedItems().
 *
 * WHAT KIND OF CONTEXT IS ASKING. The sidenav's Locate button computes a
 * `locateMode` from container.tabType (itemPaneSidenav.js): `library` for the
 * library tab, and `"tab"` for everything else. One test reads it,
 * ViewItem.canHandleItem (locateMenu.js:435), and it drops the entry that would
 * "open in the same type of the current context" -- so a `"tab"` context is
 * offered View in Window and not View in Tab. That is right for a reader tab,
 * which is already showing the file. A graph tab is showing a graph: opening
 * the PDF in a tab is a real move there, and it is what the node menu's own
 * Locate rows offer, since buildContextMenu() passes no mode at all. So the
 * mode is taken off the options entirely on the way past -- see below for why
 * removed rather than set to something.
 *
 * Installed and removed per window, beside the tab hooks in main.js, because
 * both objects are per window and a plugin being upgraded must not leave a
 * closure over a dead module wired into a window that outlives it.
 */

// One record per window: what we installed, and what we found. The map is weak
// so a closed window is not held open by its own patch.
let installed_ = new WeakMap();

/**
 * @param {Window} win
 * @param {(tabID: string) => number[]} itemIDsFor  the graph tab's selection,
 *        newest click last; see graphTab.selectedItemIDs()
 */
function install(win, itemIDsFor) {
	if (installed_.has(win)) return;

	let record = { inert: false, pane: null, menu: null };
	// Before either wrap: both closures read it to find out whether this
	// plugin still speaks for the window. See uninstall().
	installed_.set(win, record);

	record.pane = wrapGetSelectedItems(win, record, itemIDsFor);
	record.menu = wrapBuildLocateMenu(win, record);

	if (!record.pane && !record.menu) installed_.delete(win);
}

/**
 * Give the window its own functions back.
 *
 * Only the ones ours is still the outermost wrapper of. Another plugin that
 * wrapped after this one owns the property now, and writing core's function
 * back over its wrapper would silently uninstall it; ours stays where it is in
 * that case and the record goes inert, which leaves the chain intact and this
 * plugin out of it.
 */
function uninstall(win) {
	let record = installed_.get(win);
	if (!record) return;
	installed_.delete(win);
	record.inert = true;

	restore(win.ZoteroPane, 'getSelectedItems', record.pane);
	restore(win.Zotero_LocateMenu, 'buildLocateMenu', record.menu);
}

function restore(target, name, wrap) {
	if (!target || !wrap) return;
	if (target[name] === wrap.patched) target[name] = wrap.original;
}

/** The tab on screen is one of ours, and so the question being asked is ours. */
function isGraphTab(win) {
	let tabs = win.Zotero_Tabs;
	return !!tabs && tabs.selectedType === 'graph';
}

function wrapGetSelectedItems(win, record, itemIDsFor) {
	let pane = win.ZoteroPane;
	if (!pane || typeof pane.getSelectedItems !== 'function') return null;
	let original = pane.getSelectedItems;

	// The signature is core's, verbatim. `libraryTabOnly` exists precisely so a
	// caller can ask what the LIBRARY has selected while another tab is on
	// screen -- core's own switch honours it ahead of the tab type, and so must
	// this, or those callers would start getting graph nodes.
	let patched = function (asIDs, options = {}) {
		if (!record.inert && !options.libraryTabOnly && isGraphTab(win)) {
			return resolve(itemIDsFor(win.Zotero_Tabs.selectedID), asIDs);
		}
		return original.call(this, asIDs, options);
	};

	pane.getSelectedItems = patched;
	return { original, patched };
}

function wrapBuildLocateMenu(win, record) {
	let menu = win.Zotero_LocateMenu;
	if (!menu || typeof menu.buildLocateMenu !== 'function') return null;
	let original = menu.buildLocateMenu;

	// Removed rather than set to 'library'. The suppression is keyed on two
	// named contexts and a graph tab is neither -- it is not the tab already
	// showing this file, and it is not a window showing it -- so the honest
	// answer is no mode at all, which is what core's own `{ locateMode } = {}`
	// default already means. Claiming to be a library tab would get the same
	// two entries today by asserting something untrue, and would come apart the
	// first time core gave that value a second meaning.
	let patched = function (locateMenu, options = {}) {
		if (!record.inert && isGraphTab(win)) {
			options = { ...options };
			delete options.locateMode;
		}
		return original.call(this, locateMenu, options);
	};

	menu.buildLocateMenu = patched;
	return { original, patched };
}

/**
 * Item IDs as the graph knows them, in the form the caller asked for.
 *
 * Read through Zotero.Items rather than trusted: the selection is whatever node
 * was last clicked, and an item can be deleted out from under a graph that is
 * still on screen. A stale ID is dropped, which leaves an empty selection and
 * the honest "0 items selected" -- where handing the ID on would throw inside
 * core's menu builder.
 *
 * The parent substitution is core's reader case: Locate is about the paper, not
 * the file. Nodes are regular items today, so this never fires -- but that is a
 * fact about the payload rather than about what belongs here.
 */
function resolve(itemIDs, asIDs) {
	let items = [];
	let seen = new Set();
	for (let id of itemIDs || []) {
		let item = Zotero.Items.get(id);
		if (!item) continue;
		if (item.parentItem) item = item.parentItem;
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		items.push(item);
	}
	return asIDs ? items.map(i => i.id) : items;
}

module.exports = { install, uninstall };
