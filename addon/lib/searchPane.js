/**
 * Zotero's own two searches, for a graph tab: the Quick Search behind the
 * field in the page's bar, and an Advanced Search pane laid over the canvas.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The library's Advanced Search is <advanced-search-pane>
 * (elements/advancedSearchPane.js), and every one of its actions ends in
 * ZoteroPane: Search filters ZoteroPane.itemsView, and opening it selects the
 * library tab. Asked from here it would take the user away from the graph to
 * filter a list they were not looking at. So the pane here is built from the
 * part of it that has no such tie -- the <zoterosearch> condition editor,
 * with core's own Search and Clear buttons under it and advanced-search-pane's
 * rules copied onto the box -- and what it finds narrows the graph instead.
 *
 * The rest of core's behaviour is kept as zoteroPane.js has it: a fresh search
 * is "top-level items whose title contains", Ctrl+Shift+F opens the pane, then
 * focuses it, then closes it, Collapse keeps the filter and Close drops it,
 * and text in the field seeds the conditions one word at a time.
 *
 * The Quick Search is core's quicksearch-<mode> condition, which is what a
 * collection row adds for the text in its field (collectionTreeRow.js), asked
 * of the library and cut down to the items on the graph. The mode is core's
 * pref, so this field and the library's are one setting, as every
 * <quick-search-textbox> in Zotero is.
 */

'use strict';

const MODE_PREF = 'search.quicksearch-mode';

// Core's names for the three, from zotero.properties: the menu and the
// placeholder say what the library's field says, in the library's language.
const MODES = {
	titleCreatorYear: 'quickSearch.mode.titleCreatorYear',
	fields: 'quickSearch.mode.fieldsAndTags',
	everything: 'quickSearch.mode.everything',
};

const MENU_ID = 'zg-search-mode-popup';

// advanced-search-deck's and advanced-search-pane's rules from zotero.css, on
// a box of our own. Absolute, over the browser: the page keeps the canvas
// clear of it and says where it goes -- see place().
const PANE_CSS = [
	'.zg-split { position: relative; }',
	'.zg-adv { position: absolute; z-index: 3; box-sizing: border-box;',
	'  flex-direction: column; padding-block: 8px; padding-inline: 10px; gap: 8px;',
	'  background: var(--material-toolbar);',
	'  border-bottom: 1px solid var(--color-panedivider); }',
	'.zg-adv:-moz-window-inactive { opacity: .6; }',
	'.zg-adv[hidden] { display: none; }',
	'.zg-adv-buttons { gap: 8px; }',
	'.zg-adv-buttons button { min-width: 100px; margin: 0; }',
].join('\n');

function isMode(m) {
	return typeof m === 'string' && Object.prototype.hasOwnProperty.call(MODES, m);
}

/** Core's pref, read the way quickSearchTextbox.js reads it. */
function mode() {
	let m = Zotero.Prefs.get(MODE_PREF);
	return isMode(m) ? m : 'fields';
}

/** What the page's field shows: the mode, and core's name for it. */
function modeInfo() {
	let m = mode();
	return { mode: m, label: Zotero.getString(MODES[m]) };
}

/**
 * Matches as items on the graph. A search can answer with a note, an
 * attachment or an annotation -- All Fields & Tags reads notes, Everything
 * reads full text -- and the library shows each of those under its parent,
 * so the graph shows the parent: the paper is the node.
 *
 * Cut down to the graph's own items when chrome knows them, so a search that
 * matches half the library does not cross the bridge as half the library.
 */
function onGraph(entry, ids) {
	let held = entry.heldIDs || null;
	let out = new Set();
	for (let id of ids) {
		let item = Zotero.Items.get(id);
		while (item && item.parentItemID) item = Zotero.Items.get(item.parentItemID);
		if (item && (!held || held.has(item.id))) out.add(item.id);
	}
	return [...out];
}

async function quickSearch(entry, text) {
	let s = new Zotero.Search();
	s.libraryID = entry.collection.libraryID;
	s.addCondition('quicksearch-' + mode(), 'contains', text);
	return onGraph(entry, await s.search());
}

// --- the mode menu ---------------------------------------------------------

/**
 * Core's menupopup for the three modes, radio items and all, under the field.
 * msg.x/y are page coordinates, which is what openPopup's offsets from the
 * browser's own corner are.
 */
function openModeMenu(entry, msg, reply) {
	let doc = entry.win.document;
	removeMenu(entry.win);
	let popup = doc.createXULElement('menupopup');
	popup.id = MENU_ID;
	popup.toggleAttribute('needsgutter', true);
	let current = mode();
	for (let m of Object.keys(MODES)) {
		let item = doc.createXULElement('menuitem');
		item.setAttribute('type', 'radio');
		item.setAttribute('label', Zotero.getString(MODES[m]));
		if (m === current) item.setAttribute('checked', 'true');
		item.addEventListener('command', () => {
			Zotero.Prefs.set(MODE_PREF, m);
			reply('zgSetSearchMode', Object.assign(modeInfo(), { picked: true }));
		});
		popup.appendChild(item);
	}
	(doc.getElementById('mainPopupSet') || doc.documentElement).appendChild(popup);
	popup.openPopup(entry.browser, 'overlap', Number(msg.x) || 0, Number(msg.y) || 0);
}

/** Left in the document after it closes, because the command of the row that
 *  closed it may still be on its way; taken down by the next one, or by the
 *  tab going. */
function removeMenu(win) {
	let old = win.document.getElementById(MENU_ID);
	if (old) old.remove();
}

// --- the Advanced Search pane ------------------------------------------------

function pane(entry, reply) {
	if (entry.adv) {
		entry.adv.reply = reply;
		return entry.adv;
	}
	let win = entry.win;
	let doc = win.document;

	let style = doc.createElement('style');
	style.textContent = PANE_CSS;

	let box = doc.createXULElement('vbox');
	box.className = 'zg-adv';
	box.hidden = true;

	let editor = doc.createXULElement('zoterosearch');
	let buttons = doc.createXULElement('hbox');
	buttons.className = 'zg-adv-buttons';
	// Core's own buttons, by core's own string ids: the main window already
	// carries zotero.ftl, so they read as the library's do in every locale.
	let submit = doc.createXULElement('button');
	submit.setAttribute('data-l10n-id', 'search-button');
	submit.setAttribute('default', 'true');
	let clear = doc.createXULElement('button');
	clear.setAttribute('data-l10n-id', 'clear-button');
	buttons.append(submit, clear);
	box.append(editor, buttons);
	entry.split.append(style, box);

	let adv = { box, style, editor, reply, state: 'closed', active: false, search: null, observer: null };
	entry.adv = adv;
	placeBox(adv, entry.advRect);

	// What advanced-search-pane does with the same two events: the editor's
	// controls write into the search only when asked to.
	editor.addEventListener('input', () => editor.updateSearch());
	editor.addEventListener('command', () => editor.updateSearch());
	submit.addEventListener('command', () => run(entry).catch(e => Zotero.logError(e)));
	clear.addEventListener('command', () => reset(entry));
	box.addEventListener('keydown', event => onKey(entry, event).catch(e => Zotero.logError(e)));

	// The page keeps the canvas clear of the pane, so it is told its height
	// whenever that moves -- a condition added, a group opened, the pane shut.
	adv.observer = new win.ResizeObserver(() => {
		if (entry.adv !== adv) return;
		let h = adv.box.hidden ? 0 : Math.ceil(adv.box.getBoundingClientRect().height);
		adv.reply('zgSetAdvanced', { height: h });
	});
	adv.observer.observe(box);
	return adv;
}

/**
 * advanced-search-pane's own keys, and core's Ctrl+Shift+F -- which from
 * inside the pane closes it, and has to be kept from the main window's
 * keyset, which would open the library's.
 */
async function onKey(entry, event) {
	let adv = entry.adv;
	if (!adv) return;
	let accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
	if (accel && event.shiftKey && !event.altKey && (event.key === 'f' || event.key === 'F')) {
		event.preventDefault();
		event.stopPropagation();
		toggle(entry);
		return;
	}
	adv.editor.updateSearch();
	// Shift-Enter adds a condition, which the editor does itself.
	if (event.key === 'Enter' && !event.shiftKey) {
		// Enter on a focused button runs that button, as it does in core's pane.
		let button = event.target.closest && event.target.closest('button, toolbarbutton');
		if (button) {
			button.click();
			return;
		}
		await run(entry);
	}
}

/** zoteroPane.js toggleAdvancedSearchState('open'): open, then focus, then close. */
function toggle(entry) {
	let adv = entry.adv;
	if (adv.state === 'open') {
		if (!adv.box.matches(':focus-within')) focus(adv);
		else setState(entry, 'closed');
		return;
	}
	setState(entry, 'open');
}

function setState(entry, state) {
	let adv = entry.adv;
	adv.state = state;
	adv.box.hidden = state !== 'open';
	if (state === 'closed') {
		adv.search = null;
		// Closing drops the filter and collapsing keeps it: core's rule.
		if (adv.active) {
			adv.active = false;
			adv.reply('zgSetAdvanced', { matches: null });
		}
	}
	if (state === 'open') {
		if (!adv.search) load(entry, null);
		focus(adv);
	}
	adv.reply('zgSetAdvanced', { state });
}

/** A search into the editor -- core's fresh one when there is none. */
function load(entry, search) {
	let adv = entry.adv;
	if (!search) {
		search = new Zotero.Search();
		search.libraryID = entry.collection.libraryID;
		// Top-level items, so a condition on a child maps up to its item.
		search.addCondition('resultLevel', 'item');
		search.addCondition('title', 'contains', '');
	}
	adv.search = search;
	adv.editor.scopeLibraryIDs = [search.libraryID];
	adv.editor.search = search;
}

function focus(adv) {
	let first = adv.editor.querySelector('#conditionsmenu');
	if (first) first.focus();
	else adv.editor.focus();
}

/** Core's Search button: run it, and hand the page what it found. */
async function run(entry) {
	let adv = entry.adv;
	if (!adv || !adv.search) return;
	adv.editor.updateSearch();
	adv.active = true;
	let search = adv.search;
	let ids = await search.search();
	// Closed, cleared or replaced while it ran: this answer is to nothing.
	if (entry.adv !== adv || adv.search !== search || !adv.active) return;
	adv.reply('zgSetAdvanced', { matches: onGraph(entry, ids) });
}

/** Core's Clear: a fresh search, and the graph back whole. */
function reset(entry) {
	let adv = entry.adv;
	load(entry, null);
	if (adv.active) {
		adv.active = false;
		adv.reply('zgSetAdvanced', { matches: null });
	}
}

/** zoteroPane.js openAdvancedSearchFromQuickSearch(), onto this pane. */
async function seed(entry, parts, m) {
	let s = new Zotero.Search();
	s.libraryID = entry.collection.libraryID;
	// Title, Creator, Year matches only top-level items, so the seeded search
	// says so; the other two leave the result level to the user.
	if (m === 'titleCreatorYear') s.addCondition('resultLevel', 'item');
	for (let part of parts) {
		if (m === 'everything') {
			s.addCondition('groupStart', 'true', '');
			s.addCondition('joinMode', 'any');
			s.addCondition('anyField', 'contains', part.text);
			s.addCondition('fulltextContent', 'contains', part.text);
			s.addCondition('groupEnd', 'true', '');
		}
		else if (m === 'titleCreatorYear') {
			s.addCondition('titleCreatorYear', 'contains', part.text);
		}
		else {
			s.addCondition('anyField', 'contains', part.text);
		}
	}
	load(entry, s);
	setState(entry, 'open');
	await run(entry);
	focus(entry.adv);
}

/** Everything the page's search asks of the pane. */
async function advanced(entry, msg, reply) {
	let adv = pane(entry, reply);
	switch (msg.action) {
		// The filter button: seeded from the field's text when there is any,
		// Ctrl+Shift+F when there is none.
		case 'button': {
			let parts = msg.text ? Zotero.SearchConditions.parseSearchString(msg.text) : [];
			if (parts.length) await seed(entry, parts, isMode(msg.mode) ? msg.mode : mode());
			else toggle(entry);
			break;
		}
		case 'toggle':
			toggle(entry);
			break;
		// zoteroPane.js toggleAdvancedSearchState('collapsed').
		case 'collapse':
			setState(entry, adv.state === 'collapsed' ? 'open' : 'collapsed');
			break;
		case 'close':
			setState(entry, 'closed');
			break;
		case 'focus':
			if (adv.state === 'open') focus(adv);
			break;
	}
}

/** Where the page wants the pane: under its bar, over its canvas column. */
function place(entry, msg) {
	let rect = { left: Number(msg.left) || 0, top: Number(msg.top) || 0, width: Number(msg.width) || 0 };
	entry.advRect = rect;
	if (entry.adv) placeBox(entry.adv, rect);
}

function placeBox(adv, rect) {
	if (!rect) return;
	adv.box.style.left = rect.left + 'px';
	adv.box.style.top = rect.top + 'px';
	adv.box.style.width = rect.width + 'px';
}

/** A rebuild can bring in items the last answer never saw: ask again. */
function refresh(entry) {
	if (entry.adv && entry.adv.active) run(entry).catch(e => Zotero.logError(e));
}

function drop(entry) {
	let adv = entry.adv;
	entry.adv = null;
	if (adv) {
		if (adv.observer) adv.observer.disconnect();
		adv.box.remove();
		adv.style.remove();
	}
	if (entry.win) removeMenu(entry.win);
}

module.exports = { modeInfo, quickSearch, openModeMenu, advanced, place, refresh, drop };
