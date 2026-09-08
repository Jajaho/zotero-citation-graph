/* global Zotero, setTimeout */

'use strict';

/**
 * A PDF pane beside the graph, inside the graph's own tab.
 *
 * Zotero has no split tabs (tabs.js knows nothing about them), so "open the PDF
 * without leaving the graph" has exactly three shapes:
 *
 *   1. Zotero.Reader.open()                     -> a reader TAB; leaves the graph.
 *   2. Zotero.Reader.open(.., openInWindow)     -> a full reader in its own window.
 *   3. Zotero.Reader.openPreview(itemID, frame) -> a reader instance in ANY browser
 *                                                  element we own.
 *
 * This module is (3): a <browser> goes into the tab's one side panel (see
 * splitPane.js) and core renders into it. It is the same machinery the item
 * pane's attachment preview uses (elements/attachmentPreview.js), which is what
 * makes it safe to drive from a plugin -- we hand core a browser and it owns
 * everything inside it.
 *
 * The panel is shared with itemPane.js and holds one of them at a time, so
 * opening a PDF here takes it off the item pane -- and opens the panel again if
 * the chevron on its edge had hidden it. Clicking another node takes it back
 * the other way. There is no close button in the header for the same reason:
 * the divider hides either pane, and one gesture beats two.
 *
 * What (3) costs, and why the header still offers (2): a ReaderPreview is
 * `_isReadOnly()` and `_isTransient()`, and it injects CSS that hides `#reader-ui`.
 * So the pane can be read, selected from and paged through, but it cannot
 * annotate, search or show the sidebar. Annotating is one click away in the
 * header, and it opens a WINDOW rather than a tab so the graph stays on screen.
 */

let l10n = require('./l10n.js');
let splitPane = require('./splitPane.js');

// reader.html is a whole application; on a cold profile it is not instant, but
// it is not ten seconds either. Past this we report a failure instead of leaving
// an empty pane that looks like a hang.
const LOAD_TIMEOUT_MS = 10000;

const PANE_CSS = `
	.zg-reader-head {
		display: flex;
		/* Not centred: when a long title takes two or three lines the buttons
		   belong beside its first one, where they were before it wrapped. */
		align-items: flex-start;
		gap: 2px;
		padding: 3px 4px 3px 8px;
		/* The variable is the whole shorthand, width and style included. Wrapping
		   it in another one is invalid, and the header spent a while with no rule
		   under it because of that. */
		border-bottom: var(--material-panedivider);
		background: var(--material-toolbar);
		font-size: 11px;
	}
	.zg-reader-title {
		flex: 1;
		min-width: 0;
		/* Wraps rather than ellipsising, because the alternative was the title
		   pushing the buttons past the edge of the pane. A title is worth two
		   lines of a header; losing the way out to the full reader is not. */
		overflow-wrap: anywhere;
		padding-block: 3px;
		color: var(--fill-primary);
	}
	.zg-reader-btn {
		appearance: none;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--fill-secondary);
		font-size: 11px;
		line-height: 16px;
		padding: 2px 6px;
		min-width: 22px;
		/* The header shrinks the title, never the way out of it. */
		flex: none;
	}
	.zg-reader-btn:hover:not(:disabled) {
		background: var(--fill-quinary);
		color: var(--fill-primary);
	}
	.zg-reader-btn:disabled {
		opacity: 0.35;
	}
	.zg-reader-note {
		padding: 10px 12px;
		font-size: 12px;
		color: var(--fill-secondary);
	}
`;

/**
 * Show `itemID`'s best attachment in the pane, creating the pane if this is the
 * first time. Anything that can go wrong here -- no attachment, a file that is
 * registered but missing, a type no reader handles -- is reported on the graph
 * page's own status line rather than thrown: the graph is the thing on screen.
 *
 * @param {Object}   entry      the graphTab record for this tab
 * @param {Number}   itemID     a regular item, or an attachment
 * @param {Function} [status]   text back to the graph page
 */
async function open(entry, itemID, { status = () => {} } = {}) {
	if (!entry || !entry.split) return;

	let found = await readable(itemID, status);
	if (!found) return;
	let { item, att } = found;

	let pane = ensurePane(entry);
	if (pane.attachmentID === att.id && pane.reader) return;

	pane.attachmentID = att.id;
	pane.titleEl.textContent = item.getDisplayTitle();
	pane.openBtn.disabled = false;
	setNote(pane, l10n.t('reader-loading'));

	// A preview browser is single-use: core's own discard path removes the
	// element and builds a fresh one rather than pointing an existing reader at
	// another item (elements/attachmentPreview.js _processDiscard).
	discardReader(pane);
	let browser = newReaderBrowser(entry.win.document);
	pane.box.appendChild(browser);
	pane.browser = browser;

	let loaded = await whenLoaded(entry.win, browser);
	// A second open() may have raced past this await; that one owns the pane now.
	if (pane.browser !== browser) return;
	if (!loaded) {
		setNote(pane, l10n.t('reader-failed'));
		return;
	}

	let reader;
	try {
		reader = await Zotero.Reader.openPreview(att.id, browser);
		if (pane.browser !== browser) return;
		if (!await reader._open({})) throw new Error('reader reported failure');
	}
	catch (e) {
		Zotero.logError(e);
		setNote(pane, l10n.t('reader-render-failed'));
		discardReader(pane);
		return;
	}
	if (pane.browser !== browser) {
		try {
			reader.uninit();
		}
		catch (e) { /* superseded; nothing to clean up */ }
		return;
	}

	pane.reader = reader;
	setNote(pane, null);
	loosen(reader);
	refreshPaging(pane);
}

/**
 * The file to render for `itemID`, or null with the reason already on the
 * status line. Shared with the tab opener in graphTab.js so that "open it here"
 * and "open it in a tab" cannot disagree about what is openable, or explain a
 * missing file two different ways.
 *
 * The graph page cannot answer any of this for itself: the payload carries
 * items, not their files. So both menu entries are always offered and the
 * answer comes back here, on the status line.
 *
 * @param {Number}   itemID   a regular item, or an attachment
 * @param {Function} status   text back to the graph page
 * @returns {?{ item: Object, att: Object }}
 */
async function readable(itemID, status) {
	let item = await Zotero.Items.getAsync(itemID);
	if (!item) return null;

	let att = item.isAttachment() ? item : await item.getBestAttachment();
	if (!att) {
		status(l10n.t('reader-no-attachment', { title: item.getDisplayTitle() }));
		return null;
	}
	// pdf | epub | snapshot. Anything else (an image, a bare link) has no reader
	// to render it, and ReaderInstance's constructor throws on it.
	if (!att.attachmentReaderType) {
		status(l10n.t('reader-unsupported', { title: item.getDisplayTitle() }));
		return null;
	}
	// Returns false when the row exists but the bytes do not -- the usual state
	// of an attachment added through the local API without its file.
	if (!await att.getFilePathAsync()) {
		status(l10n.t('reader-missing-file', { title: item.getDisplayTitle() }));
		return null;
	}
	return { item, att };
}

/**
 * The panel has been taken by the item pane, or closed. The reader instance is
 * flushed here, while its browser is still in the document; the elements
 * themselves go with the panel.
 */
function forget(entry) {
	let pane = entry.reader;
	if (!pane) return;
	entry.reader = null;
	discardReader(pane);
}

// --- the pane ----------------------------------------------------------

function ensurePane(entry) {
	// Through claim() every time, before the early return below: claiming shows
	// the panel if the chevron had hidden it, so "Open PDF beside the graph"
	// brings the reader back rather than loading a paper out of sight.
	let box = splitPane.claim(entry, 'reader', () => forget(entry));
	if (entry.reader) return entry.reader;

	let doc = entry.win.document;
	// The window is XHTML, so createElement() gives HTML elements and
	// createXULElement() gives XUL ones -- both are laid out by the same box.
	// Inside the box, so it leaves when the panel changes hands.
	let style = doc.createElement('style');
	style.textContent = PANE_CSS;

	let head = doc.createElement('div');
	head.className = 'zg-reader-head';
	let titleEl = doc.createElement('span');
	titleEl.className = 'zg-reader-title';
	head.appendChild(titleEl);

	let pane = {
		box,
		titleEl,
		browser: null,
		reader: null,
		note: null,
		attachmentID: null,
	};

	pane.prevBtn = button(doc, head, '‹', l10n.t('reader-prev'), () => goto(pane, 'prev'));
	pane.nextBtn = button(doc, head, '›', l10n.t('reader-next'), () => goto(pane, 'next'));
	// The preview is read-only and has no reader UI, so this is the way out to
	// annotations, search and the sidebar. A window, not a tab, because leaving
	// the graph is the one thing this whole feature exists to avoid.
	pane.openBtn = button(doc, head, l10n.t('reader-open'), l10n.t('reader-open-hint'), () => {
		if (!pane.attachmentID) return;
		Zotero.Reader.open(pane.attachmentID, null, { openInWindow: true })
			.catch(e => Zotero.logError(e));
	});
	// No close button: the panel is hidden from the chevron on its edge,
	// which is the one gesture that puts either pane away. A ✕ here would have
	// been a second way to do it, and only for this one of the two.

	box.appendChild(head);
	box.appendChild(style);

	entry.reader = pane;
	return pane;
}

function button(doc, parent, label, hint, onClick) {
	let b = doc.createElement('button');
	b.className = 'zg-reader-btn';
	b.textContent = label;
	b.title = hint;
	b.addEventListener('click', onClick);
	parent.appendChild(b);
	return b;
}

function newReaderBrowser(doc) {
	let b = doc.createXULElement('browser');
	b.setAttribute('class', 'zg-reader-browser');
	b.setAttribute('flex', '1');
	b.setAttribute('type', 'content');
	b.setAttribute('primary', 'true');
	b.setAttribute('transparent', 'true');
	b.setAttribute('tooltip', 'html-tooltip');
	b.setAttribute('src', 'resource://zotero/reader/reader.html');
	b.style.minWidth = '0';
	return b;
}

/** DOMContentLoaded for one browser's document, the way graphTab waits for its own. */
function whenLoaded(win, browser) {
	let ready = browser.contentDocument && browser.contentDocument.readyState;
	if (ready === 'interactive' || ready === 'complete') return Promise.resolve(true);
	return new Promise((resolve) => {
		let done = (ok) => {
			win.removeEventListener('DOMContentLoaded', onLoad);
			resolve(ok);
		};
		let onLoad = (event) => {
			if (browser.contentWindow && browser.contentWindow.document === event.target) done(true);
		};
		win.addEventListener('DOMContentLoaded', onLoad);
		setTimeout(() => done(false), LOAD_TIMEOUT_MS);
	});
}

function discardReader(pane) {
	if (pane.reader) {
		let reader = pane.reader;
		pane.reader = null;
		try {
			reader.uninit();
		}
		catch (e) { /* a half-opened preview has nothing to flush */ }
	}
	if (pane.browser) {
		pane.browser.remove();
		pane.browser = null;
	}
}

/**
 * A note in place of the reader: same slot, so the pane is never blank without
 * saying why.
 */
function setNote(pane, text) {
	if (!text) {
		if (pane.note) {
			pane.note.remove();
			pane.note = null;
		}
		return;
	}
	if (!pane.note) {
		pane.note = pane.box.ownerDocument.createElement('div');
		pane.note.className = 'zg-reader-note';
		pane.box.appendChild(pane.note);
	}
	pane.note.textContent = text;
}

/**
 * CSS undoing ReaderPreview's per-type CSS, injected into the same document it
 * injected into -- the view's own iframe, not reader.html.
 *
 * The pdf rule is the one that matters: `#viewerContainer { overflow: hidden }`
 * is what makes a preview a still image, and no scroll mode can get around it.
 * Its epub counterpart is not CSS at all -- paginated flow is a mode, and
 * switching it drops the `flow-mode-paginated` rules with it -- so epub is
 * handled in loosen() below. Snapshots are frozen by `pointer-events: none` and
 * a `--win-scale` transform, both of which have to go for the page to scroll.
 */
const UNPREVIEW_CSS = {
	pdf: `
		#viewerContainer { overflow: auto !important; }
	`,
	snapshot: `
		html {
			pointer-events: auto !important;
			user-select: auto !important;
			transform: none !important;
			min-width: 0 !important;
			overflow-x: auto !important;
		}
	`,
};

/**
 * Turn the preview back into something readable.
 *
 * ReaderPreview is built for a thumbnail in the item pane, so on top of hiding
 * the reader UI it pins the scale to page-height, puts pdf.js in page mode
 * (scrollMode 3), locks `#viewerContainer` to `overflow: hidden`, and re-applies
 * the first two on every resize. In a half-screen pane that is a slide deck you
 * cannot even page with the wheel, so all four are undone here: drop the resize
 * handlers, inject CSS that gives the scrollbar back, and put the view into
 * ordinary vertical scrolling.
 *
 * The mode switch goes to the VIEW's own method, not to core's Reader-level
 * `scrollMode`/`flowMode` properties. Those look like the polite way in, but
 * their getters read `_state.primaryViewStats`, which a preview instance does
 * not reliably have -- so the assignment quietly lands nowhere and the viewer
 * stays in page mode. That matters more than it sounds: in page mode pdf.js
 * empties the viewer and appends only the current page (`#ensurePageViewVisible`
 * does `viewer.textContent = ''`), so a scrollable container over an unswitched
 * viewer scrolls a one-page document. Hence the check after the switch.
 *
 * Internals, and best-effort on purpose: each step is guarded on its own, so if
 * core moves one of them the rest still apply and the pane at worst goes back to
 * paging through the header buttons.
 */
function loosen(reader) {
	let view = primaryView(reader);
	let win = view && view._iframeWindow;
	if (!win) {
		Zotero.debug('[zotero-graph] reader pane: no primary view to loosen');
		return;
	}

	// Registered by ReaderPreview on the view window; both re-pin what we are
	// about to unpin, on the next resize -- including the resize you cause by
	// dragging the splitter.
	for (let handler of [reader.updatePDFAttr, reader.updateSnapshotAttr]) {
		if (handler) tryTo('drop preview resize handler', () => win.removeEventListener('resize', handler));
	}

	let css = UNPREVIEW_CSS[reader.type];
	if (css) {
		tryTo('inject scroll CSS', () => {
			let style = win.document.createElement('style');
			style.textContent = css;
			(win.document.head || win.document.documentElement).appendChild(style);
		});
	}

	if (reader.type === 'pdf') {
		// 0 is pdf.js ScrollMode.VERTICAL, 3 is PAGE.
		tryTo('switch to vertical scrolling', () => view.setScrollMode(0));
		tryTo('confirm vertical scrolling', () => {
			let viewer = win.PDFViewerApplication.pdfViewer;
			// Straight at pdf.js, which is where the view's dispatch ends up
			// anyway. Only reached if the dispatch did not take.
			if (viewer.scrollMode !== 0) viewer.scrollMode = 0;
			// After the page-height the preview asked for, on a pane narrower
			// than the window a reader would otherwise get.
			viewer.currentScaleValue = 'page-width';
		});
	}
	else if (reader.type === 'epub') {
		// Paginated flow is a mode, not CSS: leaving it would keep the preview's
		// `flow-mode-paginated` viewport caps whatever we injected.
		tryTo('switch to scrolled flow', () => view.setFlowMode('scrolled'));
	}
}

/** The view that renders the file, one iframe below reader.html. */
function primaryView(reader) {
	try {
		return reader._internalReader._primaryView || null;
	}
	catch (e) {
		return null;
	}
}

function tryTo(what, fn) {
	try {
		fn();
	}
	catch (e) {
		Zotero.debug('[zotero-graph] reader pane could not ' + what + ': ' + e);
	}
}

function goto(pane, dir) {
	if (!pane.reader) return;
	try {
		pane.reader.goto(dir);
	}
	catch (e) {
		Zotero.logError(e);
	}
	// canNavigateTo* comes off the view's own state, which lands a frame or two
	// after the call.
	setTimeout(() => refreshPaging(pane), 250);
}

/**
 * Only a definite `false` disables a paging button. canGoto() reads view stats
 * that a preview does not always carry, and returns undefined when they are
 * missing -- greying out working buttons because the answer was "don't know" is
 * worse than a button that occasionally does nothing.
 */
function refreshPaging(pane) {
	let can = (dir) => {
		try {
			return pane.reader ? pane.reader.canGoto(dir) : false;
		}
		catch (e) {
			return undefined;
		}
	};
	pane.prevBtn.disabled = can('prev') === false;
	pane.nextBtn.disabled = can('next') === false;
}

module.exports = { open, readable };
