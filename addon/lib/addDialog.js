/* global Zotero */

/**
 * The dialog behind "Add to Zotero": which tag the new item carries, and which
 * collection it is filed into.
 *
 * Built in the main window's own document rather than opened as a window of its
 * own. A Zotero 7+ plugin registers no chrome:// package -- this one serves its
 * files over resource:// -- so there is no privileged document of ours to hand
 * openDialog(), and the collection picker has to be core's. It IS core's:
 * Zotero.Utilities.Internal.createMenuForTarget(), the same call
 * newCollectionDialog.js makes to fill its "Create in" field and the same tree
 * behind "Add to Collection" in the items list. That call wants a <menupopup>
 * in a XUL document, and the main window is one.
 *
 * "New collection…" hands off to core's newCollectionDialog.xhtml for the same
 * reason: it already asks the two questions -- what it is called, and where it
 * goes -- with a picker built by the very function above, so the two menus
 * cannot come to disagree about what the library holds.
 *
 * A <panel> rather than a modal window, for the same reason the reader is a
 * pane rather than a tab: the graph the ghost was clicked in stays on screen
 * behind it.
 */

let l10n = require('./l10n.js');

const PANEL_ID = 'zotero-graph-add';

// The panel's own width, and the number the opener centres it by. Stated once
// here because CSS sizes the box and script positions the popup, and the two
// have to agree or the dialog sits off-centre.
const PANEL_WIDTH = 420;

const PANEL_CSS = `
	#${PANEL_ID} .zg-add {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px 16px 12px;
		width: ${PANEL_WIDTH}px;
		font-size: 12px;
		color: var(--fill-primary);
	}
	#${PANEL_ID} .zg-add-work {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 2px;
	}
	#${PANEL_ID} .zg-add-name {
		font-weight: 600;
		/* A ghost's name can be a whole sentence. Two lines is enough to
		   recognise the paper, and the dialog must not grow to fit a title. */
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	#${PANEL_ID} .zg-add-doi {
		color: var(--fill-secondary);
		font-size: 11px;
		overflow-wrap: anywhere;
	}
	#${PANEL_ID} .zg-add-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	/* One column for both labels, so the field and the menu start at the same
	   place. The tag's label doubles as the checkbox's, so it is sized here too. */
	#${PANEL_ID} .zg-add-key {
		flex: none;
		width: 88px;
		margin: 0;
		color: var(--fill-secondary);
	}
	#${PANEL_ID} .zg-add-grow {
		flex: 1;
		min-width: 0;
	}
	#${PANEL_ID} .zg-add-tag:disabled {
		opacity: 0.5;
	}
	#${PANEL_ID} .zg-add-buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 4px;
	}
`;

/**
 * Ask where a work should go, and come back with the answer.
 *
 * @param {Object}   win                 the main window
 * @param {Object}   opts
 * @param {String}   opts.doi            the identifier being added, shown verbatim
 * @param {String}  [opts.title]         the work's name, where the lookup found one
 * @param {Number}   opts.libraryID      the library to file into
 * @param {?Number} [opts.collectionID]  collection to preselect; null is the library root
 * @param {String}  [opts.tag]           what the tag field opens with
 * @param {Boolean} [opts.tagOn]         whether the tag is applied, default true
 * @param {Object}  [opts.anchor]        element to centre the panel over
 * @returns {Promise<?Object>} { libraryID, collectionID, tag, tagOn }, or null if cancelled
 */
function open(win, opts) {
	return new Promise((resolve) => {
		let doc = win.document;
		// A second question asked while the first is up would leave that one
		// resolving nothing. There is one panel, and the newest is the live one.
		let stale = doc.getElementById(PANEL_ID);
		if (stale) stale.remove();

		let state = {
			libraryID: opts.libraryID,
			collectionID: opts.collectionID != null ? opts.collectionID : null,
		};
		let settled = false;

		// The window is XHTML: createElement() gives HTML elements and
		// createXULElement() gives XUL ones, and one box lays out both.
		let panel = doc.createXULElement('panel');
		panel.id = PANEL_ID;
		// The whole point is that the graph stays readable behind it, so a click
		// out there must not throw the question away half-answered.
		panel.setAttribute('noautohide', 'true');
		panel.setAttribute('consumeoutsideclicks', 'false');
		panel.setAttribute('level', 'parent');

		let style = doc.createElement('style');
		style.textContent = PANEL_CSS;

		let box = doc.createElement('div');
		box.className = 'zg-add';

		let work = doc.createElement('div');
		work.className = 'zg-add-work';
		let name = doc.createElement('div');
		name.className = 'zg-add-name';
		name.textContent = opts.title || opts.doi;
		let doiLine = doc.createElement('div');
		doiLine.className = 'zg-add-doi';
		// Only where it is not already the heading: offline a ghost is its DOI
		// and nothing else, and printing that twice says nothing the second time.
		doiLine.textContent = opts.title ? opts.doi : '';
		work.appendChild(name);
		if (doiLine.textContent) work.appendChild(doiLine);

		// --- the tag ----------------------------------------------------

		let tagRow = doc.createElement('div');
		tagRow.className = 'zg-add-row';
		let tagCheck = doc.createElement('input');
		tagCheck.type = 'checkbox';
		tagCheck.id = 'zg-add-tag-on';
		tagCheck.checked = opts.tagOn !== false;
		let tagLabel = doc.createElement('label');
		tagLabel.className = 'zg-add-key';
		tagLabel.setAttribute('for', 'zg-add-tag-on');
		tagLabel.textContent = l10n.t('add-tag-label');
		let tagInput = doc.createElement('input');
		tagInput.type = 'text';
		tagInput.className = 'zg-add-grow zg-add-tag';
		tagInput.value = opts.tag || '';
		tagInput.disabled = !tagCheck.checked;
		let syncTag = () => {
			tagInput.disabled = !tagCheck.checked;
		};
		tagCheck.addEventListener('change', syncTag);
		tagRow.appendChild(tagCheck);
		tagRow.appendChild(tagLabel);
		tagRow.appendChild(tagInput);

		// --- the collection ---------------------------------------------

		let colRow = doc.createElement('div');
		colRow.className = 'zg-add-row';
		let colLabel = doc.createElement('label');
		colLabel.className = 'zg-add-key';
		colLabel.textContent = l10n.t('add-collection-label');
		let menulist = doc.createXULElement('menulist');
		menulist.className = 'zg-add-grow';
		// As core's own "Create in" field: the platform dropdown, so the tree of
		// submenus below looks like every other collection menu in Zotero.
		menulist.setAttribute('native', 'true');
		let menupopup = doc.createXULElement('menupopup');
		menulist.appendChild(menupopup);
		let newBtn = doc.createElement('button');
		newBtn.type = 'button';
		newBtn.textContent = l10n.t('add-new-collection');
		colRow.appendChild(colLabel);
		colRow.appendChild(menulist);
		colRow.appendChild(newBtn);

		// --- the answer -------------------------------------------------

		let buttons = doc.createElement('div');
		buttons.className = 'zg-add-buttons';
		let cancelBtn = doc.createElement('button');
		cancelBtn.type = 'button';
		cancelBtn.textContent = l10n.t('add-cancel');
		let okBtn = doc.createElement('button');
		okBtn.type = 'button';
		okBtn.textContent = l10n.t('add-confirm');
		buttons.appendChild(cancelBtn);
		buttons.appendChild(okBtn);

		box.appendChild(style);
		box.appendChild(work);
		box.appendChild(tagRow);
		box.appendChild(colRow);
		box.appendChild(buttons);
		panel.appendChild(box);
		doc.documentElement.appendChild(panel);

		// --- the collection menu, core's --------------------------------

		/** What createMenuForTarget() ticks against: a collection's or a
		 *  library's treeViewID. */
		function selected() {
			return state.collectionID ? 'C' + state.collectionID : 'L' + state.libraryID;
		}

		/**
		 * Rebuilt whole on every pick rather than patched, because the tick is an
		 * attribute on one menuitem out of a tree of them -- which is what core
		 * does here too (newCollectionDialog.js _updateMenu).
		 */
		function buildMenu() {
			menupopup.replaceChildren();
			let library = Zotero.Libraries.get(state.libraryID);
			let node = Zotero.Utilities.Internal.createMenuForTarget(
				library,
				menupopup,
				selected(),
				(event, libraryOrCollection) => {
					// A <menu> row that has children stays open after its own
					// label is clicked; core closes it by hand for the same reason.
					if (event.target.tagName === 'menu') menupopup.hidePopup();
					state.libraryID = libraryOrCollection.libraryID;
					state.collectionID = libraryOrCollection.objectType === 'collection'
						? libraryOrCollection.id
						: null;
					showChoice();
				},
				null
			);
			// The library itself becomes a submenu as soon as it holds a
			// collection; its children are this menu's entries, not a level down.
			if (node.menupopup) node.replaceWith(...node.menupopup.children);
			showChoice();
		}

		/** A native menulist takes its face from the item it is showing, and
		 *  nothing here is "selected" in the menulist's own sense of the word. */
		function showChoice() {
			let item = menulist.querySelector('[value="' + selected() + '"]');
			menulist.setAttribute('label', (item && item.getAttribute('label')) || '');
			menulist.image = (item && item.getAttribute('image')) || '';
		}

		/**
		 * Core's new-collection dialog, filled in the way the collection tree
		 * fills it: whatever is picked here is the parent, and the name starts
		 * at the next free "Untitled".
		 */
		async function newCollection() {
			let siblings = state.collectionID
				? Zotero.Collections.getByParent(state.collectionID)
				: Zotero.Collections.getByLibrary(state.libraryID);
			let prefix = Zotero.getString('pane.collections.untitled');
			let suggested = Zotero.Utilities.Internal.getNextName(
				prefix,
				siblings.map(c => c.name).filter(n => n.startsWith(prefix))
			);
			let io = {
				name: suggested,
				libraryID: state.libraryID,
				parentCollectionID: state.collectionID,
			};
			win.openDialog(
				'chrome://zotero/content/newCollectionDialog.xhtml',
				'_blank',
				'chrome,modal,centerscreen,resizable=no',
				io
			);
			// Cancelled: dataOut is what the dialog writes back on accept.
			if (!io.dataOut) return;

			let collection = new Zotero.Collection();
			collection.libraryID = io.dataOut.libraryID;
			collection.name = io.dataOut.name || suggested;
			collection.parentID = io.dataOut.parentCollectionID;
			await collection.saveTx();

			// It was made from this dialog, so it is what this dialog now files
			// into. The alternative is a new collection nobody puts anything in.
			state.libraryID = collection.libraryID;
			state.collectionID = collection.id;
			buildMenu();
		}

		// --- closing ----------------------------------------------------

		function finish(value) {
			if (settled) return;
			settled = true;
			resolve(value);
			try {
				panel.hidePopup();
			}
			catch (e) {
				panel.remove();
			}
		}

		function accept() {
			finish({
				libraryID: state.libraryID,
				collectionID: state.collectionID,
				// The tick and the field come back separately: a box unticked
				// this once should not be what forgets the tag someone typed.
				tagOn: !!tagCheck.checked,
				tag: tagInput.value.trim(),
			});
		}

		okBtn.addEventListener('click', accept);
		cancelBtn.addEventListener('click', () => finish(null));
		newBtn.addEventListener('click', () => {
			newCollection().catch(e => Zotero.logError(e));
		});
		panel.addEventListener('keydown', (event) => {
			if (!event || event.defaultPrevented) return;
			// While the collection tree is dropped down, both keys belong to it.
			if (menulist.open) return;
			if (event.key === 'Enter') {
				event.preventDefault();
				accept();
			}
			else if (event.key === 'Escape') {
				event.preventDefault();
				finish(null);
			}
		});
		// Popup events BUBBLE, and the collection menu is a popup inside this
		// one. Without the target check, opening the menu took the focus back
		// and picking anything out of it cancelled the whole add.
		function ownPopup(event) {
			return !event || !event.target || event.target === panel;
		}
		// Whatever closed it -- the buttons above, or the window going away
		// underneath it -- the promise is answered exactly once.
		panel.addEventListener('popuphidden', (event) => {
			if (!ownPopup(event)) return;
			finish(null);
			panel.remove();
		});
		panel.addEventListener('popupshown', (event) => {
			if (!ownPopup(event)) return;
			try {
				tagInput.focus();
				tagInput.select();
			}
			catch (e) { /* nothing to focus; the dialog is still usable */ }
		});

		buildMenu();

		// Over the graph rather than over the whole window: the tab's browser is
		// what the ghost was clicked in, and "overlap" reads the offsets as a
		// position inside it. Centred across and a little down from the top,
		// which is where a sheet belongs and where it covers least of the graph.
		let anchor = opts.anchor || doc.documentElement;
		let width = anchor.getBoundingClientRect ? anchor.getBoundingClientRect().width : 0;
		let inset = Math.max(0, Math.round((width - PANEL_WIDTH - 32) / 2));
		panel.openPopup(anchor, 'overlap', inset, 64, false, false);
	});
}

module.exports = { open, PANEL_ID, PANEL_WIDTH };
