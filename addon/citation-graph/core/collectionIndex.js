'use strict';

const { normDoi, normTitle, firstYear } = require('./normalize');

/**
 * The lookup structure every provider intersects against. Built once per graph
 * build and passed to all providers, so the cost of identity resolution is paid
 * a single time no matter how many strategies are enabled.
 *
 * This is the piece that answers the core requirement: "if a paper cites a
 * paper already in the collection, show the existing node." A provider turns a
 * reference into whatever identifier it can (DOI, OpenAlex ID, title string)
 * and asks the index whether the collection already holds it.
 */
class CollectionIndex {
	constructor(items, { minTitleLength = 30 } = {}) {
		this.items = items;
		this.minTitleLength = minTitleLength;
		this.byKey = new Map();
		this.byDoi = new Map();
		/** Item key -> its normalized DOI, for sameWork(). */
		this.doiOf = new Map();
		/**
		 * Exact normalized title -> item key.
		 *
		 * Distinct from titleTargets, which exists to be SEARCHED FOR inside a
		 * blob of reference text. This answers the opposite question -- "here is
		 * a title I parsed out of one reference, do you hold it?" -- which is a
		 * lookup rather than a scan, and is what lets a per-entry strategy pay
		 * O(1) where title-match pays a pass over the section.
		 */
		this.byTitle = new Map();
		/** @type {{key:string,nt:string,year:?number,surname:string}[]} */
		this.titleTargets = [];
		/** Secondary identifier maps, filled in by identity providers. */
		this.byExternalId = new Map(); // "openalex:W123" | "arxiv:2101.00001" -> key

		for (const it of items) {
			this.byKey.set(it.key, it);
			const d = normDoi(it.doi);
			// First holder wins, as for byTitle below. A library can hold one
			// work twice -- the same DOI on two items -- and with the last one
			// winning here and the first one winning there, a reference that
			// printed both its DOI and its title drew an edge to each copy.
			if (d) {
				if (!this.byDoi.has(d)) this.byDoi.set(d, it.key);
				this.doiOf.set(it.key, d);
			}
			const nt = normTitle(it.title);
			// Indexed at any length, unlike titleTargets: minTitleLength guards a
			// SUBSTRING search, where a short title collides with the text around
			// it. An exact-equality lookup has no such failure mode, and the
			// short titles are exactly the ones title-match cannot reach.
			if (nt && !this.byTitle.has(nt)) this.byTitle.set(nt, it.key);
			if (nt.length >= minTitleLength) {
				this.titleTargets.push({
					key: it.key,
					nt,
					year: firstYear(it.date),
					surname: normTitle((it.creators || [])[0] || ''),
				});
			}
		}
		// Longest first: prevents a short title that is a prefix of a longer one
		// from stealing the match.
		this.titleTargets.sort((a, b) => b.nt.length - a.nt.length);
	}

	/** @returns {?string} item key */
	lookupDoi(raw) {
		const d = normDoi(raw);
		return d ? this.byDoi.get(d) || null : null;
	}

	/**
	 * Are these two held items one work?
	 *
	 * Two items carrying the same DOI are two copies of one paper. lookupDoi
	 * can only answer with one of them, so every "is this DOI my own" test that
	 * compared its answer to the citing item's key failed for the other copy:
	 * its own DOI, printed in its own page footer, read as a citation of its
	 * twin. Nothing but the DOI is taken as proof -- two items that merely
	 * share a title are two items.
	 */
	sameWork(a, b) {
		if (a === b) return true;
		const d = this.doiOf.get(a);
		return !!d && d === this.doiOf.get(b);
	}

	/**
	 * The item a citation of `key` is drawn to: itself, unless an earlier item
	 * holds the same DOI, and then that one. Anything else -- an outside key,
	 * an item with no DOI -- is its own.
	 */
	canonical(key) {
		const d = this.doiOf.get(key);
		return d ? this.byDoi.get(d) : key;
	}

	/** @param {string} raw a title as printed @returns {?string} item key */
	lookupTitle(raw) {
		const nt = normTitle(raw);
		return nt ? this.byTitle.get(nt) || null : null;
	}

	/** @param {string} ns e.g. 'openalex' @returns {?string} item key */
	lookupExternal(ns, id) {
		return this.byExternalId.get(ns + ':' + id) || null;
	}

	setExternal(ns, id, itemKey) {
		this.byExternalId.set(ns + ':' + id, itemKey);
	}

	get size() {
		return this.items.length;
	}

	stats() {
		return {
			items: this.items.length,
			doiIndexed: this.byDoi.size,
			titleIndexed: this.titleTargets.length,
			titleExact: this.byTitle.size,
			externalIndexed: this.byExternalId.size,
		};
	}
}

module.exports = { CollectionIndex };
