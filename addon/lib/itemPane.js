/* global Zotero */

'use strict';

/**
 * Zotero's own item pane, beside the graph, describing the node you clicked.
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
 * The pane opens on a left click, alongside the isolation that click already
 * does: one gesture asks "what is this paper", and both halves of the answer
 * -- what it is connected to, and what it is -- arrive together.
 *
 * It shares one panel with the reader (splitPane.js) and holds it alone: both
 * describe the paper you are looking at, and giving each its own strip would
 * leave the graph a column between two panes. Hiding is the divider's chevron,
 * not anything here.
 */

let l10n = require('./l10n.js');
let splitPane = require('./splitPane.js');

const PANE_CSS = `
	.zg-item-row {
		/* The row fills the panel; the pane inside it fills the row, less the
		   37px the sidenav takes. Stated in CSS as well as on the element,
		   because flex="1" is an attribute and this is not the place to find
		   out which attributes a given Zotero still maps. */
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	/* The sidenav's first button collapses the pane it lives in, which it finds
	   with closest('item-pane, context-pane') -- neither of which this is. It
	   would be an inert button in an otherwise live strip. */
	.zg-item-row item-pane-sidenav > toolbarbutton[data-action="toggle-pane"],
	.zg-item-row item-pane-sidenav > toolbarbutton[data-action="toggle-pane"] + .divider {
		display: none;
	}
`;

/**
 * Describe `itemID` in the pane, creating the pane if this is the first time.
 *
 * Renders are serialised rather than fired per message: a render walks every
 * section of the pane and awaits the slow ones, and a run of clicks across a
 * cluster can land three before the first is drawn. Only the latest item is
 * ever drawn -- the ones passed over in between are dropped.
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
	// once on the status line rather than throwing on every click.
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
		// Re-read `wanted` each pass: a click that landed during the await is
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

/**
 * The panel has been taken by the reader, or closed. There is nothing to flush:
 * ItemDetails and the sidenav both unregister their observers from
 * disconnectedCallback (elements/base.js), so the panel emptying itself IS the
 * cleanup. All this has to do is stop claiming to own a pane.
 */
function forget(entry) {
	entry.itemPane = null;
}

// --- the pane ----------------------------------------------------------

function ensurePane(entry) {
	// Through claim() every time, before the early return below: claiming shows
	// the panel if the chevron had hidden it, and a click on a node is a request
	// to see the paper, not to update something out of sight.
	let box = splitPane.claim(entry, 'item', () => forget(entry));
	if (entry.itemPane) return entry.itemPane;

	let doc = entry.win.document;

	let style = doc.createElement('style');
	style.textContent = PANE_CSS;

	// The panel is a column; the pane and its sidenav sit side by side inside
	// it, which is the shape core gives #zotero-context-pane.
	let row = doc.createXULElement('hbox');
	row.className = 'zg-item-row';
	row.setAttribute('flex', '1');

	// The class is what core's stylesheet sizes and colours an item pane by;
	// the element is a plain box otherwise, and this is the whole of its styling.
	let details = doc.createXULElement('item-details');
	details.className = 'zotero-item-pane-content';
	let sidenav = doc.createXULElement('item-pane-sidenav');
	sidenav.className = 'zotero-view-item-sidenav';
	// There is no notes context beside a graph, and the button would open a
	// deck that does not exist.
	sidenav.setAttribute('no-context-notes', 'true');

	row.appendChild(details);
	row.appendChild(sidenav);
	box.appendChild(row);
	box.appendChild(style);

	// Only now: connectedCallback runs on append and everything below is a
	// property on an initialised element. Order matters within it too --
	// `sidenav` last, because its setter immediately asks the pane what
	// sections it has.
	details.tabID = entry.tabID;
	details.tabType = 'graph';
	details.sidenav = sidenav;

	entry.itemPane = {
		box,
		row,
		details,
		sidenav,
		shown: null,       // the item drawn
		wanted: null,      // the item most recently clicked
		rendering: false,
	};
	return entry.itemPane;
}

module.exports = { show };
