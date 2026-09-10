/* global Zotero */

'use strict';

/**
 * What the collection keeps citing and does not hold, as a list in the pane
 * beside the graph.
 *
 * The graph already draws these, as ghosts sized by how many of your papers
 * cite them. What the canvas cannot do is answer the question in one look: the
 * interesting ones sit somewhere in a cloud of several thousand, and filtering
 * the cloud down far enough to read leaves you reading a graph where a list is
 * what the question wants.
 *
 * WHY THIS IS CHROME AND THE RANKING IS NOT. Ranking reads the believed edges,
 * the external works, the cluster partition and the lookup checkbox -- four
 * things that live in the content page and nowhere else -- so it stays there,
 * in content/graphGaps.js, pure and unit-tested. Drawing needs a page of the
 * `<deck>` the item pane sits in, which is a XUL element in the main window and
 * out of the content page's reach entirely. So the page ranks and pushes rows;
 * this draws them and pushes the clicks back.
 *
 * It is a third page of that deck rather than a panel of its own, and that buys
 * the behaviour the list wants for nothing: face() greys the sidenav's icons
 * whenever the deck is showing something that is not an item, which is exactly
 * right here -- the section buttons mean nothing beside a list of works the
 * library does not have, and a strip of live icons over them would be offering
 * to scroll to an Abstract section that is not on screen.
 *
 * The `+` is not this module's to answer: the row emits `add-item` over the
 * same bridge the ghost's own context menu uses, and graphTab.js answers it.
 * One path to Zotero's add-by-identifier, from all three places that offer it.
 */

let l10n = require('./l10n.js');
let itemPane = require('./itemPane.js');
let splitPane = require('./splitPane.js');

/**
 * Rows worth reading before the tail is the tail. The page caps its own list at
 * the same number; this is here so that a payload from a future build cannot
 * make the pane draw a thousand rows.
 */
const MAX_ROWS = 25;

const GAPS_CSS = `
	.zg-gaps {
		flex: 1;
		min-height: 0;
		min-width: 0;
		background: var(--material-background);
	}
	.zg-gaps-head {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 8px;
		border-bottom: var(--material-panedivider);
	}
	.zg-gaps-title {
		flex: 1;
		min-width: 0;
		font-weight: 600;
		color: var(--fill-primary);
	}
	/* Outside the scroller, so it is still there at the bottom of a list of
	   twenty-five. */
	.zg-gaps-caption {
		flex: 0 0 auto;
		padding: 6px 10px 0;
		color: var(--fill-secondary);
	}
	.zg-gaps-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px;
	}
	.zg-gap-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 4px 6px;
		border-radius: 5px;
		/* The row answers a double click, and the default answer to one over
		   text is to select a word of it -- so a reader isolating a gap would
		   be left with half its title highlighted. */
		user-select: none;
	}
	.zg-gap-row:hover {
		background: var(--fill-quinary);
	}
	/* Which rows are in the pick. Not the pane's own answer: the page holds the
	   selection and works out which stars are wholly in it -- see marks(). The
	   bar is what carries it, because the fill alone is a shade off the hover
	   and a reader moving down the list would be told nothing. */
	.zg-gap-row.lit {
		background: var(--fill-quarternary);
		box-shadow: inset 2px 0 0 var(--accent-blue, #4072e5);
	}
	/* The local count is the number the ranking is about, so it leads the row
	   and is the one thing in it set at the pane's full-strength colour. */
	.zg-gap-count {
		flex: 0 0 auto;
		min-width: 1.5em;
		text-align: right;
		font-weight: 600;
		color: var(--fill-primary);
	}
	.zg-gap-main {
		flex: 1;
		min-width: 0;
	}
	.zg-gap-name {
		color: var(--fill-primary);
	}
	/* Offline a ghost is a DOI and nothing else, and a bare identifier should
	   look like one rather than sit where a title would. */
	.zg-gap-name.bare {
		font-family: monospace;
		color: var(--fill-secondary);
	}
	.zg-gap-sub {
		color: var(--fill-secondary);
	}
	.zg-gaps-foot,
	.zg-gaps-empty {
		padding: 6px 10px;
		color: var(--fill-secondary);
	}
`;

/**
 * The list's page of the deck, built on the first ask.
 *
 * Not alongside the rest of the pane, for the same reason the note editor is
 * not: most graphs are read without this list ever being opened, and building
 * it up front costs every tab a stylesheet and a box nobody looks at.
 */
function ensure(entry) {
	let pane = itemPane.pane(entry);
	if (!pane) return null;
	if (pane.gaps) return pane.gaps;

	let doc = entry.win.document;

	let box = doc.createXULElement('vbox');
	box.className = 'zg-gaps';
	box.setAttribute('flex', '1');

	let head = doc.createXULElement('hbox');
	head.className = 'zg-gaps-head';
	head.setAttribute('align', 'center');

	let title = doc.createElement('div');
	title.className = 'zg-gaps-title';
	title.textContent = l10n.t('gaps-title');

	let close = doc.createXULElement('toolbarbutton');
	close.className = 'zg-gaps-close';
	close.setAttribute('tooltiptext', l10n.t('gaps-close'));
	// Closing means going back to the paper, which is the only other thing this
	// deck can be showing -- so the button is the canvas menu's second state by
	// another route, and both end in face().
	close.addEventListener('command', () => close_(entry));

	head.appendChild(title);
	head.appendChild(close);

	// What the number at the head of every row counts. It is the whole ranking
	// and it had nothing but a tooltip saying so, which is a thing nobody hovers
	// over a column of figures to find: the first reading of "12" against a work
	// you do not hold is "I cited this twelve times", which is not a fact this
	// list has, and it makes a list of gaps read as a list of your own citations.
	let caption = doc.createElement('div');
	caption.className = 'zg-gaps-caption';
	caption.textContent = l10n.t('gaps-caption');

	let body = doc.createElement('div');
	body.className = 'zg-gaps-body';

	let foot = doc.createElement('div');
	foot.className = 'zg-gaps-foot';
	foot.hidden = true;

	box.appendChild(head);
	box.appendChild(caption);
	box.appendChild(body);
	box.appendChild(foot);

	let style = doc.createElement('style');
	style.textContent = GAPS_CSS;
	box.appendChild(style);

	// Into the deck, where it is the third page and the one nothing is looking
	// at until face() says so. Appending re-runs the deck's own childList
	// observer, which keeps the current page selected.
	pane.deck.appendChild(box);
	// `drawn` is the rows on screen by gap key, and `lit` the ones the page says
	// are in the pick. Both are the pane's, because a redraw rebuilds every row
	// and the marks have to land again on whatever came back.
	pane.gaps = { box: box, body: body, foot: foot, drawn: new Map(), lit: new Set() };
	return pane.gaps;
}

/**
 * Show the list.
 *
 * Expanding a collapsed pane is not optional here, unlike a click on a node:
 * opening this list is an explicit request to read it, and a list drawn into
 * the 37px of sidenav a collapsed pane leaves is a list nobody sees. Same call
 * itemPane.show() makes for its own `expand`.
 */
function open(entry, tell) {
	let gaps;
	try {
		gaps = ensure(entry);
	}
	catch (e) {
		// A pane that cannot show this list is still a pane that shows papers.
		Zotero.logError(e);
		return;
	}
	if (!gaps) return;

	// Which page of the deck is up is CHROME's fact, not the page's, and this is
	// what says so. The graph's canvas menu reads it -- "what is missing" or
	// "hide the list" -- and there are two ways down from here, the close button
	// and that menu entry, so a page that remembered its own answer would be
	// wrong whenever the other one was used.
	entry.itemPane.onFace = wanted => tell(wanted === gaps.box);

	// Pinned, so that a selection cannot take the deck out from under it. Every
	// gesture made while reading this list moves the selection -- a row picks
	// its ghost, the same ghost clicked on the canvas picks it from the other
	// end, empty canvas clears the pick, a rebuild restates the count -- and
	// each of those would otherwise close the list. See itemPane.face().
	entry.itemPane.pinned = gaps.box;

	if (splitPane.collapsed(entry)) splitPane.setCollapsed(entry, false);
	itemPane.face(entry.itemPane, gaps.box);
}

function close_(entry) {
	if (!entry || !entry.itemPane || !entry.itemPane.gaps) return;
	let pane = entry.itemPane;
	// Closing is what the pin was holding out for, so this is the one caller
	// that lifts it -- and what comes up is the page the renders underneath
	// drew and could not show, which is whatever the selection last became
	// while the list was up.
	pane.pinned = null;
	itemPane.face(pane, pane.behind || pane.details);
}

/** Whether the list is the page currently showing. */
function showing(entry) {
	let pane = entry && entry.itemPane;
	return !!(pane && pane.gaps && pane.facing === pane.gaps.box);
}

/**
 * Draw a payload.
 *
 * Dropped when the list is not the page on screen, which is the same deal the
 * item pane already has: the side holding the pane is the side that knows
 * whether anything needs drawing. The page pushes on every render, because
 * every input to the ranking is something a render can have changed.
 */
function rows(entry, msg, send) {
	if (!showing(entry)) return;
	let gaps = entry.itemPane.gaps;
	let doc = entry.win.document;

	gaps.body.textContent = '';
	gaps.drawn.clear();
	gaps.foot.textContent = '';
	gaps.foot.hidden = true;

	let list = Array.isArray(msg.rows) ? msg.rows.slice(0, MAX_ROWS) : [];
	if (!list.length) {
		let note = doc.createElement('div');
		note.className = 'zg-gaps-empty';
		// A build still running has not read most of the PDFs yet, and
		// "nothing is missing" would be a lie until it has.
		note.textContent = l10n.t(msg.building ? 'gaps-building' : 'gaps-empty');
		gaps.body.appendChild(note);
		return;
	}

	for (let g of list) {
		let el = row(entry, g, send);
		gaps.drawn.set(g.key, el);
		gaps.body.appendChild(el);
	}
	// The marks the pane was already wearing, put back on the rows that came
	// back. The page pushes a fresh set straight after this one -- it works them
	// out from the same pick -- but a redraw that dropped every mark for a frame
	// would flicker the list under a reader's hand.
	paint(gaps);

	let foot = [];
	if (msg.total > list.length) {
		foot.push(l10n.t('gaps-more', { count: msg.total - list.length }));
	}
	// Without the counts every gap is ranked at face value, which is the plain
	// "most cited here" order. Worth saying, since the ranking is the reason to
	// read this list rather than the graph.
	if (!msg.lookup) foot.push(l10n.t('gaps-lookup-hint'));
	for (let line of foot) {
		let div = doc.createElement('div');
		div.textContent = line;
		gaps.foot.appendChild(div);
	}
	gaps.foot.hidden = !foot.length;
}

function row(entry, g, send) {
	let doc = entry.win.document;

	let el = doc.createElement('div');
	el.className = 'zg-gap-row';
	el.setAttribute('role', 'button');
	el.tabIndex = 0;
	el.title = l10n.t('gaps-row-hint', { count: g.citedBy });

	let count = doc.createElement('span');
	count.className = 'zg-gap-count';
	count.textContent = g.citedBy;

	let main = doc.createElement('div');
	main.className = 'zg-gap-main';
	let name = doc.createElement('div');
	name.className = g.title ? 'zg-gap-name' : 'zg-gap-name bare';
	name.textContent = g.title || g.id;
	let sub = doc.createElement('div');
	sub.className = 'zg-gap-sub';
	sub.textContent = subtitle(g);
	main.appendChild(name);
	if (sub.textContent) main.appendChild(sub);

	let add = doc.createXULElement('toolbarbutton');
	add.className = 'zg-gap-add';
	add.setAttribute('label', '+');
	// Only a DOI can be added: that is what Zotero's add-by-identifier takes,
	// and it is the same gate the ghost's own context menu applies.
	add.disabled = g.ns !== 'doi';
	add.setAttribute('tooltiptext', l10n.t(add.disabled ? 'gaps-add-no-doi' : 'gaps-add'));
	// The `+` is its own gesture. Its `command` handler stops that event, but a
	// command rides on a click, and the click goes on bubbling to the row -- so
	// reaching for the button would light the star, and reaching for it twice
	// would isolate it. Both are stopped here, at the button.
	for (let type of ['click', 'dblclick']) {
		add.addEventListener(type, e => e.stopPropagation());
	}
	add.addEventListener('command', (e) => {
		// The row underneath means "show me who cites this", which is not what
		// someone reaching for the button asked for.
		e.stopPropagation();
		add.disabled = true;
		add.setAttribute('label', '…');
		// Chrome answers by rebuilding, after which this work is held and drops
		// off the list by itself. When nothing was added -- the dialog was
		// cancelled, the DOI resolved to nothing -- the page is told instead,
		// and the redraw brings this row back enabled.
		send({ type: 'add-item', doi: g.id, title: g.title || null });
	});

	// The canvas's own four gestures, over the one node this row stands for:
	// the ghost for the work the library does not hold. Click lights it, double
	// click isolates it -- which is what lights the papers citing it, at the
	// depth the reader set -- and Ctrl (Cmd on a Mac) on either adds to what is
	// already picked or already lit rather than starting again. What each one
	// MEANS is content/graph.js zgGapsFocus, which answers them with the same
	// four functions the canvas calls; this end only says which was made, and
	// which row made it.
	//
	// The pair of clicks under a double click lights the ghost and puts it out
	// again, exactly as the pair under a double click on the ghost itself does,
	// and the gesture that follows sets it right -- see toggleIsolate() there.
	let focus = (ev, isolate) => send({
		type: 'gaps-focus',
		key: g.key,
		isolate: isolate,
		add: !!(ev && (ev.ctrlKey || ev.metaKey)),
	});
	el.addEventListener('click', ev => focus(ev, false));
	el.addEventListener('dblclick', ev => focus(ev, true));
	el.addEventListener('keydown', (ev) => {
		if (ev.key !== 'Enter' && ev.key !== ' ') return;
		ev.preventDefault();
		focus(ev, false);
	});

	el.appendChild(count);
	el.appendChild(main);
	el.appendChild(add);
	return el;
}

/**
 * Which rows are lit, from the page.
 *
 * The pick is the page's and so is this: a row is lit when the star it stands
 * for is wholly in the selection, and only the page knows both the selection
 * and which of a row's nodes are on screen to be in it. Working it out over
 * here from the clicks this pane sent would be a second model of the pick, and
 * a second model is a thing that comes to disagree -- a filter that takes a
 * citer off screen changes the answer without a click being made at all.
 */
function marks(entry, msg) {
	if (!showing(entry)) return;
	let gaps = entry.itemPane.gaps;
	let next = new Set(Array.isArray(msg.keys) ? msg.keys : []);
	// A ghost picked on the CANVAS marks its row over here, and twenty-five
	// rows are taller than the pane -- so a mark that has just appeared is
	// scrolled to, or the answer would be off the bottom of a list the reader
	// is looking straight at. Only a newly marked row, and only the first of
	// them: a gesture that lights several has no one row to go to.
	let fresh = null;
	for (let key of next) {
		if (!gaps.lit.has(key)) {
			fresh = gaps.drawn.get(key);
			break;
		}
	}
	gaps.lit = next;
	paint(gaps);
	// `nearest`, so a row already on screen is not scrolled to the middle of
	// the pane for no reason.
	if (fresh) fresh.scrollIntoView({ block: 'nearest' });
}

function paint(gaps) {
	for (let [key, el] of gaps.drawn) el.classList.toggle('lit', gaps.lit.has(key));
}

/** Authors, fame and which subfield is doing the citing -- the three things
 *  that decide whether a gap is worth filling, on one line. */
function subtitle(g) {
	let bits = [];
	if (g.creators && g.creators.length) bits.push(creatorList(g.creators));
	if (g.year) bits.push(g.year);
	if (g.citedByGlobal != null) {
		bits.push(l10n.t('tooltip-citations-total', { count: g.citedByGlobal.toLocaleString() }));
	}
	// One subfield leaning on it is a hole in that subfield and can be named as
	// one; several leaning on it is common ground, which is a different kind of
	// missing and is said differently.
	if (g.subfields && g.subfields.top) bits.push(g.subfields.top);
	else if (g.subfields && g.subfields.spread > 1) {
		bits.push(l10n.t('gaps-mixed', { count: g.subfields.spread }));
	}
	return bits.join(' · ');
}

/** Two names and an "et al.", which is as much as a one-line row can carry. */
function creatorList(creators) {
	let names = creators.slice(0, 2).map(c => c.lastName || c.name || '').filter(Boolean);
	if (!names.length) return '';
	return creators.length > 2 ? names.join(', ') + ' et al.' : names.join(', ');
}

module.exports = {
	open: open,
	close: close_,
	rows: rows,
	marks: marks,
	showing: showing,
};
