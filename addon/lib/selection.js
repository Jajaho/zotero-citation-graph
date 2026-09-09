/* global Zotero */

/**
 * What a graph tab answers when Zotero asks which items are selected.
 *
 * Every Locate action -- the sidenav's green arrow, and the View options above
 * the engines -- ends up in Zotero_LocateMenu._getSelectedItems(), which is one
 * call to ZoteroPane.getSelectedItems(). That function is a switch over
 * Zotero_Tabs.selectedType (zoteroPane.js:3606) with a case for each tab type
 * core ships:
 *
 *   library   the item tree's selection
 *   reader    the item behind the tab, its parent if it has one
 *   note      the item named in the tab's data
 *   default   []
 *
 * A graph tab is none of those, so it takes the default, and the Locate menu
 * over a graph builds itself out of an empty list: one disabled row reading
 * "0 items selected", whichever node the user just clicked. The same switch is
 * what makes Locate work in a reader tab, so the shape of the fix is core's
 * own -- a graph tab needs its case.
 *
 * There is no hook for adding one. So this wraps the function, answers for the
 * one tab type it knows, and hands every other call straight through. The
 * wrapper is deliberately the whole of the integration: nothing else in this
 * plugin has to know that Locate exists, and core keeps deciding what a
 * selection is *for*.
 *
 * Installed and removed per window, beside the tab hooks in main.js, because
 * ZoteroPane is per window and a plugin being upgraded must not leave a closure
 * over a dead module wired into a window that outlives it.
 */

// One record per window: the function we installed, and the one we found. The
// map is weak so a closed window is not held open by its own patch.
let installed_ = new WeakMap();

/**
 * @param {Window} win
 * @param {(tabID: string) => number[]} itemIDsFor  the graph tab's selection,
 *        newest click last; see graphTab.selectedItemIDs()
 */
function install(win, itemIDsFor) {
	let pane = win.ZoteroPane;
	if (!pane || typeof pane.getSelectedItems !== 'function') return;
	if (installed_.has(win)) return;

	let original = pane.getSelectedItems;

	// The signature is core's, verbatim. `libraryTabOnly` exists precisely so a
	// caller can ask what the LIBRARY has selected while another tab is on
	// screen -- core's own switch honours it ahead of the tab type, and so must
	// this, or those callers would start getting graph nodes.
	let patched = function (asIDs, options = {}) {
		let record = installed_.get(win);
		if (record && !record.inert && !options.libraryTabOnly) {
			let tabs = win.Zotero_Tabs;
			if (tabs && tabs.selectedType === 'graph') {
				return resolve(itemIDsFor(tabs.selectedID), asIDs);
			}
		}
		return original.call(this, asIDs, options);
	};

	installed_.set(win, { original, patched, inert: false });
	pane.getSelectedItems = patched;
}

/**
 * Give the window its own function back.
 *
 * Only if ours is still the one installed. Another plugin that wrapped
 * getSelectedItems after this one owns the property now, and writing core's
 * function back over its wrapper would silently uninstall it; ours stays where
 * it is in that case and goes inert instead, which leaves the chain intact and
 * this plugin out of it.
 */
function uninstall(win) {
	let record = installed_.get(win);
	if (!record) return;
	installed_.delete(win);

	let pane = win.ZoteroPane;
	if (!pane) return;
	if (pane.getSelectedItems === record.patched) pane.getSelectedItems = record.original;
	else record.inert = true;
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
