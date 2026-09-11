/* global Zotero, IOUtils, PathUtils */

'use strict';

let cacheStore = require('./cacheStore.js');

/**
 * Persistent cache for resolved identifier metadata.
 *
 * Same shape and the same reasoning as pdfLinkCache.js -- a plain JSON file in
 * the data directory, trivially discardable -- but with one difference that
 * matters: a PDF's link annotations only change when the file does, so those
 * entries are stamped and never expire. A citation count changes continuously
 * and nothing local can detect it, so these entries expire on age instead.
 *
 * TTL is deliberately long. A title and an author list are immutable in
 * practice, and a citation count that is a month stale is still the right order
 * of magnitude -- which is all it is ever used for here, since the graph sizes
 * and ranks on the LOCAL count. Re-fetching 900 identifiers to move a number
 * from 1,989 to 1,994 would be a poor trade.
 */

const VERSION = 1;
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TTL = 30 * DAY;

class MetadataCache {
	// `file` lets a second cache of the same kind live beside this one: the
	// OpenAlex strategy keeps its reference lists that way (graphTab.js).
	constructor(dir, { ttl = DEFAULT_TTL, file = cacheStore.FILES.metadata } = {}) {
		this.dir = dir;
		this.ttl = ttl;
		this.path = PathUtils.join(dir, file);
		this.data = { version: VERSION, entries: {} };
		this.dirty = false;
		this.hits = 0;
		this.misses = 0;
		this.generation = cacheStore.generation();
	}

	static forProfile(opts) {
		return new MetadataCache(cacheStore.dir(), opts);
	}

	async load() {
		this.generation = cacheStore.generation();
		try {
			let d = await IOUtils.readJSON(this.path);
			if (d && d.version === VERSION && d.entries) this.data = d;
		}
		catch (e) {
			// Missing or corrupt -- start empty rather than fail the build.
		}
		return this;
	}

	/**
	 * @param {string} key external node key, e.g. 'doi:10.1038/nature12373'
	 * @returns {?import('../citation-graph/core/types').Metadata}
	 */
	get(key) {
		let e = this.data.entries[key];
		if (!e || !e.at || Date.now() - e.at > this.ttl) {
			this.misses++;
			return null;
		}
		this.hits++;
		return e.m;
	}

	set(key, metadata) {
		this.data.entries[key] = { at: Date.now(), m: metadata };
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

module.exports = { MetadataCache };
