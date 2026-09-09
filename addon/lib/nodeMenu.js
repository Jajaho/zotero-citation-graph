/* global Zotero */

/**
 * Zotero's own item context menu, opened over a node in the graph.
 *
 * The graph page can neither build this menu nor open it: `#zotero-itemmenu` is
 * a XUL <menupopup> in the main window, built by ZoteroPane out of XPCOM
 * objects, and the page is content. So the page asks -- see openNativeMenu() in
 * content/graph.js -- and this builds it, adds the graph's own entries to the
 * bottom, opens it at the pointer, and reports back what became of it.
 *
 * Why the real menu rather than a copy of the useful half: everything the page
 * used to offer a held node (select it, open its file, open its URL) was a
 * thinner version of an entry that already existed, and a thinner version
 * drifts -- it misses what core adds and keeps what core drops. Asking for
 * core's menu also gets the Locate section for free, which is what this plugin
 * already went to the trouble of teaching about graph tabs; see lib/locate.js.
 *
 * WHAT IS SELECTED. Core's builder, and nearly every command it wires up, reads
 * ZoteroPane.getSelectedItems() -- which lib/locate.js has already taught to
 * answer with the graph tab's own selection. So the caller records the node
 * clicked as that selection before asking for a menu, and the whole menu is
 * then about that node.
 *
 * The exception is the handful of commands that reach past getSelectedItems()
 * into the LIBRARY tab's item tree, which is still showing whatever it was
 * showing when the graph tab was opened. Those are taken off rather than left
 * to act on the wrong papers; see LIBRARY_BOUND.
 */

const POPUP_ID = 'zotero-itemmenu';

// Ours, on a popup that is not: the class is how everything this module puts
// there is found again and taken back off.
const CLASS = 'zg-node-menuitem';

/**
 * Zotero's own icon files, by the name the graph page calls each one.
 *
 * The page ships the same shapes inlined, because chrome:// does not resolve
 * from a content docshell -- content/icons.js, and section 2 of the plugin's
 * THIRD-PARTY-NOTICES.md, say why. Here the files themselves are reachable, so
 * the menu takes them from Zotero rather than from the copy.
 */
const ICONS = {
	'isolate': 'chrome://zotero/skin/16/universal/filter.svg',
	'show-all': 'chrome://zotero/skin/16/universal/view.svg',
	'plus-circle': 'chrome://zotero/skin/16/universal/plus-circle.svg',
	'minus-circle': 'chrome://zotero/skin/16/universal/minus-circle.svg',
	'pin': 'chrome://zotero/skin/16/universal/pin.svg',
	'unpin': 'chrome://zotero/skin/16/universal/pin-remove.svg',
};

/**
 * The entries whose commands act on the library tab's item tree rather than on
 * what ZoteroPane says is selected, and which therefore cannot be honoured from
 * here.
 *
 * The first three are all ZoteroPane.deleteSelectedItems(), which ends at
 * `this.itemsView.deleteSelection()` -- the item TREE's selection, which a graph
 * tab has no part in. Offering them would put "Move to Trash" over a node and
 * trash a different paper, which is the one outcome this menu must not have.
 * Merge needs two items and reads the same tree; restore only ever shows in the
 * trash, which is not a view a graph is ever built from, and reads it too.
 *
 * Taken off rather than greyed out: a disabled row invites a bug report about a
 * menu entry that does not work, where an absent one is simply a menu that does
 * not offer it.
 */
const LIBRARY_BOUND = [
	'zotero-menuitem-remove-items',
	'zotero-menuitem-move-to-trash',
	'zotero-menuitem-delete-from-lib',
	'zotero-menuitem-merge-items',
	'zotero-menuitem-restore-to-library',
];

// The menu one window has open, keyed by window, so a second window's graph
// cannot take down the first one's popup. `gen` is what a listener checks
// before acting: a menu replaced while its predecessor's popuphidden is still
// in flight must not have its entries swept by that older listener.
let open_ = new WeakMap();
let gen_ = 0;

/**
 * Build Zotero's item menu for one node, add this plugin's entries, and show it.
 *
 * @param {Object}   entry  graphTab's record for the tab; win and collection
 *                          are what is read
 * @param {Object}   msg    the page's 'node-menu' message: screen x and y, and
 *                          the entries to add at the bottom
 * @param {Function} reply  (fnName, value) back to the page; graphTab's send()
 */
async function open(entry, msg, reply) {
	let win = entry.win;
	let pane = win.ZoteroPane;
	let popup = win.document.getElementById(POPUP_ID);
	// No menu to open -- and the page is still holding the node it right-
	// clicked, waiting to be told the menu is gone. Tell it now, or the node
	// stays fixed under a menu that never appeared.
	if (!pane || !pane.itemsView || !popup) {
		reply('zgMenuClosed');
		return;
	}

	close(win);
	sweep(popup);

	await buildFor(pane, entry.collection);

	for (let name of LIBRARY_BOUND) {
		let el = popup.querySelector('.' + name);
		if (el) el.setAttribute('hidden', true);
	}

	// A rule of its own, so that what this plugin adds reads as an addition to
	// Zotero's menu rather than as two more of its own entries. Core separates
	// plugin menus the same way; see menuManager.js _groupMenus().
	popup.appendChild(separator(win.document));
	for (let e of msg.entries || []) popup.appendChild(item(win.document, e));

	let record = { gen: ++gen_, popup, picked: null };
	open_.set(win, record);

	let onCommand = (event) => {
		let id = event.target && event.target.dataset && event.target.dataset.zgEntry;
		if (id) record.picked = id;
	};
	let onHidden = (event) => {
		if (event.target !== popup) return;
		popup.removeEventListener('command', onCommand);
		popup.removeEventListener('popuphidden', onHidden);
		// A menu opened over another node has already swept this one's entries
		// and put its own there; they are not ours to take away.
		let current = open_.get(win);
		if (!current || current.gen !== record.gen) return;
		open_.delete(win);
		sweep(popup);
		// Closed before picked, never the other way round: "Pin node here" fixes
		// the node where the hold is keeping it, and a release arriving after
		// that would undo the pin. It is the order the page's own menu rows run
		// in, and the page depends on it.
		reply('zgMenuClosed');
		if (record.picked) reply('zgMenuPicked', record.picked);
	};
	popup.addEventListener('command', onCommand);
	popup.addEventListener('popuphidden', onHidden);

	// Screen coordinates out of the content event, which is what core's own
	// reader hands its popups for the same reason: the popup is placed by a
	// window that knows nothing of where this page sits inside it.
	popup.openPopupAtScreen(msg.x, msg.y, true);
}

/**
 * Take down whatever this window has open, if it is ours.
 *
 * The page asking is one way in -- a rebuild landing under an open menu is the
 * other. Nothing is swept here: hidePopup() raises popuphidden, and the listener
 * on it is where a menu of ours is cleaned up however it came down.
 */
function close(win) {
	let record = open_.get(win);
	if (!record) return;
	try {
		record.popup.hidePopup();
	}
	catch (e) {
		Zotero.logError(e);
	}
}

/**
 * ZoteroPane's own builder, run against the collection the graph is OF.
 *
 * Left alone it reads ZoteroPane.getCollectionTreeRows(), which answers with
 * whatever the library tab has selected -- a different collection, or the trash,
 * or nothing at all if the tree has no selection, which throws on the first
 * `collectionTreeRows[0]`. None of those is the scope the graph is of, and the
 * row decides real things: whether the library is editable, whether its files
 * are, and half the labels.
 *
 * So the row is built here, out of the collection the tab was opened on, and put
 * in front of core's for exactly as long as the build takes. A wrapper left
 * installed would be the wrong shape: this is one question asked at one moment,
 * not a standing fact about the window the way lib/locate.js's two are.
 */
async function buildFor(pane, collection) {
	let rows = null;
	try {
		rows = [new Zotero.CollectionTreeRow(pane.collectionsView, 'collection', collection)];
	}
	catch (e) {
		// Core's own answer is a poorer menu than the right row would give, and
		// a much better one than no menu at all.
		Zotero.logError(e);
	}
	let original = pane.getCollectionTreeRows;
	if (rows) pane.getCollectionTreeRows = () => rows;
	try {
		await pane.buildItemContextMenu();
	}
	finally {
		if (rows) pane.getCollectionTreeRows = original;
	}
}

/**
 * Everything this module put on the popup, off it again.
 *
 * Core addresses its own entries by index from the front of the popup, so what
 * is appended at the end is invisible to it -- but only while it is there, and
 * it has no business being there when the library's own menu opens next.
 */
function sweep(popup) {
	for (let el of popup.querySelectorAll('.' + CLASS)) el.remove();
}

function separator(doc) {
	let el = doc.createXULElement('menuseparator');
	el.classList.add(CLASS);
	return el;
}

function item(doc, e) {
	let el = doc.createXULElement('menuitem');
	// menuitem-iconic even for a name this module has no file for: the class is
	// what reserves the icon column, and a label starting at the edge beside
	// labels indented past an icon reads as two menus.
	el.className = 'menuitem-iconic ' + CLASS;
	el.setAttribute('label', e.label || '');
	if (e.hint) el.setAttribute('tooltiptext', e.hint);
	let icon = ICONS[e.icon];
	if (icon) {
		el.setAttribute('image', icon);
		// The two properties Zotero's own menu rules set on every one of these
		// files. They paint themselves with `context-fill`, which resolves to
		// nothing without them -- a black shape in both themes, and invisible in
		// one. Inline, because this plugin ships no chrome stylesheet of its own.
		el.style.setProperty('-moz-context-properties', 'fill, fill-opacity');
		el.style.setProperty('fill', 'var(--fill-secondary)');
	}
	el.dataset.zgEntry = e.id;
	return el;
}

module.exports = { open, close };
