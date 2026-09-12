'use strict';

/**
 * Work identity for the whole-library benchmark.
 *
 * The curated collection has a hand-written `ground-truth.json` that names each
 * work (`barry2016`) and lists the item keys that are the same work. A real
 * library has no such file and 406 items, so identity has to be derived:
 *
 *   a work is its normalised DOI, or -- with no DOI -- a slug of its title.
 *
 * That is the same rule the graph builder's own index follows, which matters:
 * scoring must not merge two items the plugin keeps apart, or split two it
 * merges, or the score would be measuring the scorer.
 *
 * DOI first and title only as a fallback, because two records of one paper
 * agree on the DOI far more reliably than on the title (subtitles, casing,
 * trailing periods, LaTeX leftovers), while two genuinely different papers
 * share a DOI never and a short title occasionally -- hence the length floor
 * below, under which a title is not allowed to be an identity at all.
 */

const MIN_SLUG = 20;

const normDoi = (d) => String(d || '')
	.trim().toLowerCase()
	.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
	.replace(/^doi:\s*/, '')
	.replace(/[.,;)\]]+$/, '');

const slug = (t) => String(t || '')
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, ' ')
	.trim()
	.replace(/\s+/g, '-');

/** A DOI Crossref could plausibly resolve. Guards against `10.` typos and URLs. */
const looksLikeDoi = (d) => /^10\.\d{4,9}\/\S+$/.test(normDoi(d));

/**
 * Group the library's items into works.
 *
 * @param {Array} items  adapter.listItems() output
 * @returns {{works: Map<string,Object>, keyToWork: Map<string,string>, doiToWork: Map<string,string>}}
 */
function buildWorks(items) {
	const works = new Map();
	const keyToWork = new Map();
	const doiToWork = new Map();

	for (const it of items) {
		const doi = it.doi && looksLikeDoi(it.doi) ? normDoi(it.doi) : null;
		const s = slug(it.title);
		// No DOI and no usable title: the item cannot be an identity, so it is
		// left out of the work set entirely rather than given a made-up one that
		// would collide with every other short-titled item.
		const id = doi || (s.length >= MIN_SLUG ? 'title:' + s : null);
		if (!id) continue;
		let w = works.get(id);
		if (!w) {
			w = { id, doi, title: it.title, itemKeys: [], itemTypes: [], hasPdf: false, year: null };
			works.set(id, w);
		}
		w.itemKeys.push(it.key);
		if (!w.itemTypes.includes(it.itemType)) w.itemTypes.push(it.itemType);
		if (!w.year) {
			const m = /(1[5-9]\d\d|20[0-4]\d)/.exec(String(it.date || ''));
			if (m) w.year = Number(m[1]);
		}
		keyToWork.set(it.key, id);
		if (doi) doiToWork.set(doi, id);
	}
	return { works, keyToWork, doiToWork };
}

module.exports = { normDoi, slug, looksLikeDoi, buildWorks, MIN_SLUG };
