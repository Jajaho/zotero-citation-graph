'use strict';

/**
 * Adapter that reads a Zotero data directory directly -- no running Zotero, no
 * network. Lets every strategy be developed and benchmarked before any of the
 * client integration exists.
 *
 * The Zotero-runtime adapter (Zotero.Items / Zotero.FullText / pdf.js) will
 * implement the same four methods; providers do not change.
 *
 * Note: Zotero holds a write lock on zotero.sqlite while running. Point
 * `dbPath` at a copy.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const FT_CACHE = '.zotero-ft-cache';

class LocalSqliteAdapter {
	/**
	 * @param {Object} opts
	 * @param {string} opts.dataDir  Zotero data directory (holds storage/)
	 * @param {string} [opts.dbPath] defaults to <dataDir>/zotero.sqlite
	 * @param {boolean} [opts.usePdftotext] fall back to pdftotext when no ft-cache
	 */
	constructor({ dataDir, dbPath, usePdftotext = true }) {
		this.dataDir = dataDir;
		this.storage = path.join(dataDir, 'storage');
		this.usePdftotext = usePdftotext;
		this.db = new DatabaseSync(dbPath || path.join(dataDir, 'zotero.sqlite'), { readOnly: true });
		this._fields = Object.fromEntries(
			this.db.prepare('SELECT fieldID,fieldName FROM fields').all().map((r) => [r.fieldName, r.fieldID])
		);
		this._attCache = new Map();
	}

	async listItems() {
		const F = this._fields;
		// The venue, under whichever name this item type gives it. Zotero base-field
		// maps proceedingsTitle and bookTitle onto publicationTitle, but that mapping
		// lives in the schema rather than these tables, so it is spelled out here. An
		// item carries at most one of the three, so MAX picks the only value there is.
		const venue = ['publicationTitle', 'proceedingsTitle', 'bookTitle']
			.map((n) => F[n]).filter((id) => id != null);
		const venueExpr = venue.length
			? `MAX(CASE WHEN d.fieldID IN (${venue.join(',')}) THEN v.value END)`
			: 'NULL';
		const rows = this.db.prepare(`
			SELECT i.itemID, i.key, it.typeName AS itemType,
				MAX(CASE WHEN d.fieldID=${F.title} THEN v.value END) AS title,
				MAX(CASE WHEN d.fieldID=${F.DOI}   THEN v.value END) AS doi,
				MAX(CASE WHEN d.fieldID=${F.date}  THEN v.value END) AS date,
				MAX(CASE WHEN d.fieldID=${F.extra} THEN v.value END) AS extra,
				MAX(CASE WHEN d.fieldID=${F.url}   THEN v.value END) AS url,
				${venueExpr} AS publication
			FROM items i
			JOIN itemTypes it USING (itemTypeID)
			LEFT JOIN itemData d USING (itemID)
			LEFT JOIN itemDataValues v USING (valueID)
			WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)
			  AND i.itemID NOT IN (SELECT itemID FROM itemAttachments WHERE parentItemID IS NOT NULL)
			  AND i.itemID NOT IN (SELECT itemID FROM itemNotes WHERE parentItemID IS NOT NULL)
			GROUP BY i.itemID`).all();

		const creators = this.db.prepare(`
			SELECT ic.itemID, c.lastName FROM itemCreators ic
			JOIN creators c USING (creatorID) ORDER BY ic.itemID, ic.orderIndex`).all();
		const byItem = new Map();
		for (const c of creators) {
			if (!byItem.has(c.itemID)) byItem.set(c.itemID, []);
			byItem.get(c.itemID).push(c.lastName);
		}

		return rows
			.filter((r) => r.title && !['attachment', 'note', 'annotation'].includes(r.itemType))
			.map((r) => ({
				key: r.key, itemType: r.itemType, title: r.title, doi: r.doi,
				date: r.date, extra: r.extra, url: r.url, publication: r.publication || null,
				creators: byItem.get(r.itemID) || [],
			}));
	}

	_loadAttachments() {
		if (this._attCache.size) return;
		const rows = this.db.prepare(`
			SELECT a.path, a.contentType, i.key AS attKey, p.key AS parentKey, ia.storageHash AS hash
			FROM itemAttachments a
			JOIN items i ON i.itemID = a.itemID
			LEFT JOIN items p ON p.itemID = a.parentItemID
			LEFT JOIN itemAttachments ia ON ia.itemID = a.itemID
			WHERE a.path IS NOT NULL
			  AND a.itemID NOT IN (SELECT itemID FROM deletedItems)`).all();
		for (const r of rows) {
			if (!r.parentKey || !String(r.path).startsWith('storage:')) continue;
			const file = path.join(this.storage, r.attKey, String(r.path).slice(8));
			const att = {
				key: r.attKey, parentKey: r.parentKey, contentType: r.contentType,
				hash: r.hash || null, file,
			};
			if (!this._attCache.has(r.parentKey)) this._attCache.set(r.parentKey, []);
			this._attCache.get(r.parentKey).push(att);
			this._attCache.set('@' + r.attKey, att);
		}
	}

	async getAttachments(itemKey) {
		this._loadAttachments();
		return (this._attCache.get(itemKey) || []).filter((a) => fs.existsSync(a.file));
	}

	/** Prefers Zotero's own .zotero-ft-cache -- already extracted, free to read. */
	async getAttachmentText(attKey) {
		this._loadAttachments();
		const att = this._attCache.get('@' + attKey);
		if (!att) return null;
		const cache = path.join(this.storage, attKey, FT_CACHE);
		if (fs.existsSync(cache)) {
			try { return fs.readFileSync(cache, 'utf8'); } catch (e) { /* fall through */ }
		}
		if (!this.usePdftotext || att.contentType !== 'application/pdf') return null;
		try {
			return execFileSync('pdftotext', ['-q', att.file, '-'],
				{ maxBuffer: 1 << 28, timeout: 60000 }).toString('utf8');
		}
		catch (e) { return null; }
	}

	/**
	 * Harvest /URI link-annotation targets. Zotero has no link annotation type,
	 * so this reads the file. In the Zotero runtime the equivalent is pdf.js
	 * page.getAnnotations() filtered to subtype 'Link'.
	 */
	async getPdfLinkUris(attKey) {
		this._loadAttachments();
		const att = this._attCache.get('@' + attKey);
		if (!att || att.contentType !== 'application/pdf' || !fs.existsSync(att.file)) return [];
		let buf;
		try { buf = fs.readFileSync(att.file); } catch (e) { return []; }
		const uris = new Set();
		const scan = (s) => {
			const re = /\/URI\s*\(((?:[^()\\]|\\[\s\S])*)\)/g;
			let m;
			while ((m = re.exec(s))) uris.add(m[1].replace(/\\([()\\])/g, '$1'));
		};
		const s = buf.toString('latin1');
		scan(s);
		const re = /stream\r?\n/g;
		let m;
		while ((m = re.exec(s))) {
			const start = m.index + m[0].length;
			const end = s.indexOf('endstream', start);
			if (end < 0) continue;
			const raw = buf.subarray(start, end);
			for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
				try { scan(fn(raw).toString('latin1')); break; } catch (e) { /* not this codec */ }
			}
		}
		return [...uris];
	}
}

module.exports = { LocalSqliteAdapter };
