/* global Zotero */

'use strict';

/**
 * The one pane beside the graph: who has it, how wide it is, and whether it is
 * showing at all.
 *
 * Both things this plugin can put next to the graph -- a reader
 * (readerPane.js) and Zotero's item pane (itemPane.js) -- describe the paper
 * you are looking at, and they want the same screen. So there is one panel,
 * one splitter and one remembered width: claiming it empties whatever was in
 * it, and the occupant being displaced is told first, because a reader
 * instance has listeners and a docShell to flush and an item pane has
 * observers registered with Zotero.Notifier.
 *
 * Hiding it is one gesture too: a chevron hung off the panel's outer edge, at
 * the height your eye is already at. Whatever is in the panel, that is how it
 * goes away, and clicking it again brings back exactly what was there --
 * collapsing hides the panel rather than tearing its occupant down, so a reader
 * keeps its page and an item pane its scroll position.
 *
 * A hidden panel stays hidden. Someone who put it away is not asking for it
 * back every time they click a node, so claim() only shows the panel when the
 * caller says the request was a request to SEE something -- opening a PDF is,
 * clicking a node is not (itemPane.js keeps its pane up to date behind the
 * chevron instead, so the way back lands on the paper you last chose).
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
 *                           width the panel gets
 *
 * The chevron is sized by the same problem from the other side. It was once
 * parked over the divider by measuring the panel and writing an offset, and it
 * kept disappearing: every way the panel can change width without the width
 * attribute changing -- the window narrowing, min-width biting, a drag Gecko
 * applied to the graph side instead -- left the offset stale, and a stale offset
 * puts the button past the edge of the tab. So nothing is measured now. The
 * button is a child of the panel, absolutely positioned one button-width to the
 * left of it, and it follows the panel's edge because it IS the panel's edge.
 */

let l10n = require('./l10n.js');

// An item pane's own 320px minimum plus its 37px sidenav -- the wider of the
// two occupants, and the panel is one panel.
const MIN_WIDTH = 357;
const DEFAULT_WIDTH = 520;

// Kept in step with the CSS below only as documentation -- the button's own
// width is what pushes it off the panel's edge, in CSS, with no measuring.
const TOGGLE_WIDTH = 18;

const PANE_CSS = `
	.zg-pane-splitter {
		width: 4px;
		border: none;
		background: var(--material-panedivider);
	}
	/* The divider stays put when the panel is hidden -- it is what the way back
	   sits beside -- but it has nothing to resize. */
	.zg-pane-splitter[data-zg-collapsed] {
		pointer-events: none;
	}
	.zg-pane {
		/* The chevron is positioned against THIS box: see .zg-pane-toggle. */
		position: relative;
		min-width: ${MIN_WIDTH}px;
		background: var(--material-sidepane);
		/* Nothing inside the panel gets a say in how wide it is. */
		contain: inline-size;
		flex-grow: 0;
		flex-shrink: 1;
	}
	/*
	 * Hidden is a panel of zero width, not a panel that is display:none, because
	 * the chevron lives inside the panel and has to outlive its hiding. What is
	 * IN the panel goes; the panel itself stays as the thing the button hangs
	 * off, and slides to the edge of the window as it shrinks to nothing.
	 */
	.zg-pane[data-zg-collapsed] {
		width: 0;
		min-width: 0;
	}
	.zg-pane[data-zg-collapsed] > *:not(.zg-pane-toggle) {
		display: none;
	}
	/*
	 * Hung off the panel's outer edge: absolutely positioned against the panel
	 * itself, one button-width to the left of it, so it covers the divider and a
	 * little of the graph. Being absolute it takes no space, so the panel is
	 * exactly as wide as the panel; being anchored to the panel it needs no
	 * arithmetic -- a drag, a window resize and a collapse all move it because
	 * they move the edge it is nailed to.
	 *
	 * Inside the panel rather than beside the divider, and never inside the
	 * divider: a XUL <splitter> is a LEAF frame in current Gecko and lays out no
	 * children at all, which is why core's own <grippy> elements inside splitters
	 * render nothing.
	 */
	.zg-pane-toggle {
		position: absolute;
		top: 50%;
		left: -${TOGGLE_WIDTH}px;
		transform: translateY(-50%);
		z-index: 2;
		appearance: none;
		width: ${TOGGLE_WIDTH}px;
		height: 56px;
		padding: 0;
		border: 1px solid var(--material-panedivider);
		border-radius: 5px 0 0 5px;
		background: var(--material-sidepane);
		color: var(--fill-secondary);
		font-size: 12px;
		line-height: 1;
	}
	.zg-pane-toggle:hover {
		background: var(--fill-quinary);
		color: var(--fill-primary);
	}
`;

/**
 * Take the panel for `kind`, building it if this is the first time, showing it
 * if it was hidden and emptying it if something else had it.
 *
 * @param {Object}   entry     the graphTab record for this tab
 * @param {String}   kind      'reader' | 'item'
 * @param {Function} teardown  called when this occupant loses the panel
 * @param {Boolean}  [show]    whether this request should un-hide the panel
 * @returns {Element} the box to build into -- empty, unless it was already ours
 */
function claim(entry, kind, teardown, { show = true } = {}) {
	let pane = entry.pane || create(entry);
	if (show) expand(pane);
	if (pane.kind !== kind) {
		release(pane);
		pane.kind = kind;
	}
	pane.teardown = teardown;
	return pane.box;
}

/** Whether `kind` is what the panel is currently holding. */
function has(entry, kind) {
	return !!(entry && entry.pane && entry.pane.kind === kind);
}

/** Whether the chevron has put the panel away. */
function collapsed(entry) {
	return !!(entry && entry.pane && entry.pane.collapsed);
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
 *
 * Emptied of the OCCUPANT, that is. The chevron is a child of the box too, and
 * it belongs to the panel rather than to whoever is in it.
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
	for (let child of Array.from(pane.box.children)) {
		if (child !== pane.toggle) child.remove();
	}
}

// --- showing and hiding ------------------------------------------------

/**
 * Hidden, not emptied. The occupant stays exactly as it was -- a reader on its
 * page, an item pane on its scroll position -- because the chevron is a way of
 * looking at the graph for a moment, not of throwing away what you were
 * reading.
 */
function collapse(pane) {
	if (pane.collapsed) return;
	saveWidth(pane);
	pane.collapsed = true;
	// Both widths have to go, or they outrank `width: 0`: an inline style always
	// does, and a XUL width ATTRIBUTE maps to a presentational hint whose
	// standing against an author rule is not worth betting a collapse on. The
	// number is kept here instead, and it is what the panel comes back at.
	pane.width = Number(pane.box.getAttribute('width')) || pane.width;
	pane.box.style.width = '';
	pane.box.removeAttribute('width');
	pane.box.setAttribute('data-zg-collapsed', 'true');
	// The divider itself stays: it is what the way back sits beside. It just has
	// nothing left to drag.
	pane.splitter.setAttribute('data-zg-collapsed', 'true');
	syncToggle(pane);
}

function expand(pane) {
	if (!pane.collapsed) return;
	pane.collapsed = false;
	pane.box.removeAttribute('data-zg-collapsed');
	pane.splitter.removeAttribute('data-zg-collapsed');
	setWidth(pane, pane.width >= MIN_WIDTH ? Math.round(pane.width) : storedWidth());
	syncToggle(pane);
}

function syncToggle(pane) {
	// Pointing the way the panel would go: right to push it off the edge, left
	// to pull it back out.
	pane.toggle.textContent = pane.collapsed ? '«' : '»';
	pane.toggle.title = l10n.t(pane.collapsed ? 'pane-show' : 'pane-hide');
}

// --- the panel ---------------------------------------------------------

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

	// The chevron hangs off the panel's outer edge, and is a child of the panel
	// so that it moves with that edge without anyone having to work out where
	// the edge went. Absolute, so it costs the layout nothing.
	let toggle = doc.createElement('button');
	toggle.className = 'zg-pane-toggle';

	entry.split.appendChild(style);
	entry.split.appendChild(splitter);
	entry.split.appendChild(box);
	box.appendChild(toggle);

	let pane = {
		box, splitter, toggle, style,
		kind: null,
		teardown: null,
		observer: null,
		collapsed: false,
		// Only ever read while collapsed, when the box carries no width of its own.
		width: 0,
	};
	setWidth(pane, storedWidth());
	syncToggle(pane);
	toggle.addEventListener('click', () => {
		if (pane.collapsed) expand(pane);
		else collapse(pane);
	});

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
	// A collapse is not a resize: the panel is at zero on purpose, and the
	// attribute is only being kept for when it comes back.
	if (pane.collapsed) return;
	let w = Number(pane.box.getAttribute('width'));
	if (!Number.isFinite(w) || w <= 0) return;
	pane.box.style.width = w + 'px';
}

function storedWidth() {
	// paneWidth is the one panel's width. readerPaneWidth is what the reader
	// pane remembered before there was anything else to share with, and is read
	// here so an existing profile opens at the size its owner last chose.
	let w = Number(pref('paneWidth') || pref('readerPaneWidth'));
	return Number.isFinite(w) && w >= MIN_WIDTH ? Math.round(w) : DEFAULT_WIDTH;
}

/** A collapsed box measures zero, so a collapse can never record itself. */
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

module.exports = { claim, has, collapsed, close, MIN_WIDTH };
