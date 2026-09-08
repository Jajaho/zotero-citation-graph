/* global Zotero */

'use strict';

/**
 * Zotero's own item pane, beside the graph, following the pointer.
 *
 * This is the same element the library pane builds for the item you click:
 * `<item-details>` (elements/itemDetails.js) with an `<item-pane-sidenav>`
 * beside it. Not a copy of it, and not a reimplementation -- the actual custom
 * element, created in the main window's document, which is why every section
 * (info, abstract, attachments, notes, tags, related, and any section another
 * plugin has registered) is present and behaves exactly as it does in the
 * library, editing included.
 *
 * The recipe is core's own: contextPane.js `_addItemContext()` does precisely
 * this to give each reader tab an item pane, so a plugin doing it is on a path
 * core already walks. What that path needs from us is small and fixed:
 *
 *   sidenav    ItemDetails talks to one unconditionally (forceUpdateSideNav,
 *              renderCustomSections), so it is not optional even if the strip
 *              of icons were unwanted.
 *   tabID      ItemDetails watches for 'select'/'tab' and sets skipRender when
 *              the tab it belongs to is not the one on screen. Without it the
 *              pane would keep rendering in a tab nobody is looking at.
 *   tabType    'graph' -- neither 'library' nor 'reader', which is exactly
 *              right: attachment previews stay on (a reader tab suppresses the
 *              preview of the file it is already showing), and the panes that
 *              ask the library what row is selected (`inTrash`, the pinned-pane
 *              pref) take their non-library branch and never reach for a
 *              collection tree this tab does not have.
 *
 * The pane is opened by hovering a node, and hovering is cheap and constant, so
 * the dwell timer that decides when a hover means something lives on the graph
 * page (see HOVER_ITEM_MS in content/graph.js). By the time a message gets here
 * the user has meant it.
 */

let l10n = require('./l10n.js');

const MIN_WIDTH = 357;
const DEFAULT_WIDTH = 400;

const PANE_CSS = `
	.zg-item-splitter {
		width: 4px;
		border: none;
		background: var(--material-panedivider);
	}
	.zg-item-pane {
		min-width: ${MIN_WIDTH}px;
		background: var(--material-sidepane);
	}
	/* The sidenav's first button collapses the pane it lives in, which it finds
	   with closest('item-pane, context-pane') -- neither of which this is. It
	   would be an inert button in an otherwise live strip. */
	.zg-item-pane item-pane-sidenav > toolbarbutton[data-action="toggle-pane"],
	.zg-item-pane item-pane-sidenav > toolbarbutton[data-action="toggle-pane"] + .divider {
		display: none;
	}
`;

/**
 * Describe `itemID` in the pane, creating the pane if this is the first hover.
 *
 * Renders are serialised rather than fired per message: a render walks every
 * section of the pane and awaits the slow ones, and the pointer can cross three
 * nodes while one is in flight. Only the latest item is ever drawn -- the ones
 * passed over in between are dropped, which is what they deserve.
 *
 * @param {Object}   entry      the graphTab record for this tab
 * @param {Number}   itemID     a regular item, or one of its children
 * @param {Function} [status]   text back to the graph page
 */
async function show(entry, itemID, { status = () => {} } = {}) {
	if (!entry || !entry.split) return;

	let item = await Zotero.Items.getAsync(itemID);
	if (!item) return;
	// The library shows the parent's pane when you select an attachment, and so
	// does the context pane. Nodes are regular items today, but that is a fact
	// about the payload, not about this.
	let target = item.parentItem || item;

	// Everything below the first line of this is core's element, on core's
	// terms. If a Zotero this plugin has not seen builds it differently, say so
	// once on the status line rather than throwing on every hover.
	let pane;
	try {
		pane = ensurePane(entry);
	}
	catch (e) {
		Zotero.logError(e);
		status(l10n.t('item-pane-failed'));
		return;
	}
	pane.wanted = target;
	if (pane.rendering) return;

	pane.rendering = true;
	try {
		// Re-read `wanted` each pass: a hover that landed during the await is
		// the one to draw next, and the ones before it are already stale.
		while (entry.itemPane === pane && pane.wanted !== pane.shown) {
			let next = pane.wanted;
			pane.shown = next;
			pane.details.editable = editable(next);
			pane.details.item = next;
			await pane.details.render();
		}
	}
	catch (e) {
		Zotero.logError(e);
	}
	finally {
		pane.rendering = false;
	}
}

/**
 * Read-only unless the library says otherwise -- the same test the context pane
 * applies, and the reason a group library you cannot write to gives you a pane
 * you can read rather than fields that pretend to be editable.
 */
function editable(item) {
	try {
		return !!Zotero.Libraries.get(item.libraryID).editable && !item.deleted;
	}
	catch (e) {
		return false;
	}
}

/** Tear the pane down: remember the width, then the DOM. */
function close(entry) {
	let pane = entry && entry.itemPane;
	if (!pane) return;
	saveWidth(pane);
	// ItemDetails and the sidenav both unregister their observers from
	// disconnectedCallback (elements/base.js), so removing them IS the cleanup.
	entry.itemPane = null;
	pane.splitter.remove();
	pane.box.remove();
}

// --- the pane ----------------------------------------------------------

function ensurePane(entry) {
	if (entry.itemPane) return entry.itemPane;

	let doc = entry.win.document;
	let style = doc.createElement('style');
	style.textContent = PANE_CSS;

	let splitter = doc.createXULElement('splitter');
	splitter.className = 'zg-item-splitter';
	splitter.setAttribute('resizebefore', 'closest');
	splitter.setAttribute('resizeafter', 'closest');

	let box = doc.createXULElement('hbox');
	box.className = 'zg-item-pane';
	box.setAttribute('width', String(storedWidth()));

	// The class is what core's stylesheet sizes and colours an item pane by;
	// the pane is a plain box otherwise, and this is the whole of its styling.
	let details = doc.createXULElement('item-details');
	details.className = 'zotero-item-pane-content';
	let sidenav = doc.createXULElement('item-pane-sidenav');
	sidenav.className = 'zotero-view-item-sidenav';
	// There is no notes context beside a graph, and the button would open a
	// deck that does not exist.
	sidenav.setAttribute('no-context-notes', 'true');

	box.appendChild(details);
	box.appendChild(sidenav);
	box.appendChild(style);
	entry.split.appendChild(splitter);
	entry.split.appendChild(box);

	// Only now: connectedCallback runs on append and everything below is a
	// property on an initialised element. Order matters within it too --
	// `sidenav` last, because its setter immediately asks the pane what
	// sections it has.
	details.tabID = entry.tabID;
	details.tabType = 'graph';
	details.sidenav = sidenav;

	splitter.addEventListener('command', () => saveWidth(entry.itemPane));

	entry.itemPane = {
		box,
		splitter,
		details,
		sidenav,
		shown: null,       // the item drawn
		wanted: null,      // the item most recently hovered
		rendering: false,
	};
	return entry.itemPane;
}

// --- remembered width --------------------------------------------------

function storedWidth() {
	let w = Number(pref('itemPaneWidth'));
	return Number.isFinite(w) && w >= MIN_WIDTH ? Math.round(w) : DEFAULT_WIDTH;
}

function saveWidth(pane) {
	if (!pane) return;
	let w = Math.round(pane.box.getBoundingClientRect().width);
	if (w < MIN_WIDTH) return;
	try {
		Zotero.Prefs.set('zoteroGraph.itemPaneWidth', w);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function pref(name) {
	try {
		return Zotero.Prefs.get('zoteroGraph.' + name);
	}
	catch (e) {
		return null;
	}
}

module.exports = { show, close };
