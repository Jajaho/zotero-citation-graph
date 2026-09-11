/* global Zotero, IOUtils, PathUtils */

'use strict';

let cacheStore = require('./cacheStore.js');

/**
 * Persistent cache for PDF /URI link-annotation scans.
 *
 * Scanning every PDF in the library costs ~28s (it reads each file whole), and
 * the result only changes when the file does. Caching it turns a once-per-open
 * cost into a once-per-file-ever cost.
 *
 * Deliberately a plain JSON file rather than Zotero's itemRelations: relations
 * would need a monkey-patch of Zotero.Relations._namespaces, and whether the
 * sync server accepts an unknown predicate is unverified. A file in the data
 * directory has neither problem and is trivially discardable.
 *
 * Entries are stamped with size:mtime rather than a content hash -- Zotero's
 * attachmentHash computes an MD5 over the whole file, which is exactly the
 * work being avoided.
 */

// 3: compressed object streams are inflated and read. An entry from before
// that is missing every link a PDF 1.5+ writer packed away, and its size:mtime
// stamp would never say so -- the file did not change, the scan did.
const VERSION = 3;

class PdfLinkCache {
	constructor(dir) {
		this.dir = dir;
		this.path = PathUtils.join(dir, cacheStore.FILES.pdfLinks);
		this.data = { version: VERSION, entries: {} };
		this.dirty = false;
		this.generation = cacheStore.generation();
	}

	static forProfile() {
		return new PdfLinkCache(cacheStore.dir());
	}

	async load() {
		this.generation = cacheStore.generation();
		try {
			let d = await IOUtils.readJSON(this.path);
			// A version bump invalidates everything; the scan is reproducible, so
			// throwing the cache away is always safe.
			if (d && d.version === VERSION && d.entries) {
				this.data = d;
			}
		}
		catch (e) {
			// Missing or corrupt -- start empty rather than fail the build.
		}
		return this;
	}

	/** @returns {?string[]} cached URIs, or null on a miss/stale entry */
	get(attKey, stamp) {
		let e = this.data.entries[attKey];
		return e && e.stamp === stamp ? e.uris : null;
	}

	set(attKey, stamp, uris) {
		this.data.entries[attKey] = { stamp, uris };
		this.dirty = true;
	}

	async flush() {
		if (!this.dirty) return;
		// Loaded before the cache was cleared: writing back would undo the
		// clear. See cacheStore.js.
		if (this.generation !== cacheStore.generation()) {
			this.dirty = false;
			return;
		}
		try {
			await IOUtils.makeDirectory(this.dir, { ignoreExisting: true });
			await IOUtils.writeJSON(this.path, this.data, { tmpPath: this.path + '.tmp' });
			this.dirty = false;
		}
		catch (e) {
			// A cache that cannot be written is a performance problem, not a
			// correctness one.
			Zotero.logError(e);
		}
	}

	get size() {
		return Object.keys(this.data.entries).length;
	}
}

module.exports = { PdfLinkCache };
