/* global Zotero, IOUtils, PathUtils, Services */

'use strict';

/**
 * The citation-graph adapter backed by the running Zotero client.
 *
 * Implements exactly the four methods citation-graph/adapters/localSqlite.js
 * implements, so every strategy under citation-graph/edges/ runs unchanged here
 * and in the Node benchmark harness. That is the whole point of the adapter
 * seam: the same core, two hosts, comparable numbers.
 *
 *   listItems()               -> Item[]
 *   getAttachments(itemKey)   -> Attachment[]
 *   getAttachmentText(attKey) -> string|null
 *   getPdfLinkUris(attKey)    -> string[]
 *
 * Scope: one collection, not the whole library. Edge counts therefore only
 * match the CLI's library-wide figures when the collection is the library.
 */

const FT_CACHE = '.zotero-ft-cache';

// PDFs are read whole into a JS string to be scanned. 256 MB is far above
// anything real (the sample library's largest is 42 MB) and only exists so a
// pathological file cannot wedge the build.
const MAX_PDF_BYTES = 256 * 1024 * 1024;

class ZoteroAdapter {
	/**
	 * @param {Zotero.Collection} collection
	 * @param {Object} [opts]
	 * @param {Object} [opts.cache]      PdfLinkCache, or null to always rescan
	 * @param {boolean} [opts.recursive] include items in subcollections
	 */
	constructor(collection, { cache = null, recursive = false } = {}) {
		this.collection = collection;
		this.cache = cache;
		this.recursive = recursive;
		this._items = null;
		this._itemByKey = new Map();  // item key -> Zotero.Item
		this._attsByItem = new Map(); // item key -> Attachment[]
		this._attByKey = new Map();   // att key  -> { rec, item }
		this.stats = { pdfsScanned: 0, pdfsFromCache: 0, textFound: 0, textMissing: 0 };
	}

	async listItems() {
		if (this._items) return this._items;

		let { items: zItems, collectionsByKey } = await collectionItems(this.collection, this.recursive);
		await Zotero.Items.loadDataTypes(zItems);

		let out = [];
		for (let item of zItems) {
			let rec = itemRecord(item, collectionsByKey.get(item.key) || []);
			if (!rec) continue;
			this._itemByKey.set(item.key, item);
			out.push(rec);
		}
		this._items = out;
		return out;
	}

	async getAttachments(itemKey) {
		if (this._attsByItem.has(itemKey)) return this._attsByItem.get(itemKey);

		let out = [];
		let item = this._itemByKey.get(itemKey);
		if (item) {
			// getAttachments() returns itemIDs, not items.
			let atts = await Zotero.Items.getAsync(item.getAttachments());
			await Zotero.Items.loadDataTypes(atts);
			for (let att of atts) {
				if (att.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) continue;
				// Returns false when the file is missing on disk -- the equivalent
				// of the SQLite adapter's fs.existsSync() filter.
				let file = await att.getFilePathAsync();
				if (!file) continue;
				let rec = {
					key: att.key,
					parentKey: itemKey,
					contentType: att.attachmentContentType || '',
					hash: null,
					file,
				};
				out.push(rec);
				this._attByKey.set(att.key, { rec, item: att });
			}
		}
		this._attsByItem.set(itemKey, out);
		return out;
	}

	/**
	 * Zotero has already extracted this text for its own full-text index, so the
	 * text strategies cost a file read and nothing else. No pdftotext fallback:
	 * shelling out is not available here, and an un-indexed attachment simply
	 * contributes no edges.
	 */
	async getAttachmentText(attKey) {
		let entry = this._attByKey.get(attKey);
		if (!entry) return null;
		let path = ftCachePath(entry.item);
		if (!path) return null;
		try {
			if (!(await IOUtils.exists(path))) {
				this.stats.textMissing++;
				return null;
			}
			let text = await Zotero.File.getContentsAsync(path, 'utf-8');
			this.stats.textFound++;
			return text;
		}
		catch (e) {
			this.stats.textMissing++;
			return null;
		}
	}

	/**
	 * Raw-byte scan for /URI link annotations.
	 *
	 * pdf.js is unreachable from chrome JS (it only runs inside the reader's
	 * document worker) and Zotero has no 'link' annotation type, so the file is
	 * read directly -- compressed object streams included, see
	 * scanUriAnnotations().
	 */
	async getPdfLinkUris(attKey) {
		let entry = this._attByKey.get(attKey);
		if (!entry || entry.rec.contentType !== 'application/pdf') return [];
		let file = entry.rec.file;

		let stat;
		try {
			stat = await IOUtils.stat(file);
		}
		catch (e) {
			return [];
		}
		if (stat.size > MAX_PDF_BYTES) return [];
		let stamp = stat.size + ':' + Number(stat.lastModified || 0);

		if (this.cache) {
			let hit = this.cache.get(attKey, stamp);
			if (hit) {
				this.stats.pdfsFromCache++;
				return hit;
			}
		}

		let uris;
		try {
			uris = scanUriAnnotations(await IOUtils.read(file), inflater());
		}
		catch (e) {
			return [];
		}
		this.stats.pdfsScanned++;
		if (this.cache) this.cache.set(attKey, stamp, uris);
		return uris;
	}

	/** How many PDFs a pdf-links pass would have to read, for the progress UI. */
	pdfCount() {
		let n = 0;
		for (let atts of this._attsByItem.values()) {
			for (let a of atts) if (a.contentType === 'application/pdf') n++;
		}
		return n;
	}
}

/**
 * Items directly in the collection, plus every descendant collection's when
 * `recursive`. Also records which in-scope collections each item belongs to, so
 * the renderer can colour by collection.
 *
 * getDescendents(false, 'collection') is flat and includes all levels, not just
 * the immediate children -- so one call covers the whole subtree.
 */
async function collectionItems(collection, recursive) {
	let collections = [collection];
	if (recursive) {
		try {
			collections = collections.concat(
				collection.getDescendents(false, 'collection')
					.map(d => Zotero.Collections.get(d.id))
					.filter(Boolean)
			);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}
	let byKey = new Map();
	let collectionsByKey = new Map();
	for (let c of collections) {
		try {
			await c.loadDataType('childItems');
		}
		catch (e) {
			// Already loaded, or not lazily loaded in this version.
		}
		for (let item of c.getChildItems(false, false)) {
			byKey.set(item.key, item);
			let names = collectionsByKey.get(item.key);
			if (!names) collectionsByKey.set(item.key, names = []);
			if (!names.includes(c.name)) names.push(c.name);
		}
	}
	return { items: [...byKey.values()], collectionsByKey };
}

/**
 * getField() throws for a field that is not valid for the item's type, which is
 * routine here -- 'DOI' does not exist on a book or a thesis.
 */
function field(item, name, { unformatted = false, baseMapped = false } = {}) {
	try {
		return item.getField(name, unformatted, baseMapped) || '';
	}
	catch (e) {
		return '';
	}
}

function ftCachePath(att) {
	let FT = Zotero.FullText || Zotero.Fulltext;
	try {
		let f = FT && FT.getItemCacheFile && FT.getItemCacheFile(att);
		if (f && f.path) return f.path;
	}
	catch (e) {
		// Fall through to composing the path by hand.
	}
	try {
		return PathUtils.join(Zotero.Attachments.getStorageDirectory(att).path, FT_CACHE);
	}
	catch (e) {
		return null;
	}
}

const URI_RE = /\/URI\s*\(((?:[^()\\]|\\[\s\S])*)\)/g;
// "stream" opening a stream's body, and not the tail of an "endstream".
const STREAM_RE = /(?<!end)stream\r?\n/g;
// A direct /Length -- not "/Length 12 0 R", which names another object.
const LENGTH_RE = /\/Length\s+(\d+)(?![\d\s]*R)/;
// How far back from "stream" to look for the dictionary that owns it. An
// object stream's is a handful of keys, so this is generous.
const DICT_LOOKBACK = 1024;

/**
 * Every /URI string in a PDF, the ones in compressed object streams included.
 *
 * Since PDF 1.5 a writer may pack objects -- link annotations among them --
 * into /Type /ObjStm streams, which are FlateDecoded, and most current writers
 * do. A scan of the raw bytes sees none of those links, so a paper whose
 * bibliography is linked that way came out of pdf-links with no edge at all:
 * nothing in the collection cited, and not one outside reference either. So
 * object streams are inflated and read as well. Only object streams: they are
 * the one place a compressed annotation can live, and inflating every image
 * and font on the way would make a 40 MB file cost seconds to find nothing.
 *
 * `inflate` is injected -- bytes in, bytes out, throwing on bad data -- so the
 * same scan runs against zlib under Node. Without one only the raw bytes are
 * read, which is what the scan always did.
 *
 * @param {Uint8Array} bytes
 * @param {?function(Uint8Array): Uint8Array} [inflate]
 * @returns {string[]}
 */
function scanUriAnnotations(bytes, inflate = null) {
	let s = bytesToBinaryString(bytes);
	let uris = new Set();
	collectUris(s, uris);
	if (!inflate) return [...uris];

	STREAM_RE.lastIndex = 0;
	let m;
	while ((m = STREAM_RE.exec(s))) {
		let start = m.index + m[0].length;
		let end = s.indexOf('endstream', start);
		if (end < 0) break;
		// Whatever the verdict below, the body is binary and not worth a
		// regex pass of its own.
		STREAM_RE.lastIndex = end;
		let head = s.slice(Math.max(0, m.index - DICT_LOOKBACK), m.index);
		let at = head.lastIndexOf('obj');
		if (at < 0) continue;
		head = head.slice(at);
		if (!head.includes('/ObjStm') || !head.includes('/FlateDecode')) continue;
		// The data has to be cut exactly. pako, unlike zlib, reads anything
		// after the compressed stream as the start of a second one and throws
		// on it -- the end-of-line before "endstream" included. So: the direct
		// /Length where there is one, and "endstream" less that end-of-line
		// where there is not.
		let len = LENGTH_RE.exec(head);
		let stop = len && start + Number(len[1]) <= end ? start + Number(len[1]) : end;
		if (stop === end) {
			while (stop > start && (s[stop - 1] === '\n' || s[stop - 1] === '\r')) stop--;
		}
		try {
			collectUris(bytesToBinaryString(inflate(bytes.subarray(start, stop))), uris);
		}
		catch (e) {
			// A stream that will not inflate costs its own links and no more.
		}
	}
	return [...uris];
}

function collectUris(s, uris) {
	URI_RE.lastIndex = 0;
	let m;
	while ((m = URI_RE.exec(s))) {
		uris.add(m[1].replace(/\\([()\\])/g, '$1'));
	}
}

/**
 * pako's inflate, from the copy Zotero ships for itself -- core's schema.js and
 * sdt.js require the same file. Loaded on first use and remembered as `false`
 * if it cannot be: a Zotero that has moved it costs the compressed links, not
 * the scan.
 */
let pako = null;
function inflater() {
	if (pako === null) {
		try {
			// pako is UMD, and handed `exports` and `module` it fills in the former.
			let scope = { exports: {}, module: {} };
			Services.scriptloader.loadSubScript('resource://zotero/pako.js', scope);
			pako = typeof scope.exports.inflate === 'function' ? scope.exports : false;
		}
		catch (e) {
			Zotero.logError(e);
			pako = false;
		}
	}
	return pako ? b => pako.inflate(b) : null;
}

/**
 * Byte -> code unit, 1:1.
 *
 * NOT TextDecoder('latin1'): that label aliases windows-1252, which remaps
 * 0x80-0x9F to other code points and so shifts every offset after the first
 * such byte. String.fromCharCode is the only faithful mapping available.
 */
function bytesToBinaryString(bytes) {
	const CHUNK = 0x8000; // apply() blows the argument limit above ~64k
	let parts = [];
	for (let i = 0; i < bytes.length; i += CHUNK) {
		parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
	}
	return parts.join('');
}

/**
 * One item, in the shape the adapter's contract promises, or null for
 * anything the build would have skipped -- a note, an attachment, a record
 * with no title.
 *
 * Lifted out of listItems() because a paper added from the graph joins a
 * collection that has already been listed (graphTab.js adoptAdded), and a
 * newcomer described differently from the items already there is a whole
 * class of bug that this makes impossible rather than unlikely.
 *
 * @param {Zotero.Item} item
 * @param {String[]} [collections] names of the in-scope collections holding it
 */
function itemRecord(item, collections = []) {
	if (!item.isRegularItem()) return null;
	let title = field(item, 'title', { baseMapped: true });
	if (!title) return null;
	return {
		key: item.key,
		// Not part of the adapter contract, but the graph page needs it to
		// ask the chrome side to select the item in the library pane.
		itemID: item.id,
		itemType: Zotero.ItemTypes.getName(item.itemTypeID),
		title,
		doi: field(item, 'DOI') || null,
		// Unformatted: the raw multipart date, matching what the SQLite
		// adapter reads straight out of itemDataValues.
		date: field(item, 'date', { unformatted: true }) || null,
		extra: field(item, 'extra') || null,
		url: field(item, 'url') || null,
		// The venue a work appeared in. baseMapped folds proceedingsTitle and
		// bookTitle onto publicationTitle, so one facet covers every item type
		// that has a venue at all instead of three that each cover a third of
		// the library.
		publication: field(item, 'publicationTitle', { baseMapped: true }) || null,
		creators: item.getCreators().map(c => c.lastName).filter(Boolean),
		// Both kinds of tag, the ones typed by hand and the ones a translator
		// attached. Which of the two a tag is describes where it came from,
		// not what it says -- and someone grouping by "quantum sensing" does
		// not care that the importer wrote it rather than they did.
		tags: item.getTags().map(t => t.tag).filter(Boolean),
		// Which of the in-scope collections hold this item. Only interesting
		// once subcollections are included -- without them every item shares
		// one name.
		collections,
	};
}

module.exports = { ZoteroAdapter, itemRecord, scanUriAnnotations, bytesToBinaryString };
