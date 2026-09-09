/* global Zotero */

/**
 * What a graph tab tells Zotero about itself.
 *
 * ZoteroPane answers a handful of questions about "the selected tab", and every
 * one of them is a `switch (Zotero_Tabs.selectedType)` with a case for
 * `library`, sometimes one for `reader`, and a `default` that means "not a tab
 * I know" -- or else it reads the library tab's own trees directly and does not
 * ask which tab is on screen at all. A graph tab is a type core has never heard
 * of, so it takes the default, and the default is wrong in a different way for
 * each question: nothing is selected, nothing is editable, no collection is
 * open. Not one of them has a hook. So this wraps them, answers for the one tab
 * type it knows, and hands every other call straight through.
 *
 * They are all the same answer in the end. A graph tab is a view of ONE
 * collection, and everything below is that collection read a different way:
 * the node the user clicked is what is selected in it, its library is the
 * library, and whether it can be written to is whether the graph's own
 * collection can be.
 *
 * WHICH ITEMS ARE SELECTED. Every Locate action ends up in
 * Zotero_LocateMenu._getSelectedItems(), which is one call to
 * ZoteroPane.getSelectedItems() -- a switch (zoteroPane.js:3540) with a case
 * for `library`, `reader` and `note`, and `default: []`. A graph tab took the
 * default, so the menu built itself out of an empty list: one disabled row
 * reading "0 items selected", whichever node the user had just clicked. The
 * same switch is what makes Locate work in a reader tab, so the shape of the
 * fix is core's own -- a graph tab needs its case. Note the reach: several
 * other core menus route through this function too, and they now see the
 * clicked node as well, which is the same deal a reader tab gets. Chief among
 * them is the item context menu, which lib/nodeMenu.js opens over a node.
 *
 * WHICH COLLECTION IS OPEN. getCollectionTreeRows() reads the collection
 * TREE's selection, which belongs to the library tab and goes on saying
 * whatever it said when the graph was opened -- another collection, the trash,
 * or nothing at all, which throws on the first `collectionTreeRows[0]`. That
 * row decides whether what is on screen can be edited, whether its files can,
 * and half the labels in the item menu. A graph tab is looking at exactly one
 * collection, and that is the honest answer.
 *
 * WHICH LIBRARY. getSelectedLibraryIDs() reads the same tree, and it is what
 * decides where a new note is filed and which library's collections the "Add
 * to Collection" submenu offers. A note put in the library the tree happens to
 * be showing, on a paper from another one, is a note that cannot be saved.
 * getSelectedCollections() is the same tree again, and it is the parent "Add to
 * Collection -> New Collection" hangs the new one under -- which, taken from
 * the tree, can be a collection in a library the new one is not in.
 *
 * WHAT "SELECT THIS ITEM" DOES. selectItems() is how core shows the user
 * something it has just made or been asked for -- a note written by Add Note, a
 * related paper clicked in the item pane, a citation followed out of a note. In
 * the library tab it selects the row and switches to that tab, and its default
 * for every other tab is to switch to the library tab anyway. A graph tab has
 * somewhere of its own to put it: the item pane beside the graph, which is the
 * same pane the note would have been shown in over there. So it stays put and
 * the pane answers -- except when the caller asked to BE in the library, which
 * is what core's own "Show in Library" says by passing inLibraryRoot.
 *
 * WHETHER IT CAN BE EDITED. canEdit() and canEditFiles() have a `library` case
 * reading the tree row's `editable` / `filesEditable`, a `reader` case reading
 * the open item's library, and a default of `false` -- taken literally, "a
 * graph tab can change nothing". That default is what put "You cannot make
 * changes to the currently selected collection" behind Add Note, Add Note from
 * Annotations and Add Attachment, all of which work perfectly well in the
 * library window on the same paper. The graph's own collection row answers both
 * with the same getters core's library case uses.
 *
 * canEditLibrary() needs no wrapper of its own: its default case is `return
 * this.canEdit(row)`, which is core saying that outside the library tab the two
 * questions are one.
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
 * @param {Object} graph  what the tab strip's graph tabs can be asked, by id:
 *        `itemIDs(tabID)` is the selection, newest click last,
 *        `collection(tabID)` the collection the tab is a view of, and
 *        `select(tabID, itemIDs)` shows one of them in the tab's own pane.
 *        See graphTab.selectedItemIDs(), selectedCollection() and selectItems().
 */
function install(win, graph) {
	if (installed_.has(win)) return;

	let record = { inert: false, graph, wraps: [] };
	// Before any wrap: every closure reads it to find out whether this plugin
	// still speaks for the window. See uninstall().
	installed_.set(win, record);

	let pane = win.ZoteroPane;
	wrap(record, win, pane, 'getSelectedItems',
		// The signature is core's, verbatim. `libraryTabOnly` exists precisely
		// so a caller can ask what the LIBRARY has selected while another tab is
		// on screen -- core's own switch honours it ahead of the tab type, and
		// so must this, or those callers would start getting graph nodes.
		(original, win_) => function (asIDs, options = {}) {
			if (!options.libraryTabOnly && isGraphTab(win_, record)) {
				return resolve(record.graph.itemIDs(win_.Zotero_Tabs.selectedID), asIDs);
			}
			return original.call(this, asIDs, options);
		});

	wrap(record, win, pane, 'getCollectionTreeRows',
		(original, win_) => function () {
			let row = graphRow(win_, record);
			return row ? [row] : original.call(this);
		});

	wrap(record, win, pane, 'getSelectedLibraryIDs',
		(original, win_) => function () {
			let collection = graphCollection(win_, record);
			return collection ? [collection.libraryID] : original.call(this);
		});

	wrap(record, win, pane, 'getSelectedCollections',
		(original, win_) => function (asID) {
			let collection = graphCollection(win_, record);
			if (!collection) return original.call(this, asID);
			return asID ? [collection.id] : [collection];
		});

	// Both take an optional row index, which is core's way of asking about a row
	// other than the selected one. It is only ever a COLLECTION TREE row, and
	// core's own non-library cases ignore it for exactly that reason; so do
	// these.
	wrap(record, win, pane, 'canEdit',
		(original, win_) => function (row) {
			let g = graphRow(win_, record);
			return g ? g.editable : original.call(this, row);
		});

	wrap(record, win, pane, 'canEditFiles',
		(original, win_) => function (row) {
			let g = graphRow(win_, record);
			return g ? g.filesEditable : original.call(this, row);
		});

	wrap(record, win, pane, 'selectItems',
		(original, win_) => function (itemIDs, options = {}) {
			// Core still accepts the old boolean in this argument and warns
			// about it. Read it the same way -- but hand on what was actually
			// passed, so the call core sees is the call that was made.
			let asked = typeof options === 'boolean' ? { inLibraryRoot: options } : (options || {});
			if (!asked.inLibraryRoot && isGraphTab(win_, record)) {
				return record.graph.select(win_.Zotero_Tabs.selectedID, itemIDs || []);
			}
			return original.call(this, itemIDs, options);
		});

	// Removed rather than set to 'library'. The suppression is keyed on two
	// named contexts and a graph tab is neither -- it is not the tab already
	// showing this file, and it is not a window showing it -- so the honest
	// answer is no mode at all, which is what core's own `{ locateMode } = {}`
	// default already means. Claiming to be a library tab would get the same
	// two entries today by asserting something untrue, and would come apart the
	// first time core gave that value a second meaning.
	wrap(record, win, win.Zotero_LocateMenu, 'buildLocateMenu',
		(original, win_) => function (locateMenu, options = {}) {
			if (isGraphTab(win_, record)) {
				options = { ...options };
				delete options.locateMode;
			}
			return original.call(this, locateMenu, options);
		});

	if (!record.wraps.length) installed_.delete(win);
}

/**
 * Put one wrapper on one method, and remember enough to take it off again.
 *
 * `make` is handed core's function and the window it was found on, and returns
 * the replacement;
 * a method the object does not have is skipped rather than invented, because a
 * Zotero that has moved one of these should cost this plugin that one answer
 * and nothing else.
 */
function wrap(record, win, target, name, make) {
	if (!target || typeof target[name] !== 'function') return;
	let original = target[name];
	let patched = make(original, win);
	target[name] = patched;
	record.wraps.push({ target, name, original, patched });
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

	for (let { target, name, original, patched } of record.wraps) {
		if (target[name] === patched) target[name] = original;
	}
}

/** The tab on screen is one of ours, and so the question being asked is ours. */
function isGraphTab(win, record) {
	if (record.inert) return false;
	let tabs = win.Zotero_Tabs;
	return !!tabs && tabs.selectedType === 'graph';
}

/** The collection the graph on screen is a view of, or null for every other
 *  tab and for a graph tab with no collection behind it -- one restored but
 *  never selected, or closed while something still held its id. */
function graphCollection(win, record) {
	if (!isGraphTab(win, record)) return null;
	return record.graph.collection(win.Zotero_Tabs.selectedID) || null;
}

/**
 * That collection as the tree row core expects to be handed.
 *
 * Built rather than looked up in the collection tree: the row for a collection
 * inside a collapsed parent is not in the tree's list at all, and a graph of it
 * would then answer differently depending on what the user had twisted open.
 * The constructor is core's own and the getters read `ref`, so a row built here
 * answers `editable` and `filesEditable` exactly as the tree's would.
 */
function graphRow(win, record) {
	let collection = graphCollection(win, record);
	if (!collection) return null;
	try {
		return new Zotero.CollectionTreeRow(win.ZoteroPane.collectionsView, 'collection', collection);
	}
	catch (e) {
		// Core's own answer is a poorer one than the right row would give, and a
		// much better one than a menu that throws while it is being built.
		Zotero.logError(e);
		return null;
	}
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
