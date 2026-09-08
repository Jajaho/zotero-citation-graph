/* global Zotero */

'use strict';

/**
 * The one pane beside the graph, and whoever currently has it.
 *
 * Both things this plugin can put next to the graph -- a reader
 * (readerPane.js) and Zotero's item pane (itemPane.js) -- describe the paper
 * you are looking at, and they want the same screen. So there is one panel,
 * one splitter and one remembered width: claiming it empties whatever was in
 * it, and the occupant being displaced is told first, because a reader
 * instance has listeners and a docShell to flush and an item pane has
 * observers registered with Zotero.Notifier.
 *
 * Sizing is the part that needs care, and the reason this module exists rather
 * than a rule saying "close the other one first".
 *
 * A XUL splitter resizes by writing a `width` ATTRIBUTE onto the elements
 * either side of it, so that attribute has to stay the source of truth or
 * dragging stops working. But a panel sized only by that attribute is at the
 * mercy of whether the attribute wins over what is inside it -- and an item
 * pane's content is an abstract on one very long line, which is wide enough to
 * push the graph clean off the screen. Hence both of:
 *
 *   contain: inline-size    the panel's width never depends on its contents
 *   attribute -> style      mirrored, so the width the splitter writes is the
 *                           width the panel actually gets
 */

// An item pane's own 320px minimum plus its 37px sidenav -- the wider of the
// two occupants, and the panel is one panel.
const MIN_WIDTH = 357;
const DEFAULT_WIDTH = 520;

const PANE_CSS = `
	.zg-pane-splitter {
		width: 4px;
		border: none;
		background: var(--material-panedivider);
	}
	.zg-pane {
		min-width: ${MIN_WIDTH}px;
		background: var(--material-sidepane);
		/* Nothing inside the panel gets a say in how wide it is. */
		contain: inline-size;
		flex-grow: 0;
		flex-shrink: 1;
	}
`;

/**
 * Take the panel for `kind`, building it if this is the first time and
 * emptying it if something else had it.
 *
 * @param {Object}   entry     the graphTab record for this tab
 * @param {String}   kind      'reader' | 'item'
 * @param {Function} teardown  called when this occupant loses the panel
 * @returns {Element} the box to build into -- empty, unless it was already ours
 */
function claim(entry, kind, teardown) {
	let pane = entry.pane || create(entry);
	if (pane.kind !== kind) {
		release(pane);
		pane.kind = kind;
	}
	pane.teardown = teardown;
	return pane.box;
}

/** Whether `kind` is what the panel is currently showing. */
function has(entry, kind) {
	return !!(entry && entry.pane && entry.pane.kind === kind);
}

/** Close the panel altogether: the width is remembered, the occupant told. */
function close(entry) {
	let pane = entry && entry.pane;
	if (!pane) return;
	saveWidth(pane);
	entry.pane = null;
	release(pane);
	if (pane.observer) pane.observer.disconnect();
	pane.splitter.remove();
	pane.box.remove();
	pane.style.remove();
}

/**
 * Hand the panel back: the occupant flushes its own state while its elements
 * are still in the document -- a reader has to uninit() before its browser
 * goes -- and only then is the box emptied.
 */
function release(pane) {
	let teardown = pane.teardown;
	pane.teardown = null;
	pane.kind = null;
	if (teardown) {
		try {
			teardown();
		}
		catch (e) {
			Zotero.logError(e);
		}
	}
	while (pane.box.firstChild) pane.box.firstChild.remove();
}

function create(entry) {
	let doc = entry.win.document;

	// Beside the box rather than inside it, so emptying the box on a handover
	// does not take the panel's own styling with it.
	let style = doc.createElement('style');
	style.textContent = PANE_CSS;

	// The same shape as core's zotero-items-splitter (zoteroPane.xhtml).
	let splitter = doc.createXULElement('splitter');
	splitter.className = 'zg-pane-splitter';
	splitter.setAttribute('resizebefore', 'closest');
	splitter.setAttribute('resizeafter', 'closest');

	// A column: the reader stacks a header over its browser, and the item pane
	// puts its own row inside. Either way the panel is one box.
	let box = doc.createXULElement('vbox');
	box.className = 'zg-pane';

	entry.split.appendChild(style);
	entry.split.appendChild(splitter);
	entry.split.appendChild(box);

	let pane = { box, splitter, style, kind: null, teardown: null, observer: null };
	setWidth(pane, storedWidth());

	// The splitter writes the attribute as the drag goes; this is what makes
	// that visible whether or not the attribute is honoured by itself.
	let Observer = entry.win.MutationObserver;
	if (Observer) {
		pane.observer = new Observer(() => mirrorWidth(pane));
		pane.observer.observe(box, { attributes: true, attributeFilter: ['width'] });
	}
	// XUL splitters fire 'command' when a drag ends; core hangs its own layout
	// bookkeeping off the same event.
	splitter.addEventListener('command', () => saveWidth(pane));

	entry.pane = pane;
	return pane;
}

function setWidth(pane, px) {
	pane.box.setAttribute('width', String(px));
	pane.box.style.width = px + 'px';
}

function mirrorWidth(pane) {
	let w = Number(pane.box.getAttribute('width'));
	if (Number.isFinite(w) && w > 0) pane.box.style.width = w + 'px';
}

function storedWidth() {
	// paneWidth is the one panel's width. readerPaneWidth is what the reader
	// pane remembered before there was anything else to share with, and is read
	// here so an existing profile opens at the size its owner last chose.
	let w = Number(pref('paneWidth') || pref('readerPaneWidth'));
	return Number.isFinite(w) && w >= MIN_WIDTH ? Math.round(w) : DEFAULT_WIDTH;
}

function saveWidth(pane) {
	let w = Math.round(pane.box.getBoundingClientRect().width);
	if (w < MIN_WIDTH) return;
	try {
		Zotero.Prefs.set('zoteroGraph.paneWidth', w);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

/** Zotero.Prefs auto-prefixes 'extensions.zotero.'; see addon/prefs.js. */
function pref(name) {
	try {
		return Zotero.Prefs.get('zoteroGraph.' + name);
	}
	catch (e) {
		return null;
	}
}

module.exports = { claim, has, close, MIN_WIDTH };
