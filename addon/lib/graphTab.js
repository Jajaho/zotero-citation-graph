/* global Zotero, console */

/**
 * Tab creation and the chrome<->content bridge.
 *
 * Mirrors core's ReaderTab (xpcom/reader.js:1976-2090): Zotero_Tabs.add() returns
 * a <tab-content> container, we append a <browser type="content">, wait for
 * DOMContentLoaded filtered to that browser's document, then poll until the page
 * has published its API.
 *
 * Payloads cross the privilege boundary as JSON *strings*. A string is a
 * primitive, so it needs no Cu.cloneInto, no Xray waiver and no structured-clone
 * of nested objects -- which removes the fiddliest part of the integration.
 */

let open_ = new Map(); // tabID -> { win, browser, collection }

async function open(win, collection, config) {
	let title = 'Citation Graph — ' + collection.name;

	let { id, container } = win.Zotero_Tabs.add({
		// No hyphen: tabs.js parseTabType() splits the type on '-' to separate
		// the content type from the '-unloaded' state suffix.
		type: 'graph',
		title,
		data: { collectionKey: collection.key, libraryID: collection.libraryID },
		select: true,
		onClose: () => {
			open_.delete(id);
		},
	});

	let browser = win.document.createXULElement('browser');
	browser.setAttribute('class', 'zotero-graph');
	browser.setAttribute('flex', '1');
	browser.setAttribute('type', 'content');
	browser.setAttribute('transparent', 'true');
	browser.setAttribute('src', `resource://${config.resRoot}/content/graph.html`);
	container.appendChild(browser);

	open_.set(id, { win, browser, collection });

	let onDOMContentLoaded = (event) => {
		if (browser.contentWindow && browser.contentWindow.document === event.target) {
			win.removeEventListener('DOMContentLoaded', onDOMContentLoaded);
			ready(win, id, browser.contentWindow, collection).catch(e => Zotero.logError(e));
		}
	};
	win.addEventListener('DOMContentLoaded', onDOMContentLoaded);
}

async function ready(win, tabID, cw, collection) {
	cw.addEventListener('error', e => Zotero.logError(e.error));

	// The content page defines window.zgSetData synchronously as its script parses,
	// but poll anyway -- same shape as reader.js _waitForReader().
	let n = 0;
	while (!cw.wrappedJSObject.zgSetData) {
		if (n++ > 500) throw new Error('graph page never published zgSetData');
		await Zotero.Promise.delay(20);
	}

	// content -> chrome. event.detail is a JSON string (a primitive), so there is
	// nothing to unwrap.
	cw.addEventListener('zg-event', (event) => {
		let msg;
		try {
			msg = JSON.parse(event.detail);
		}
		catch (e) {
			return;
		}
		handleMessage(win, tabID, collection, msg).catch(e => Zotero.logError(e));
	});

	let payload = await buildPayload(collection);
	cw.wrappedJSObject.zgSetData(JSON.stringify(payload));
}

async function handleMessage(win, tabID, collection, msg) {
	switch (msg.type) {
		case 'open-item':
			if (msg.itemID) {
				win.Zotero_Tabs.select('zotero-pane');
				await win.ZoteroPane.selectItem(msg.itemID);
			}
			break;
		case 'rebuild':
			await rebuild(win, tabID, collection);
			break;
		default:
			console.log('unhandled message from graph page: ' + msg.type);
	}
}

async function rebuild(win, tabID, collection) {
	let entry = open_.get(tabID);
	if (!entry) return;
	let payload = await buildPayload(collection);
	entry.browser.contentWindow.wrappedJSObject.zgSetData(JSON.stringify(payload));
}

/**
 * Step 3 placeholder: a hardcoded graph, so the tab + content page + renderer can
 * be verified before any Zotero data or edge derivation is involved.
 */
async function buildPayload(collection) {
	return {
		collection: { key: collection.key, name: collection.name },
		items: [
			{ key: 'A', title: 'Placeholder paper A', date: '2019' },
			{ key: 'B', title: 'Placeholder paper B', date: '2021' },
			{ key: 'C', title: 'Placeholder paper C', date: '2023' },
		],
		edges: [
			{ from: 'C', to: 'A', confidence: 0.95, via: ['pdf-links'] },
			{ from: 'C', to: 'B', confidence: 0.6, via: ['title-match'] },
			{ from: 'B', to: 'A', confidence: 0.9, via: ['text-doi'] },
		],
		meta: { placeholder: true },
	};
}

function closeAllInWindow(win) {
	for (let [tabID, entry] of [...open_]) {
		if (entry.win === win) {
			try {
				win.Zotero_Tabs.close(tabID);
			}
			catch (e) { /* tab may already be gone */ }
			open_.delete(tabID);
		}
	}
}

function closeAll() {
	for (let [, entry] of [...open_]) {
		closeAllInWindow(entry.win);
	}
	open_.clear();
}

module.exports = { open, closeAll, closeAllInWindow };
