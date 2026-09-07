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
		/** @type {{key:string,nt:string,year:?number,surname:string}[]} */
		this.titleTargets = [];
		/** Secondary identifier maps, filled in by identity providers. */
		this.byExternalId = new Map(); // "openalex:W123" | "arxiv:2101.00001" -> key

		for (const it of items) {
			this.byKey.set(it.key, it);
			const d = normDoi(it.doi);
			if (d) this.byDoi.set(d, it.key);
			const nt = normTitle(it.title);
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
			externalIndexed: this.byExternalId.size,
		};
	}
}

module.exports = { CollectionIndex };
