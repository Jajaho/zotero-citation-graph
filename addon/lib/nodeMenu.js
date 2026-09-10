/* global Zotero, setTimeout */

// TEMPORARY, with the page-side trace() in content/graph.js: what the popup did
// and in which order. Comes out with the bug it was added for.
let trace = require('./trace.js');

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
 * already went to the trouble of teaching about graph tabs; see lib/tabContext.js.
 *
 * WHAT THE MENU IS ABOUT. Nothing here tells core which paper, which collection
 * or which library it is building for: lib/tabContext.js has already given the
 * window a graph tab's answer to all three, and core's builder asks it the same
 * questions it asks in the library window. All this does is record the node
 * clicked as the tab's selection first, which is what those answers are read
 * from.
 *
 * The exception is the handful of commands that reach past ZoteroPane
 * altogether, into the LIBRARY tab's item tree -- which is still showing
 * whatever it was showing when the graph tab was opened. Those are taken off
 * rather than left to act on the wrong papers; see LIBRARY_BOUND.
 */

const POPUP_ID = 'zotero-itemmenu';

// Ours, on a popup that is not: the class is how everything this module puts
// there is found again and taken back off.
const CLASS = 'zg-node-menuitem';

/**
 * The icon files, by the name the graph page calls each one.
 *
 * The page ships the same shapes inlined, because chrome:// does not resolve
 * from a content docshell -- content/icons.js, and section 2 of the plugin's
 * THIRD-PARTY-NOTICES.md, say why. Here the files themselves are reachable, so
 * the menu takes them from Zotero rather than from the copy.
 */
const ICONS = {
	'show-all': 'chrome://zotero/skin/16/universal/view.svg',
	'plus-circle': 'chrome://zotero/skin/16/universal/plus-circle.svg',
	'minus-circle': 'chrome://zotero/skin/16/universal/minus-circle.svg',
	'pin': 'chrome://zotero/skin/16/universal/pin.svg',
	'unpin': 'chrome://zotero/skin/16/universal/pin-remove.svg',
};

/**
 * The same table for the icons Zotero has no file of -- the spotlight the page
 * draws over "Isolate", which is this plugin's own. Kept apart from the entries
 * above because these need the tab's resource root to be addressed at all, and
 * because which of the two a name comes from is the licence question section 2
 * of THIRD-PARTY-NOTICES.md answers.
 */
const OWN_ICONS = {
	'isolate': 'content/icons/spotlight.svg',
};

/**
 * The file for one icon name, or null for a name neither table has -- and for
 * one of ours asked for without a resource root, which would otherwise build a
 * URL with `undefined` in it. A row with no image keeps its place in the icon
 * column; a row with a broken one is a menu with a hole in it.
 */
function iconURL(name, resRoot) {
	if (OWN_ICONS[name]) return resRoot ? 'resource://' + resRoot + '/' + OWN_ICONS[name] : null;
	return ICONS[name] || null;
}

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
// cannot take down the first one's popup. `superseded` is what a listener
// checks before acting: a menu replaced by the next one has nothing left to
// report, and reporting it anyway would be heard as being about the menu that
// replaced it.
let open_ = new WeakMap();

// How long a popup asked to close is given to say that it has. Only reached if
// the hide raises no popuphidden at all, which is not a reason to withhold the
// menu the user asked for -- a quarter second is over the threshold where a
// menu reads as a menu rather than as a delay, and well under any wait a user
// would sit through twice.
const HIDE_WAIT_MS = 250;

/**
 * Build Zotero's item menu for one node, add this plugin's entries, and show it.
 *
 * @param {Object}   entry  graphTab's record for the tab; only its window and
 *                          its resource root are read here -- the collection
 *                          reaches core through lib/tabContext.js
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

	// The menu this one replaces, retired before it is taken down. Its own
	// hidePopup() raises popuphidden a turn or more from now -- by which time
	// the page has let go of the node THAT menu was opened over and is holding
	// the node THIS one is for -- and a closure reported that late would be
	// heard as this menu's, handing back a node with a popup still over it.
	let prev = open_.get(win);
	if (prev) prev.superseded = true;
	close(win);
	sweep(popup);

	// And down before the next one goes up. A menupopup opens from the closed
	// state and from no other, so a menu opened over one still hiding is a menu
	// that never appears -- leaving the page holding a node for a popup that is
	// not there, with no popuphidden ever coming to say so.
	if (prev) await hidden(popup);

	await pane.buildItemContextMenu();

	for (let name of LIBRARY_BOUND) {
		let el = popup.querySelector('.' + name);
		if (el) el.setAttribute('hidden', true);
	}

	// A rule of its own, so that what this plugin adds reads as an addition to
	// Zotero's menu rather than as two more of its own entries. Core separates
	// plugin menus the same way; see menuManager.js _groupMenus().
	let record = { popup, settled: false, superseded: false };
	open_.set(win, record);

	/**
	 * The menu is over, and this is the one place that says so.
	 *
	 * Called from both ends -- the row that was picked, and the popup coming
	 * down -- because which of the two happens first is not knowable from here,
	 * and because ONE of them may be all that ever arrives. Whichever gets here
	 * first tells the page the menu is gone; a pick tells it what was picked.
	 *
	 * `settled` rather than a removed listener: a picked row is dispatched at
	 * the row, and the popup's own hide follows it, so both fire on any normal
	 * pick and the second must come to nothing.
	 */
	let settle = (pickedID) => {
		trace.log('menu settle  picked=' + pickedID + '  first=' + !record.settled
			+ '  superseded=' + record.superseded
			+ '  stillOurs=' + (open_.get(win) === record));
		// Replaced, and so no longer anybody's news. Whatever this is reporting
		// happened to a menu that is off the screen and out of the page's mind;
		// the page is holding a node for the menu that took its place, and every
		// word of this would be taken as being about that one.
		if (record.superseded) return;
		if (!record.settled) {
			record.settled = true;
			// A menu opened over another node has already swept this one's
			// entries and put its own there; they are not ours to take away.
			if (open_.get(win) === record) {
				open_.delete(win);
				sweep(popup);
			}
			// Closed before picked, never the other way round: "Pin node here"
			// fixes the node where the hold is keeping it, and a release
			// arriving after that would undo the pin. It is the order the
			// page's own menu rows run in.
			reply('zgMenuClosed');
		}
		if (pickedID) reply('zgMenuPicked', pickedID);
	};

	/**
	 * A row of ours was picked. The listener is on the ROW, and that is the
	 * whole point.
	 *
	 * Gecko runs a picked row as nsXULMenuCommandEvent: it rolls the menu chain
	 * up first -- so a command is free to open a dialog or a second popup --
	 * and dispatches the XUL `command` afterwards, later than the same turn of
	 * the event loop. A listener on the POPUP hears that only by bubbling, and
	 * by then this module has taken the row off the popup to leave Zotero's own
	 * menu as it found it, so the event bubbles into nothing and the pick is
	 * lost. Every entry this plugin adds was dead for exactly that reason.
	 *
	 * A listener on the row itself fires at the target. It does not care what
	 * the row is still attached to, or how much later the command arrives.
	 */
	let onPick = (event) => {
		let id = event.currentTarget && event.currentTarget.dataset
			&& event.currentTarget.dataset.zgEntry;
		trace.log('menu command  label=' + (event.currentTarget && event.currentTarget.getAttribute('label')) + '  id=' + id);
		settle(id || null);
	};

	popup.appendChild(separator(win.document));
	for (let e of msg.entries || []) popup.appendChild(item(win.document, e, onPick, entry.resRoot));

	let onHidden = (event) => {
		trace.log('menu popuphidden  mine=' + (event.target === popup) + '  settled=' + record.settled);
		if (event.target !== popup) return;
		popup.removeEventListener('popuphidden', onHidden);
		settle(null);
	};
	popup.addEventListener('popuphidden', onHidden);

	// Screen coordinates out of the content event, which is what core's own
	// reader hands its popups for the same reason: the popup is placed by a
	// window that knows nothing of where this page sits inside it.
	trace.log('menu open  entries=' + (msg.entries || []).length + '  rows=' + popup.querySelectorAll('.' + CLASS).length);
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
 * The popup is down -- already, or as soon as it says so.
 *
 * `state` is the only honest answer to whether the hide has happened yet:
 * hidePopup() raises popuphidden from a runnable of its own, so a popup asked
 * to close is still 'hiding' for the rest of this turn, and one that came down
 * earlier has had its event and gone. Waiting on the event alone would wait for
 * ever in the second case, which is what the state check is for; the timeout is
 * for the first case going wrong -- a hide that raises nothing must cost a
 * quarter second, not the menu.
 */
function hidden(popup) {
	if (popup.state === 'closed') return Promise.resolve();
	return new Promise((resolve) => {
		let done = () => {
			popup.removeEventListener('popuphidden', done);
			resolve();
		};
		popup.addEventListener('popuphidden', done);
		setTimeout(done, HIDE_WAIT_MS);
	});
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

function item(doc, e, onPick, resRoot) {
	let el = doc.createXULElement('menuitem');
	// menuitem-iconic even for a name this module has no file for: the class is
	// what reserves the icon column, and a label starting at the edge beside
	// labels indented past an icon reads as two menus.
	el.className = 'menuitem-iconic ' + CLASS;
	el.setAttribute('label', e.label || '');
	if (e.hint) el.setAttribute('tooltiptext', e.hint);
	let icon = iconURL(e.icon, resRoot);
	if (icon) {
		el.setAttribute('image', icon);
		// The two properties Zotero's own menu rules set on every one of these
		// files. They paint themselves with `context-fill`, which resolves to
		// nothing without them -- a black shape in both themes, and invisible in
		// one. This plugin's own file is drawn the same way for the same reason.
		// Inline, because this plugin ships no chrome stylesheet of its own.
		el.style.setProperty('-moz-context-properties', 'fill, fill-opacity');
		el.style.setProperty('fill', 'var(--fill-secondary)');
	}
	el.dataset.zgEntry = e.id;
	// On the row, not on the popup it is about to be taken off. See onPick.
	if (onPick) el.addEventListener('command', onPick);
	return el;
}

module.exports = { open, close };
