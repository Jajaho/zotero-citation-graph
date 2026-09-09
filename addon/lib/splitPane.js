/* global Zotero */

'use strict';

/**
 * The panel beside the graph: how wide it is, and whether it is showing at all.
 *
 * There is one thing in it -- Zotero's own item pane (itemPane.js) -- and this
 * module owns everything around that: the splitter, the remembered width, and
 * the collapsed state the pane's own sidenav button drives.
 *
 * Collapsing is core's shape, not one of ours. An <item-pane> collapsed in the
 * library keeps its 37px sidenav on screen and hides only the content beside it
 * (`item-pane[collapsed=true] { max-width: 37px }`, plus `visibility: collapse`
 * on the pane content), so the strip of icons is both the way back and the
 * reminder that there is something to come back to. The panel here does the
 * same, and for the same reason: the button that collapses it lives in that
 * strip, so the strip has to outlive the collapse.
 *
 * Sizing is the part that needs care, and the reason this module exists rather
 * than a few lines inside itemPane.js.
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
 */

// An item pane's own 320px minimum plus its 37px sidenav -- what core gives the
// library's item pane, and this is the same pane.
const MIN_WIDTH = 357;
const DEFAULT_WIDTH = 520;

// The sidenav's width, which is the whole of the panel once it is collapsed.
// Core's number, in core's stylesheet; repeated here because the panel is ours
// and nothing else would size it.
const SIDENAV_WIDTH = 37;

const PANE_CSS = `
	/*
	 * No styling of its own. Core already gives every <splitter> its line and its
	 * grab width -- --draggable-size, a border-left of
	 * var(--material-border-quarternary), and the negative margins that let that
	 * line sit between its neighbours -- and matching Zotero's other dividers is
	 * the whole point. What was here before did nothing anyway: both
	 * --material-panedivider and --material-border-quarternary are border
	 * SHORTHANDS, not colours, so a background of var(--material-panedivider)
	 * resolved to "1px solid #dadada" and was dropped as invalid.
	 *
	 * The divider stays put when the pane is collapsed -- it is what the strip of
	 * icons sits beside -- but it has nothing left to resize.
	 */
	.zg-pane-splitter[data-zg-collapsed] {
		pointer-events: none;
	}
	.zg-pane {
		min-width: ${MIN_WIDTH}px;
		background: var(--material-sidepane);
		/* Nothing inside the panel gets a say in how wide it is. */
		contain: inline-size;
		flex-grow: 0;
		flex-shrink: 1;
	}
	/*
	 * Collapsed is the sidenav and nothing else, which is exactly what
	 * item-pane[collapsed=true] is in the library. The content beside it goes by
	 * visibility rather than display, because that is the rule core uses and
	 * because a flex item at visibility: collapse is laid out as though it were
	 * not there -- so its own 320px minimum cannot argue with the 37px above it.
	 */
	.zg-pane[data-zg-collapsed] {
		width: ${SIDENAV_WIDTH}px;
		min-width: ${SIDENAV_WIDTH}px;
		max-width: ${SIDENAV_WIDTH}px;
	}
`;

/**
 * The panel for this tab, built on the first ask.
 *
 * @param {Object} entry  the graphTab record for this tab
 * @returns {Element} the box to build into
 */
function panel(entry) {
	let pane = entry.pane || create(entry);
	return pane.box;
}

/** Whether the pane's own toggle has put the panel away. */
function collapsed(entry) {
	return !!(entry && entry.pane && entry.pane.collapsed);
}

/**
 * Collapse or expand, which is what the sidenav's first button asks for.
 *
 * Collapsed, not emptied: the item pane stays exactly as it was, on its scroll
 * position, because this is a way of looking at the whole graph for a moment
 * and not a way of throwing away what you were reading.
 */
function setCollapsed(entry, val) {
	let pane = entry && entry.pane;
	if (!pane || pane.collapsed === !!val) return;
	if (val) collapse(pane);
	else expand(pane);
}

/** Close the panel altogether: the width is remembered, the elements go. */
function close(entry) {
	let pane = entry && entry.pane;
	if (!pane) return;
	saveWidth(pane);
	entry.pane = null;
	if (pane.observer) pane.observer.disconnect();
	pane.splitter.remove();
	pane.box.remove();
	pane.style.remove();
}

// --- showing and hiding ------------------------------------------------

function collapse(pane) {
	saveWidth(pane);
	pane.collapsed = true;
	// Both widths have to go, or they outrank the collapsed rule: an inline
	// style always does, and a XUL width ATTRIBUTE maps to a presentational hint
	// whose standing against an author rule is not worth betting a collapse on.
	// The number is kept here instead, and it is what the panel comes back at.
	pane.width = Number(pane.box.getAttribute('width')) || pane.width;
	pane.box.style.width = '';
	pane.box.removeAttribute('width');
	pane.box.setAttribute('data-zg-collapsed', 'true');
	// The divider itself stays: it is what the strip of icons sits beside. It
	// just has nothing left to drag.
	pane.splitter.setAttribute('data-zg-collapsed', 'true');
}

function expand(pane) {
	pane.collapsed = false;
	pane.box.removeAttribute('data-zg-collapsed');
	pane.splitter.removeAttribute('data-zg-collapsed');
	setWidth(pane, pane.width >= MIN_WIDTH ? Math.round(pane.width) : storedWidth());
}

// --- the panel ---------------------------------------------------------

function create(entry) {
	let doc = entry.win.document;

	// Beside the box rather than inside it, so anything that empties the box
	// does not take the panel's own styling with it.
	let style = doc.createElement('style');
	style.textContent = PANE_CSS;

	// The same shape as core's zotero-items-splitter (zoteroPane.xhtml).
	let splitter = doc.createXULElement('splitter');
	splitter.className = 'zg-pane-splitter';
	splitter.setAttribute('resizebefore', 'closest');
	splitter.setAttribute('resizeafter', 'closest');

	let box = doc.createXULElement('vbox');
	box.className = 'zg-pane';

	entry.split.appendChild(style);
	entry.split.appendChild(splitter);
	entry.split.appendChild(box);

	let pane = {
		box, splitter, style,
		observer: null,
		collapsed: false,
		// Only ever read while collapsed, when the box carries no width of its own.
		width: 0,
	};
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
	// A collapse is not a resize: the panel is at the sidenav's width on
	// purpose, and the attribute is only being kept for when it comes back.
	if (pane.collapsed) return;
	let w = Number(pane.box.getAttribute('width'));
	if (!Number.isFinite(w) || w <= 0) return;
	pane.box.style.width = w + 'px';
}

function storedWidth() {
	// paneWidth is the panel's width. readerPaneWidth is what an older version
	// of this plugin remembered for the pane it put here, and is read so an
	// existing profile opens at the size its owner last chose.
	let w = Number(pref('paneWidth') || pref('readerPaneWidth'));
	return Number.isFinite(w) && w >= MIN_WIDTH ? Math.round(w) : DEFAULT_WIDTH;
}

/** A collapsed box measures 37px, so a collapse can never record itself. */
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

module.exports = { panel, collapsed, setCollapsed, close, MIN_WIDTH };
