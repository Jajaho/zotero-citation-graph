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
 * This module is (3): the tab container gets a second <browser> next to the graph
 * and a splitter between them, and core renders into it. It is the same machinery
 * the item pane's attachment preview uses (elements/attachmentPreview.js), which
 * is what makes it safe to drive from a plugin -- we hand core a browser and it
 * owns everything inside it.
 *
 * What (3) costs, and why the header still offers (2): a ReaderPreview is
 * `_isReadOnly()` and `_isTransient()`, and it injects CSS that hides `#reader-ui`.
 * So the pane can be read, selected from and paged through, but it cannot
 * annotate, search or show the sidebar. Annotating is one click away in the
 * header, and it opens a WINDOW rather than a tab so the graph stays on screen.
 */

// Below this the reader's own layout starts fighting the pane rather than
// reflowing into it.
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 520;

// reader.html is a whole application; on a cold profile it is not instant, but
// it is not ten seconds either. Past this we report a failure instead of leaving
// an empty pane that looks like a hang.
const LOAD_TIMEOUT_MS = 10000;

const PANE_CSS = `
	.zg-reader-pane {
		min-width: ${MIN_WIDTH}px;
		background: var(--material-sidepane);
	}
	.zg-reader-splitter {
		width: 4px;
		border: none;
		background: var(--material-panedivider);
	}
	.zg-reader-head {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 3px 4px 3px 8px;
		border-bottom: 1px solid var(--material-panedivider);
		background: var(--material-toolbar);
		font-size: 11px;
	}
	.zg-reader-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
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

	let item = await Zotero.Items.getAsync(itemID);
	if (!item) return;

	let att = item.isAttachment() ? item : await item.getBestAttachment();
	if (!att) {
		status('No attachment on "' + item.getDisplayTitle() + '".');
		return;
	}
	// pdf | epub | snapshot. Anything else (an image, a bare link) has no reader
	// to render it, and ReaderInstance's constructor throws on it.
	if (!att.attachmentReaderType) {
		status('"' + item.getDisplayTitle() + '" has no PDF, EPUB or snapshot to open.');
		return;
	}
	// Returns false when the row exists but the bytes do not -- the usual state
	// of an attachment added through the local API without its file.
	if (!await att.getFilePathAsync()) {
		status('The attachment file for "' + item.getDisplayTitle() + '" is missing on disk.');
		return;
	}

	let pane = ensurePane(entry);
	if (pane.attachmentID === att.id && pane.reader) return;

	pane.attachmentID = att.id;
	pane.titleEl.textContent = item.getDisplayTitle();
	pane.openBtn.disabled = false;
	setNote(pane, 'Loading...');

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
		setNote(pane, 'The reader did not load.');
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
		setNote(pane, 'Could not render this attachment.');
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

/** Tear the pane down: remember the width, then the reader, then the DOM. */
function close(entry) {
	let pane = entry && entry.pane;
	if (!pane) return;
	saveWidth(pane);
	discardReader(pane);
	pane.splitter.remove();
	pane.box.remove();
	entry.pane = null;
}

// --- the pane ----------------------------------------------------------

function ensurePane(entry) {
	if (entry.pane) return entry.pane;

	let doc = entry.win.document;
	// The window is XHTML, so createElement() gives HTML elements and
	// createXULElement() gives XUL ones -- both are laid out by the same box.
	// The stylesheet lives inside the pane so it leaves with it.
	let style = doc.createElement('style');
	style.textContent = PANE_CSS;

	// Between the graph and the pane, resizing both: the same shape as core's
	// zotero-items-splitter (zoteroPane.xhtml).
	let splitter = doc.createXULElement('splitter');
	splitter.className = 'zg-reader-splitter';
	splitter.setAttribute('resizebefore', 'closest');
	splitter.setAttribute('resizeafter', 'closest');

	let box = doc.createXULElement('vbox');
	box.className = 'zg-reader-pane';
	box.setAttribute('width', String(storedWidth()));

	let head = doc.createElement('div');
	head.className = 'zg-reader-head';
	let titleEl = doc.createElement('span');
	titleEl.className = 'zg-reader-title';
	head.appendChild(titleEl);

	let pane = {
		box,
		splitter,
		titleEl,
		browser: null,
		reader: null,
		note: null,
		attachmentID: null,
		entry,
	};

	pane.prevBtn = button(doc, head, '‹', 'Previous page', () => goto(pane, 'prev'));
	pane.nextBtn = button(doc, head, '›', 'Next page', () => goto(pane, 'next'));
	// The preview is read-only and has no reader UI, so this is the way out to
	// annotations, search and the sidebar. A window, not a tab, because leaving
	// the graph is the one thing this whole feature exists to avoid.
	pane.openBtn = button(doc, head, 'Open ↗', 'Open in a full reader window', () => {
		if (!pane.attachmentID) return;
		Zotero.Reader.open(pane.attachmentID, null, { openInWindow: true })
			.catch(e => Zotero.logError(e));
	});
	button(doc, head, '✕', 'Close this pane', () => close(pane.entry));

	box.appendChild(head);
	box.appendChild(style);
	entry.split.appendChild(splitter);
	entry.split.appendChild(box);

	// XUL splitters fire 'command' when a drag ends; core hangs its own layout
	// bookkeeping off the same event.
	splitter.addEventListener('command', () => saveWidth(pane));

	entry.pane = pane;
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
 * handlers, inject CSS that gives the scrollbar back, and ask the reader itself
 * for ordinary vertical scrolling (`scrollMode` on a PDF, `flowMode` on an EPUB
 * -- both are properties of core's own Reader class, reached through the
 * ReaderInstance proxy).
 *
 * Internals, and best-effort on purpose: each step is guarded on its own, so if
 * core moves one of them the rest still apply and the pane at worst goes back to
 * paging through the header buttons.
 */
function loosen(reader) {
	let win = viewWindow(reader);
	if (!win) {
		Zotero.debug('[zotero-graph] reader pane: no primary view to loosen');
		return;
	}

	// Registered by ReaderPreview on the view window; both re-pin what we are
	// about to unpin, on the next resize.
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
		// 0 is pdf.js ScrollMode.VERTICAL; page-width because the pane is
		// narrower than the window the reader would otherwise get.
		tryTo('set vertical scrolling', () => {
			reader.scrollMode = 0;
		});
		tryTo('fit page width', () => {
			win.PDFViewerApplication.pdfViewer.currentScaleValue = 'page-width';
		});
	}
	else if (reader.type === 'epub') {
		tryTo('set scrolled flow', () => {
			reader.flowMode = 'scrolled';
		});
	}
}

/** The document the view actually renders into, one iframe below reader.html. */
function viewWindow(reader) {
	try {
		return reader._internalReader._primaryView._iframeWindow || null;
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

function refreshPaging(pane) {
	let can = (dir) => {
		try {
			return !!pane.reader && !!pane.reader.canGoto(dir);
		}
		catch (e) {
			return false;
		}
	};
	pane.prevBtn.disabled = !can('prev');
	pane.nextBtn.disabled = !can('next');
}

// --- remembered width --------------------------------------------------

function storedWidth() {
	let w = Number(pref('readerPaneWidth'));
	return Number.isFinite(w) && w >= MIN_WIDTH ? Math.round(w) : DEFAULT_WIDTH;
}

function saveWidth(pane) {
	let w = Math.round(pane.box.getBoundingClientRect().width);
	if (w < MIN_WIDTH) return;
	try {
		Zotero.Prefs.set('zoteroGraph.readerPaneWidth', w);
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

module.exports = { open, close };
