/* global Zotero, ChromeUtils */

'use strict';

/**
 * The panel beside the graph: how wide it is, and whether it is showing at all.
 *
 * There is one thing in it -- Zotero's own item pane (itemPane.js) -- and this
 * module owns the panel around it: the splitter, the remembered width, and the
 * bridge to the collapse the pane's own sidenav button drives.
 *
 * Collapsing is not implemented here. It is core's, from the module core's own
 * <item-pane> uses:
 *
 *     chrome://zotero/content/elements/utils/collapsiblePane.mjs
 *
 * isPaneCollapsed()/setPaneCollapsed() take the element sitting immediately
 * after a <splitter> and write the whole collapsed state across both: the
 * `collapsed` attribute on the pane, `state` and `substate` on the splitter, and
 * a resize event on the window. That is exactly the shape this panel already has
 * -- [splitter][box] inside the tab's hbox -- so the helpers apply to it
 * unchanged, and the attributes they write are the ones core's stylesheet is
 * written against.
 *
 * Which matters more than it sounds, because the two hairlines either side of a
 * collapsed pane have to be ONE line, and it is the splitter that gives way:
 *
 *   expanded   the sidenav's border-inline-start sits between the pane content
 *              and the sidenav, nowhere near the splitter, and the splitter
 *              draws the pane's outer edge with border-right plus negative
 *              margins that cost the layout nothing.
 *   collapsed  the content is visibility: collapse, so the sidenav's own border
 *              IS the pane's outer edge -- and a splitter still drawing its own
 *              line there would double it. Core's [state=collapsed] rules move
 *              the splitter's line to border-left, drop the negative margins and
 *              widen --draggable-size, so the one line at the pane's edge is the
 *              sidenav's.
 *
 * Deciding that state by hand was the bug: a doubled, darker edge the library
 * does not have. Nothing here decides it any more.
 *
 * Sizing is what is left, and the reason this module exists rather than a few
 * lines inside itemPane.js.
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

/**
 * Core's collapse, loaded on first use.
 *
 * Not at module scope: this file is also loaded by `npm test`, outside Zotero,
 * where there is no ChromeUtils and no chrome:// to resolve.
 */
let _collapsible = null;
function collapsible() {
	if (!_collapsible) {
		_collapsible = ChromeUtils.importESModule(
			'chrome://zotero/content/elements/utils/collapsiblePane.mjs');
	}
	return _collapsible;
}

const PANE_CSS = `
	/*
	 * Expanded, the splitter is core's entirely: it draws the panel's outer edge
	 * and costs the layout nothing, because the attributes core's rules are
	 * keyed on are on the element (see create()).
	 *
	 * Collapsed, it draws nothing, and this is the one rule in this plugin that
	 * departs from core on purpose.
	 *
	 * Only ONE hairline belongs at the edge of a collapsed pane, and there are
	 * two candidates for it: the splitter's own border, and the sidenav's
	 * border-inline-start -- which is normally buried between the pane content
	 * and the sidenav, but becomes the panel's outer edge the moment that
	 * content goes visibility: collapse. Core resolves it by moving the
	 * splitter's line to border-left and dropping the negative margins, which
	 * parks the line at the far side of 8-10px of splitter. It can afford that
	 * width because core's markup carries collapse="after", so the collapsed
	 * splitter is the grab handle that pulls the pane back out.
	 *
	 * This one is not a handle -- the sidenav's button is the way back, and
	 * collapse="after" is deliberately not set (see create()) -- so core's
	 * treatment would leave a strip of nothing beside the icons. Both artefacts
	 * have shipped: the doubled, darker edge from letting both lines land
	 * together, and the strip from taking core's answer to it.
	 *
	 * So: the sidenav draws the edge, and the splitter gets out of the way
	 * entirely. The margins keep it at zero layout width the same way core's own
	 * rule does, off the same variable, so the density bump on --draggable-size
	 * cancels itself. The line you see is the sidenav's border-inline-start --
	 * which is the same line, from the same element, that the library shows
	 * beside ITS collapsed item pane.
	 */
	.zg-pane-splitter[state="collapsed"] {
		border: 0;
		margin-left: calc(1px - var(--draggable-size));
		margin-right: -1px;
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
	 * Core's own rule for a collapsed item pane, against the attribute core's
	 * helper writes. From zotero.css, unchanged but for the selector:
	 *
	 *   item-pane[collapsed=true] {
	 *     min-width: 37px; min-height: 37px; max-width: 37px; visibility: inherit;
	 *   }
	 *
	 * 37px is the sidenav, which is the whole of the panel once it is collapsed.
	 * The visibility is load-bearing and is core's: XUL's UA sheet gives
	 * [collapsed="true"] a visibility of collapse, which would take the sidenav
	 * down with everything else and leave no way back.
	 */
	.zg-pane[collapsed="true"] {
		min-width: 37px;
		min-height: 37px;
		max-width: 37px;
		visibility: inherit;
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
	if (!entry || !entry.pane) return false;
	try {
		return collapsible().isPaneCollapsed(entry.pane.box);
	}
	catch (e) {
		Zotero.logError(e);
		return false;
	}
}

/**
 * Collapse or expand, which is what the sidenav's first button asks for.
 *
 * Collapsed, not emptied: the item pane stays exactly as it was, on its scroll
 * position, because this is a way of looking at the whole graph for a moment
 * and not a way of throwing away what you were reading.
 *
 * The collapse itself is core's. What is left here is the width either side of
 * it -- core's <item-pane> restores its own from handleResize() and a
 * zotero-persist attribute, neither of which a plain box has.
 */
function setCollapsed(entry, val) {
	let pane = entry && entry.pane;
	if (!pane) return;
	val = !!val;
	if (collapsed(entry) === val) return;

	if (val) {
		saveWidth(pane);
		// Read before core removes it, and kept for the way back.
		pane.width = Number(pane.box.getAttribute('width')) || pane.width;
	}

	try {
		collapsible().setPaneCollapsed(pane.box, val);
	}
	catch (e) {
		Zotero.logError(e);
		return;
	}

	// setPaneCollapsed clears the `width` ATTRIBUTE; the inline width mirrored
	// from it is ours, and would outrank the max-width core's rule collapses to.
	if (val) pane.box.style.width = '';
	else setWidth(pane, pane.width >= MIN_WIDTH ? Math.round(pane.width) : storedWidth());
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
	// The attribute core's divider rules are keyed on, for the state the panel
	// starts in. Without one of [collapse] or [substate] the only rule that
	// matches a <splitter> is
	//
	//     splitter:not([orient=vertical]) { min-width: var(--draggable-size) }
	//
	// which is 5-8px of TRANSPARENT, REAL layout width and no line anywhere --
	// a strip of window between the graph and the panel, and no divider drawn.
	// With it, core's own rule applies: border-right, plus negative margins that
	// let the divider keep its grab width by overlapping its neighbours instead
	// of taking space from them.
	//
	// Core's markup writes collapse="after" here and gets the identical rule.
	// This is substate, which collapsiblePane.mjs also writes, because
	// `collapse` is the attribute nsSplitterFrame keys its OWN drag-to-the-edge
	// collapse off: it would write collapsed="true" onto the panel directly,
	// which is a second collapse behind the back of the one the sidenav's toggle
	// drives. From here on the attribute is core's helper's to maintain.
	splitter.setAttribute('substate', 'after');

	let box = doc.createXULElement('vbox');
	box.className = 'zg-pane';

	entry.split.appendChild(style);
	entry.split.appendChild(splitter);
	entry.split.appendChild(box);

	let pane = {
		box, splitter, style,
		observer: null,
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
	if (pane.box.getAttribute('collapsed') === 'true') return;
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
