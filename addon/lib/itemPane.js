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
 *   _collapsed the one property core cannot work out for itself here, and the
 *              whole of what makes the sidenav's first button live. See below.
 *
 * The pane opens on a left click, alongside the isolation that click already
 * does: one gesture asks "what is this paper", and both halves of the answer
 * -- what it is connected to, and what it is -- arrive together.
 *
 * Putting it away is core's own Toggle Item Pane button, first in the sidenav.
 * It collapses the pane to its 37px strip of icons exactly as it does in the
 * library, and the same click on any section icon brings it back -- both
 * through `_collapsed`, which ItemPaneContainerBase resolves by looking for an
 * enclosing `<item-pane>` or `<context-pane>`. There is neither of those here,
 * so the button was inert (and hidden) until that property was answered: the
 * instance below shadows it with one that drives splitPane.js instead. Nothing
 * else about the button changes -- not the icon, not the keyboard handling, not
 * what a section click does on the way past.
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
	/* Collapsed, the sidenav is the whole panel. Core's own rule, which it
	   writes as "item-pane[collapsed=true] #zotero-item-pane-content" -- that
	   id belongs to the library's pane and not to ours, but the attribute is
	   the same one, because the collapse is core's own (splitPane.js). */
	.zg-pane[collapsed="true"] .zg-item-row > .zotero-item-pane-content {
		visibility: collapse;
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
 * @param {Number}   itemID     a regular item, one of its children, or a note
 * @param {Function} [status]   text back to the graph page
 * @param {Boolean}  [expand]   open the pane if it was put away
 */
async function show(entry, itemID, { status = () => {}, expand = false } = {}) {
	if (!entry || !entry.split) return;

	let item = await Zotero.Items.getAsync(itemID);
	if (!item) return;
	// The library shows the parent's pane when you select an attachment, and so
	// does the context pane. Nodes are regular items today, but that is a fact
	// about the payload, not about this.
	//
	// A note is the exception, and for the same reason the library makes it one:
	// a note is not a fact about its paper, it is a document, and selecting one
	// means opening it. See showNote().
	let target = item.isNote() ? item : (item.parentItem || item);

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

	// An explicit request to look at one thing opens the pane: a note just
	// written, a related item clicked in the pane, a citation followed out of a
	// note. All of those come through core's own selectItems(), whose whole
	// purpose is to put something in front of the user -- see
	// graphTab.selectItems() and lib/tabContext.js.
	if (expand && splitPane.collapsed(entry)) {
		splitPane.setCollapsed(entry, false);
		// Nothing is drawn while the pane is collapsed, so what is behind the
		// strip of icons is whatever was there when it was put away. Forgetting
		// it is what sends the loop back over it; same reason as redraw().
		pane.shown = null;
	}

	// Someone who collapsed the pane is not asking for it back every time they
	// click a node. What they clicked is still recorded, and drawn the moment
	// the pane is expanded again -- so the way back lands on the paper last
	// chosen rather than on whatever was there when it was put away.
	if (splitPane.collapsed(entry)) return;
	await draw(entry, pane);
}

/**
 * Draw whatever was last asked for, and keep drawing until nothing newer has
 * arrived. Re-reads `wanted` each pass: a click that landed during the await is
 * the one to draw next, and the ones before it are already stale.
 */
async function draw(entry, pane) {
	if (pane.rendering) return;
	pane.rendering = true;
	try {
		while (entry.itemPane === pane && pane.wanted && pane.wanted !== pane.shown) {
			let next = pane.wanted;
			pane.shown = next;
			if (next.isNote()) showNote(entry, pane, next);
			else await showDetails(pane, next);
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
 * The paper's own pane: every section core registers, editable exactly as in the
 * library.
 */
async function showDetails(pane, item) {
	pane.details.editable = editable(item);
	pane.details.item = item;
	face(pane, pane.details);
	await pane.details.render();
}

/**
 * A note, in core's own editor.
 *
 * The library window answers a selected note with a <note-editor> rather than an
 * item pane -- itemPane.js renderNoteEditor(), and the three lines below are its
 * three lines. A note has no sections to show and nothing to describe; it is the
 * document, and "select this note" means "open it".
 *
 * Deliberately NOT given a tabID, though everything else in this file carries
 * one. EditorInstance reads a tabID as "this note has a tab of its own" and
 * closes that tab when the note is deleted (editorInstance.js notify()). The tab
 * this editor sits in is the graph, so a note thrown away in the pane would take
 * the whole graph off screen with it. The library's own note editor has no tabID
 * either, for the same reason.
 */
function showNote(entry, pane, item) {
	let note = ensureNote(entry, pane);
	if (!note) return;
	note.mode = editable(item) ? 'edit' : 'view';
	note.viewMode = 'library';
	note.item = item;
	face(pane, note);
	// A note is opened in order to be written in, and core agrees: newNote()
	// focuses its own editor the moment the note is selected. That call lands on
	// the LIBRARY's editor, which is not on screen, so the caret has to be put
	// here instead.
	//
	// Not awaited -- focus() waits on the editor's iframe, and nothing in the
	// render loop should wait with it -- and its failures are swallowed, because
	// a note on screen with no caret in it is a far better outcome than a draw
	// that threw.
	if (typeof note.focus === 'function') {
		Promise.resolve(note.focus()).catch(() => {});
	}
}

/**
 * Which of the two is on screen, and what the sidenav makes of it.
 *
 * Core switches a deck; this hides the one not wanted, which comes to the same
 * thing and leaves the pane the shape contextPane.js gave it -- the sizing class
 * is on the element itself here, not on a container around it.
 *
 * The strip of icons is core's rule verbatim (itemPane.js
 * _handleViewTypeChange): section buttons mean nothing beside a note editor, so
 * they go back to their default greyed state, and coming back to the paper
 * re-reads which sections it has.
 */
function face(pane, wanted) {
	if (pane.facing === wanted) return;
	pane.facing = wanted;
	pane.details.hidden = wanted !== pane.details;
	if (pane.note) pane.note.hidden = wanted !== pane.note;
	let onItem = wanted === pane.details;
	if (typeof pane.sidenav.toggleDefaultStatus === 'function') {
		pane.sidenav.toggleDefaultStatus(!onItem);
	}
	if (onItem && typeof pane.details.forceUpdateSideNav === 'function') {
		pane.details.forceUpdateSideNav();
	}
}

/**
 * The editor, built the first time a note is asked for.
 *
 * Not alongside the rest of the pane: a <note-editor> loads an editor iframe
 * from its connectedCallback, and most graphs are read without a note ever being
 * opened.
 */
function ensureNote(entry, pane) {
	if (pane.note) return pane.note;
	try {
		let note = entry.win.document.createXULElement('note-editor');
		// `notitle` is read out of the attribute on connect, so it has to be
		// there before the element is in the document.
		note.setAttribute('notitle', '1');
		note.setAttribute('flex', '1');
		note.className = 'zotero-item-pane-content';
		note.hidden = true;
		pane.row.insertBefore(note, pane.sidenav);
		pane.note = note;
	}
	catch (e) {
		// A pane that cannot show notes is still a pane that shows papers.
		Zotero.logError(e);
	}
	return pane.note;
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
 * The tab is going away. There is nothing to flush: ItemDetails and the sidenav
 * both unregister their observers from disconnectedCallback (elements/base.js),
 * so closing the panel -- which takes the pane out of the document -- IS the
 * cleanup.
 */
function close(entry) {
	if (!entry) return;
	entry.itemPane = null;
	splitPane.close(entry);
}

// --- collapsing --------------------------------------------------------

/**
 * `_collapsed` for an item pane that is not inside an <item-pane>.
 *
 * ItemPaneContainerBase reads and writes it through
 * `closest('item-pane, context-pane')`, finds neither here, and so reports a
 * pane that is never collapsed and swallows every attempt to collapse it. The
 * sidenav's Toggle Item Pane button is one line on top of that property, and
 * so is the expand a section-icon click does; answering it is all either needs.
 */
function defineCollapsed(entry, details) {
	Object.defineProperty(details, '_collapsed', {
		configurable: true,
		get: () => splitPane.collapsed(entry),
		set: (val) => {
			let was = splitPane.collapsed(entry);
			splitPane.setCollapsed(entry, !!val);
			if (was && !val) redraw(entry);
		},
	});
}

/**
 * Draw again on the way back out of a collapse.
 *
 * Renders are skipped while the pane is collapsed -- core skips its sections
 * (itemDetails.js render()) and show() above does not even start -- so what is
 * behind the strip of icons on expanding is whatever was there when it was put
 * away. Forgetting what was drawn is what sends the loop back over it, and it
 * is also what gets the scroll core recorded while collapsed: a section icon
 * clicked on a collapsed pane leaves `_lastScrollPaneID` set and expects the
 * next render to honour it.
 */
function redraw(entry) {
	let pane = entry.itemPane;
	if (!pane || !pane.wanted) return;
	pane.shown = null;
	draw(entry, pane).catch(e => Zotero.logError(e));
}

// --- the pane ----------------------------------------------------------

function ensurePane(entry) {
	let box = splitPane.panel(entry);
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
	defineCollapsed(entry, details);
	// A sidenav starts every one of its buttons disabled: init() ends with
	// toggleDefaultStatus(true), and it waits to be told that something is
	// actually being viewed. Core's <item-pane> tells its own from
	// _handleViewTypeChange, and contextPane.js tells the reader's the same way
	// this does -- but a graph tab has neither, so the strip sat there at 60%
	// opacity with pointer-events: none, which is to say present and inert.
	//
	// Before the container is set, which is contextPane.js's order: render()
	// returns early while there is no container, so the strip is drawn exactly
	// once, by the assignment below, and drawn already enabled.
	//
	// Guarded because this call only decides whether the buttons are greyed. It
	// is the one thing here that can be missing without the pane itself being
	// wrong, and losing the whole item pane over a cosmetic state would be a
	// poor trade.
	if (typeof sidenav.toggleDefaultStatus === 'function') {
		sidenav.toggleDefaultStatus(false);
	}
	details.sidenav = sidenav;
	nameToggleForThisPane(doc, sidenav);

	entry.itemPane = {
		box,
		row,
		details,
		sidenav,
		note: null,        // the note editor, built on the first note (ensureNote)
		facing: details,   // whichever of the two is not hidden
		shown: null,       // the item drawn
		wanted: null,      // the item most recently clicked
		rendering: false,
	};
	return entry.itemPane;
}

/**
 * Call the toggle what it is here.
 *
 * The sidenav labels its first button from the selected tab's type: the
 * library's tab gets Toggle Item Pane and every other tab gets Toggle Context
 * Pane, because in core the only pane a non-library tab has beside it is the
 * reader's context pane. A graph tab is the third case -- a real item pane, in
 * a tab that is not the library -- and the tooltip is the only place that
 * shows. It is re-set on every render of the strip, so the correction is an
 * observer rather than one assignment; it is a tooltip either way, and a
 * Zotero that renames the message just leaves core's own wording in place.
 */
function nameToggleForThisPane(doc, sidenav) {
	const WANTED = 'toggle-item-pane';
	let button = sidenav.querySelector('[data-action="toggle-pane"]');
	if (!button || !doc.l10n) return;
	let Observer = doc.defaultView && doc.defaultView.MutationObserver;
	let fix = () => {
		if (button.getAttribute('data-l10n-id') !== WANTED) {
			doc.l10n.setAttributes(button, WANTED);
		}
	};
	if (Observer) {
		new Observer(fix).observe(button, { attributes: true, attributeFilter: ['data-l10n-id'] });
	}
	fix();
}

module.exports = { show, close };
