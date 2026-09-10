/* global Zotero */

'use strict';

/**
 * Zotero's own item pane, beside the graph, describing the node you clicked.
 *
 * This is the same element the library pane builds for the item you click:
 * `<item-details>` (elements/itemDetails.js) with an `<item-pane-sidenav>`
 * beside it, in a `<deck>` it shares with the note editor -- see face(). Not a copy of it, and not a reimplementation -- the actual custom
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
 * Putting it away is core's own Toggle Item Pane button, first in the sidenav,
 * through `_collapsed` -- which ItemPaneContainerBase resolves by looking for an
 * enclosing `<item-pane>` or `<context-pane>`. There is neither of those here,
 * so the button was inert (and hidden) until that property was answered: the
 * instance below shadows it with one that drives splitPane.js instead. Nothing
 * else about the button changes -- not the icon, not the keyboard handling, not
 * what a section click does on the way past.
 *
 * What it collapses TO is the reader's answer and not the library's: the whole
 * panel leaves the layout, this sidenav with it, and the graph takes the tab
 * back. So this button is a one-way door -- there is no strip of icons left to
 * click -- and the way back is the button at the end of the graph page's top
 * bar, which is on screen exactly when this one is not, in the same place. See
 * splitPane.js.
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
	/* What core's own <groupbox pack="center" align="center"> does for this
	   prompt in the library window, said in CSS. See ensureBatchPrompt(). */
	.zg-batch-prompt {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border-width: 0;
	}
	/* core: item-pane #batch-edit-prompt-message */
	.zg-batch-prompt-message {
		padding: 3px 8px;
	}
`;

/**
 * Say what is selected, creating the pane if this is the first time.
 *
 * The whole selection, and not one item, because the pane has a different
 * answer for each size of it -- and they are the library's answers, out of
 * core's own ItemPane.render() (elements/itemPane.js):
 *
 *   nothing   the count of what is in the view: "27 items in this view". The
 *             pane is never blank in Zotero, and a graph with nothing picked
 *             is the same state as a collection with no row selected.
 *   one       that paper's sections, or the note's editor. As it always was.
 *   several   the count, and an offer to edit them together -- core's own
 *             opt-in prompt, and behind it core's own multi-item info box.
 *
 * Renders are serialised rather than fired per message: a render walks every
 * section of the pane and awaits the slow ones, and a run of clicks across a
 * cluster can land three before the first is drawn. Only the latest selection
 * is ever drawn -- the ones passed over in between are dropped.
 *
 * @param {Object}   entry      the graphTab record for this tab
 * @param {Number[]} itemIDs    regular items, their children, or notes
 * @param {Number}   [inView]   how many items the graph is drawing, for the
 *                              empty-selection message; kept when not given
 * @param {Function} [status]   text back to the graph page
 * @param {Boolean}  [expand]   open the pane if it was put away
 */
async function show(entry, itemIDs, { inView = null, status = () => {}, expand = false } = {}) {
	if (!entry || !entry.split) return;

	let items = await resolve(itemIDs);

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

	// Only the page knows this, and only some messages carry it: core's own
	// selectItems() reaches here too, and it is telling us about an item rather
	// than about the view. The last count the page gave stands in that case.
	if (inView != null) pane.inView = inView;
	want(pane, items);

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
		pane.shownKey = null;
	}

	// Someone who collapsed the pane is not asking for it back every time they
	// click a node. What they clicked is still recorded, and drawn the moment
	// the pane is expanded again -- so the way back lands on the paper last
	// chosen rather than on whatever was there when it was put away.
	if (splitPane.collapsed(entry)) return;
	await draw(entry, pane);
}

/**
 * The selection as items to draw.
 *
 * The library shows the parent's pane when you select an attachment, and so
 * does the context pane. Nodes are regular items today, but that is a fact
 * about the payload, not about this.
 *
 * A note is the exception, and for the same reason the library makes it one:
 * a note is not a fact about its paper, it is a document, and selecting one
 * means opening it. See showNote().
 *
 * Two children of one paper are one selection of one paper, which is why the
 * duplicates are dropped after that substitution rather than before it.
 */
async function resolve(itemIDs) {
	let items = [];
	let seen = new Set();
	for (let id of itemIDs || []) {
		let item = await Zotero.Items.getAsync(id);
		if (!item) continue;
		let target = item.isNote() ? item : (item.parentItem || item);
		if (seen.has(target.id)) continue;
		seen.add(target.id);
		items.push(target);
	}
	return items;
}

/**
 * Record what to draw, and work out whether it differs from what is drawn.
 *
 * The key is what the render loop compares, and what goes into it is exactly
 * what changes the picture. The view count is in it ONLY for an empty
 * selection: it moves every time a filter does, and a pane showing a paper must
 * not be torn down and rebuilt because a slider went past a node.
 *
 * The batch-editing opt-in is dropped whenever the set of papers changes, which
 * is core's own rule (ItemPane.render()): a different selection is a different
 * question, and it should be put again rather than answered by a choice the
 * last one left behind.
 */
function want(pane, items) {
	let ids = items.map(i => i.id).join(',');
	// Whether this is a fresh answer to "what is selected" or the same answer
	// with a new number in it. A filter moving the count of the view is the
	// second kind, and it must not take the deck away from the gap list the
	// user is reading down -- see showMessage(). `wantedIDs` starts null rather
	// than empty so that the first empty selection is a change like any other.
	pane.quiet = ids === pane.wantedIDs;
	if (!pane.quiet) {
		if (pane.batch) setBatchCollapsible(pane, false);
		pane.batch = false;
		pane.wantedIDs = ids;
	}
	pane.wanted = items;
	pane.wantedKey = items.length
		? ids + (pane.batch ? '|batch' : '')
		: '|view:' + pane.inView;
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
		while (entry.itemPane === pane && pane.wantedKey !== pane.shownKey) {
			pane.shownKey = pane.wantedKey;
			await drawOnce(entry, pane, pane.wanted);
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
 * One selection, drawn.
 *
 * The order of the tests is core's own (ItemPane.render()), and so is every
 * branch of it bar the duplicates pane, which a graph tab cannot be showing.
 */
async function drawOnce(entry, pane, items) {
	if (!items.length) {
		// The count of the view rather than "0 items selected", which is core's
		// choice too: a pane saying how much there is to click on is more use
		// than one saying you have not clicked yet.
		showMessage(entry, pane, 'item-pane-message-unselected', pane.inView);
		return;
	}
	if (items.length === 1) {
		if (items[0].isNote()) showNote(entry, pane, items[0]);
		else await showDetails(entry, pane, items);
		return;
	}
	// Several. Only regular items can be edited side by side -- core's own test
	// -- and a selection with a note or a standalone attachment in it gets the
	// count and nothing else, exactly as the library gives it.
	if (!items.every(i => i.isRegularItem())) {
		showMessage(entry, pane, 'item-pane-message-items-selected', items.length);
		return;
	}
	if (!pane.batch) {
		showBatchPrompt(entry, pane, items.length);
		return;
	}
	await showDetails(entry, pane, items);
}

/**
 * The paper's own pane: every section core registers, editable exactly as in the
 * library.
 *
 * Several papers is the same element with `extraItems` set, which is how core
 * does it and where all of the multi-item editing lives: the info box reads
 * that list, shows "Multiple" wherever the papers disagree, and writes a change
 * to every one of them. Everything below the info section hides itself while it
 * is set (ItemDetails.render()), because there is no one abstract and no one
 * set of attachments to show.
 */
async function showDetails(entry, pane, items) {
	pane.details.editable = items.every(editable);
	pane.details.item = items[0];
	pane.details.extraItems = items.slice(1);
	face(pane, pane.details);
	batchHead(entry, pane, items.length);
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

// --- what the pane says when it is not describing a paper ---------------

/**
 * A count in the middle of the pane, in core's own <item-message-pane>.
 *
 * The element, and not a box of our own with the same words in it, for the
 * reason the rest of this file uses core's elements: `render({ l10nId,
 * l10nArgs })` is its whole API, the strings are the ones the library window
 * puts on screen -- plurals, translations and all -- and it is styled by
 * Zotero's own stylesheet under its element name, so it looks like the library
 * without a line of CSS from us.
 *
 * The ids inside its template are core's, and there is now a second element in
 * this window carrying them. Nothing looks them up: ItemPane reaches its own
 * with querySelector, and the one stylesheet rule keyed on one of them is an
 * id SELECTOR, which matches ours just as happily. See ensureMessage().
 *
 * @param {String} id     a core message string: which count this is
 * @param {Number} count  what it counts
 */
function showMessage(entry, pane, id, count) {
	let message = ensureMessage(entry, pane);
	if (!message) return;
	message.render({ l10nId: id, l10nArgs: { count: Number(count) || 0 } });
	// A restated count is not a reason to change what the pane is showing. The
	// count moves every time a filter does, and the gap list is a page of this
	// same deck -- so a slider dragged while that list was open would close it,
	// and would go on closing it every few pixels. See want().
	if (!pane.quiet) face(pane, message);
}

/**
 * The offer to edit several papers at once.
 *
 * Core does not put multiple items into the info box unasked -- ItemPane.render()
 * shows this prompt instead and waits for the button, because the multi-item box
 * writes every edit to every selected paper and that is not a thing to walk into
 * by clicking a second node. So the prompt is copied rather than skipped: the
 * count, and the button that means it.
 *
 * Answering it is the other half of core's: the info section is forced open and
 * held there while batch editing is on (setBatchCollapsible), and the head of
 * the pane says what is being edited with a way out (batchHead).
 */
function showBatchPrompt(entry, pane, count) {
	let prompt = ensureBatchPrompt(entry, pane);
	if (!prompt) {
		// Nothing to opt in with is no reason to show nothing at all.
		showMessage(entry, pane, 'item-pane-message-items-selected', count);
		return;
	}
	entry.win.document.l10n.setAttributes(prompt.message,
		'item-pane-message-items-selected', { count });
	face(pane, prompt.box);
}

/**
 * Turn batch editing on, and draw the pane it asks for.
 *
 * The order is core's: the info section is pinned open BEFORE the render, so
 * that the one section a multi-item pane has is the one it opens on.
 */
function enableBatch(entry, pane) {
	pane.batch = true;
	setBatchCollapsible(pane, true);
	want(pane, pane.wanted);
	draw(entry, pane).catch(e => Zotero.logError(e));
}

/** Done: back to the count and the offer, with the same selection still made.
 *  Core's own Done button, and the same three lines behind it. */
function disableBatch(entry, pane) {
	setBatchCollapsible(pane, false);
	pane.batch = false;
	want(pane, pane.wanted);
	draw(entry, pane).catch(e => Zotero.logError(e));
}

/**
 * The head of the pane while several papers are being edited: what is being
 * edited, and the button that stops.
 *
 * core's renderBatchEditHead(), through the same renderCustomHead() hook -- so
 * the icon beside it is core's, drawn by a stylesheet rule keyed on the
 * `batch-edit` class <item-pane-header> puts on itself the moment extraItems is
 * set. Cleared for a single paper, because a head left over from the last
 * selection would sit above a pane that is no longer editing anything.
 */
function batchHead(entry, pane, count) {
	let details = pane.details;
	if (typeof details.renderCustomHead !== 'function') return;
	if (count < 2) {
		details.renderCustomHead();
		return;
	}
	details.renderCustomHead(({ doc, append }) => {
		let icon = doc.createElement('span');
		icon.className = 'batch-edit-head-icon';
		let description = doc.createXULElement('description');
		doc.l10n.setAttributes(description, 'item-pane-batch-editing-header', { count });
		let done = doc.createXULElement('button');
		done.setAttribute('default', 'true');
		doc.l10n.setAttributes(done, 'item-pane-batch-editing-done');
		done.addEventListener('command', () => disableBatch(entry, pane));
		append(icon, description, done);
	});
}

/**
 * Hold the info section open, or give it back.
 *
 * Verbatim from core's _setBatchEditCollapsible(), including the reason for
 * `_skipSaveOpenState`: forcing the section open must not become the state the
 * pane remembers for every paper afterwards. Guarded at every step -- this is
 * reaching into the private shape of a core element, and a Zotero that has
 * moved it should cost the pinning and not the pane.
 */
function setBatchCollapsible(pane, on) {
	try {
		let section = pane.details.querySelector('collapsible-section[data-pane="info"]');
		if (!section) return;
		if (on) {
			section._skipSaveOpenState = true;
			section.open = true;
			section._skipSaveOpenState = false;
			section.collapsible = false;
			section.showContextMenu = false;
		}
		else {
			section.collapsible = true;
			section.showContextMenu = true;
			if (typeof section._restoreOpenState === 'function') section._restoreOpenState();
		}
	}
	catch (e) {
		Zotero.logError(e);
	}
}

/**
 * Which of the two is on screen, and what the sidenav makes of it.
 *
 * A <deck>, which is core's own way of holding these two (itemPane.js), and NOT
 * because it is tidier. `hidden` is display: none, and an <item-details> with no
 * box at all is one whose sections stop intersecting the viewport -- so its
 * IntersectionObserver discards every one of them, each discard hides a section,
 * and each hidden section is a mutation that tells the sidenav to take that
 * section's button away. Opening one note emptied the whole strip, and it stayed
 * empty, because nothing puts those buttons back until the sections render
 * again. A deck's unselected child keeps its box and its size -- toolkit gives
 * it `visibility: hidden`, not `display: none` -- so nothing observes anything
 * and the pane is exactly where it was left.
 *
 * The strip of icons is then core's rule verbatim (itemPane.js
 * _handleViewTypeChange): section buttons mean nothing beside a note editor, so
 * they go back to their default state -- present and greyed, which is what the
 * library window shows for a selected note -- and coming back to the paper
 * re-reads which sections it has.
 */
function face(pane, wanted) {
	if (pane.facing === wanted) return;
	pane.facing = wanted;
	pane.deck.selectedPanel = wanted;
	let onItem = wanted === pane.details;
	if (typeof pane.sidenav.toggleDefaultStatus === 'function') {
		pane.sidenav.toggleDefaultStatus(!onItem);
	}
	if (onItem && typeof pane.details.forceUpdateSideNav === 'function') {
		pane.details.forceUpdateSideNav();
	}
	// Whoever else is interested in which page is up. The gap list is: the
	// graph page draws a menu entry from whether the list is showing, and this
	// deck can be turned away from it by a click on a node as readily as by the
	// list's own close button -- so chrome tells, rather than the page
	// remembering something it does not decide. See lib/gapsPane.js.
	if (typeof pane.onFace === 'function') pane.onFace(wanted);
}

/**
 * Core's message pane, built the first time there is a count to say.
 *
 * Late like the note editor, and for the same reason: a graph is opened on a
 * click that picks one node, so the first thing this deck ever shows is a
 * paper. The empty selection comes later, if it comes at all.
 */
function ensureMessage(entry, pane) {
	if (pane.message) return pane.message;
	try {
		let message = entry.win.document.createXULElement('item-message-pane');
		// Into the deck, where it is another page and the one nothing is
		// looking at until face() says so. Appending re-runs the deck's own
		// childList observer, which keeps the current page selected.
		pane.deck.appendChild(message);
		pane.message = message;
	}
	catch (e) {
		// A pane that cannot say "27 items in this view" is still a pane that
		// shows papers.
		Zotero.logError(e);
	}
	return pane.message;
}

/**
 * The batch-editing prompt, built the first time two nodes are picked.
 *
 * Core's markup (ItemPane's content template) with core's two strings, in a box
 * of our own rather than in a `<groupbox pack="center" align="center">`: those
 * two attributes are what centre it over there, and this file does not assume
 * which XUL attributes a given Zotero still maps -- PANE_CSS says the same
 * thing in CSS. The ids are left off for the same reason ensureMessage() notes
 * they are harmless there and no better: nothing needs them, and core's one
 * rule for the message is keyed on an <item-pane>, which this panel is not.
 */
function ensureBatchPrompt(entry, pane) {
	if (pane.prompt) return pane.prompt;
	try {
		let doc = entry.win.document;
		let box = doc.createXULElement('groupbox');
		box.className = 'zg-batch-prompt';
		doc.l10n.setAttributes(box, 'item-pane-batch-editing-prompt');

		let message = doc.createXULElement('description');
		message.className = 'zg-batch-prompt-message';

		let button = doc.createXULElement('button');
		doc.l10n.setAttributes(button, 'item-pane-batch-editing-enable');
		button.addEventListener('command', () => enableBatch(entry, pane));

		box.appendChild(message);
		box.appendChild(button);
		pane.deck.appendChild(box);
		pane.prompt = { box, message };
	}
	catch (e) {
		// Caller falls back to the count on its own -- see showBatchPrompt().
		Zotero.logError(e);
	}
	return pane.prompt;
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
		// Into the deck, where it is the second page and the one nothing is
		// looking at until face() says so. Appending re-runs the deck's own
		// childList observer, which keeps the current page selected.
		pane.deck.appendChild(note);
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
		set: val => collapse(entry, val),
	});
}

/**
 * Put the pane away, or bring it back.
 *
 * The collapse itself is splitPane's; what belongs here is the redraw on the
 * way back out, and that is why this is a function rather than two lines at
 * each caller. Core's Toggle Item Pane writes _collapsed above; the button in
 * the top bar comes through graphTab. Both have to leave the pane showing the
 * item it was showing, and a collapse that skipped the redraw would leave
 * whatever was drawn before it was put away.
 */
function collapse(entry, val) {
	if (!entry || !entry.pane) return;
	let was = splitPane.collapsed(entry);
	splitPane.setCollapsed(entry, !!val);
	if (was && !val) redraw(entry);
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
	if (!pane || pane.wantedKey == null) return;
	pane.shownKey = null;
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

	// The two things that can be in the pane -- a paper's sections, or a note --
	// stacked in core's own <deck>. See face() for why a deck and not `hidden`.
	//
	// The class goes on the deck rather than on what is inside it, which is where
	// core's <item-pane> puts it too: it is what core's stylesheet sizes and
	// colours an item pane by, and here it also has to be the thing the collapsed
	// rule in PANE_CSS can find as a child of the row.
	let deck = doc.createXULElement('deck');
	deck.className = 'zotero-item-pane-content';
	deck.setAttribute('selectedIndex', '0');
	deck.setAttribute('flex', '1');

	let details = doc.createXULElement('item-details');
	let sidenav = doc.createXULElement('item-pane-sidenav');
	sidenav.className = 'zotero-view-item-sidenav';
	// There is no notes context beside a graph, and the button would open a
	// deck that does not exist.
	sidenav.setAttribute('no-context-notes', 'true');

	deck.appendChild(details);
	row.appendChild(deck);
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
		deck,
		details,
		sidenav,
		note: null,        // the note editor, built on the first note (ensureNote)
		message: null,     // core's message pane, built on the first count
		prompt: null,      // the batch-editing offer, built on the first pair
		facing: details,   // the deck page on show
		shownKey: null,    // key(want()) of what is drawn
		wanted: [],        // the items most recently selected
		wantedIDs: null,   // their ids, for noticing a change of selection
		wantedKey: null,   // and the key those and the batch flag make
		batch: false,      // several papers, and the offer taken up
		inView: 0,         // items the graph is drawing, from the page
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

/*
 * ensurePane and face are out here for lib/gapsPane.js, which adds a third page
 * to this deck. They are deliberately the same two functions this file uses
 * itself rather than a facade over them: a second way to reach the deck is a
 * second thing that can come to disagree with face() about which page is up,
 * and `facing` is what both sides read.
 */
module.exports = { show, close, collapse, pane: ensurePane, face };
