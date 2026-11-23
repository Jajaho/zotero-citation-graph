'use strict';

const { register } = require('../core/enrichRegistry');
const { normDoi } = require('../core/normalize');

/**
 * Enricher: OpenAlex /works.
 *
 * Chosen as the first one because a single list call answers all three
 * questions we have about a cited work -- what is it called, who wrote it, and
 * how often is it cited -- in one response:
 *
 *   filter=doi:a|b|...  select=id,doi,display_name,publication_year,
 *                              authorships,cited_by_count,type,primary_location
 *
 * 50 DOIs per call. The sample library's 4,564 ghost DOIs are 92 calls; at
 * $0.0001 a list request, as the response headers price one in November 2026,
 * that is under a cent, inside even the keyless daily allowance of $0.10 --
 * when nobody else on the network has spent it. See httpError().
 *
 * AUTH, as of 13 Feb 2026: `mailto` and the polite pool are gone -- the
 * parameter is ignored by the server -- and requests are billed against an API
 * key. Keyless access still works at roughly a tenth of the daily budget, which
 * is why this is usable with no configuration at all. The key travels in an
 * Authorization header rather than the query string so it stays out of URLs,
 * logs and thrown error messages.
 */
// Failed requests in a row before the rest are not sent.
const GIVE_UP_AFTER = 2;

module.exports.id = register({
	id: 'openalex',
	label: 'OpenAlex (names + citation counts)',
	requiresNetwork: true,
	defaultEnabled: false,
	supports: ['doi', 'openalex'],
	options: {
		apiKey: null,
		batchSize: 50,
		endpoint: 'https://api.openalex.org/works',
		// Injected so the caller can supply a host-appropriate transport --
		// Zotero.HTTP.request honours the client's proxy and offline settings,
		// where bare fetch does not -- and so the tests can run without network.
		fetchImpl: null,
	},

	async resolve({ refs, options, signal, onProgress }) {
		const fetch_ = options.fetchImpl || globalThis.fetch;
		if (typeof fetch_ !== 'function') throw new Error('no fetch implementation available');

		// OpenAlex filters by bare DOI but returns it as a resolver URL, so both
		// directions go through normDoi and the round trip stays lossless.
		const byFilterValue = new Map();
		for (const r of refs) {
			if (r.ns === 'doi') {
				const d = normDoi(r.id);
				if (d) byFilterValue.set('doi:' + d, r.key);
			}
			else if (r.ns === 'openalex') {
				byFilterValue.set('openalex:' + shortOpenAlexId(r.id), r.key);
			}
		}
		const values = [...byFilterValue.keys()];
		if (!values.length) return [];

		const headers = { Accept: 'application/json' };
		if (options.apiKey) headers.Authorization = 'Bearer ' + options.apiKey;

		const out = [];
		// A request that fails costs its own batch and no other. Thrown from the
		// loop, one 429 on the third of ten requests took the first two with it:
		// nothing was named, nothing reached the cache, and the next build asked
		// for all of it again. So the failure is kept and the run goes on -- past
		// one bad batch, because a DOI the filter cannot take must not starve the
		// batches behind it, and no further than two in a row, because by then it
		// is the service and not the batch. What was answered is handed back on
		// the error (see the end), which core/enrich.js merges before reporting.
		let failure = null;
		let failedInARow = 0;
		batches:
		for (let i = 0; i < values.length; i += options.batchSize) {
			if (signal && signal.aborted) break;
			const batch = values.slice(i, i + options.batchSize);

			// One filter key per namespace: OpenAlex ORs values within a key with
			// '|' but ANDs across keys, so mixing doi: and openalex: into a single
			// filter would ask for works that are both at once and return nothing.
			const byNs = new Map();
			for (const v of batch) {
				const c = v.indexOf(':');
				const ns = v.slice(0, c);
				const id = v.slice(c + 1);
				if (!byNs.has(ns)) byNs.set(ns, []);
				byNs.get(ns).push(id);
			}

			for (const [ns, ids] of byNs) {
				const url = new URL(options.endpoint);
				url.searchParams.set('per-page', String(pageSize(ids.length)));
				url.searchParams.set('select',
					'id,doi,display_name,publication_year,authorships,cited_by_count,type');
				url.searchParams.set('filter',
					(ns === 'doi' ? 'doi:' : 'ids.openalex:') + ids.join('|'));

				let results;
				try {
					results = await fetchWorks(fetch_, url, { headers, signal });
				}
				catch (err) {
					failure = failure || err;
					// A spent allowance or a refused key is the service at the
					// first refusal, not the second: nothing sent after it is
					// answered either.
					if (endsTheAsking(err)) {
						failure = err;
						break batches;
					}
					if (++failedInARow >= GIVE_UP_AFTER) break batches;
					continue;
				}
				failedInARow = 0;
				// By the ID each work came back under, not by the key it was
				// matched to: a work asked for by ID is also filed under its
				// DOI's key when that was asked for too.
				const answered = new Set();
				for (const w of results) {
					if (w && w.id) answered.add(shortOpenAlexId(w.id));
					for (const m of allMetadata(w, byFilterValue)) out.push(m);
				}
				// An OpenAlex ID that OpenAlex itself, asked by that ID, did not
				// return is a work it no longer has a record of -- deleted, or
				// merged away -- that a paper's reference list still points at.
				// Said so, because "not looked up yet" and "looked up and gone"
				// read the same from a missing title, and only the second can
				// never be named or added. A DOI is not judged the same way: it
				// exists whether or not OpenAlex has heard of it.
				if (ns === 'openalex') {
					for (const id of ids) {
						if (!answered.has(id)) out.push({ key: byFilterValue.get('openalex:' + id), gone: true });
					}
				}
			}
			onProgress && onProgress(Math.min(i + options.batchSize, values.length), values.length);
		}
		if (failure) {
			// Whatever was thrown, as something `partial` can ride on.
			const err = Object(failure) === failure ? failure : new Error(String(failure));
			err.partial = out;
			throw err;
		}
		return out;
	},
});

// The most OpenAlex returns in one page.
const MAX_PER_PAGE = 200;
// Pages read for one batch before the rest is left: a guard against a
// response whose count never comes down, not a number anything should reach.
const MAX_PAGES = 5;

/**
 * How many results to ask for when asking about `n` identifiers.
 *
 * Not `n`. OpenAlex holds some works twice -- two records under one DOI -- so
 * fifty DOIs can come back as fifty-one works, and with a page of exactly
 * fifty the last of them was left behind: a DOI that OpenAlex knows, never
 * named. Twice over is room for every one of them to be doubled, and
 * fetchWorks follows the count for whatever is still left.
 */
function pageSize(n) {
	return Math.min(MAX_PER_PAGE, Math.max(2 * n, 1));
}

/**
 * Every work a filter matches, following the pages until the count the first
 * one reported is met. Throws on a response that is not ok: see httpError().
 *
 * @param {URL} url  the request, to which a `page` is added past the first
 * @returns {Promise<Object[]>}
 */
async function fetchWorks(fetch_, url, init) {
	const results = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		if (page > 1) url.searchParams.set('page', String(page));
		const res = await fetch_(url.toString(), init);
		if (!res.ok) throw await httpError(res, init);
		const json = await res.json();
		const got = (json && json.results) || [];
		for (const w of got) results.push(w);
		const total = Number(json && json.meta && json.meta.count);
		if (!got.length || !(total > results.length)) break;
	}
	return results;
}

// What an error says in `code` when it is one a caller can do something about:
// the day's allowance is spent, or the key that was sent is not one OpenAlex
// knows.
const QUOTA = 'quota';
const BAD_KEY = 'key';

/** Whether an error is the service's answer to every request, not to this one. */
function endsTheAsking(err) {
	return !!err && (err.code === QUOTA || err.code === BAD_KEY);
}

/**
 * A response that is not ok, as an error -- and one a caller can act on when
 * what it says is something the user can put right.
 *
 * OpenAlex answers 429 for two things that want opposite handling. Too many
 * requests in one second is over in a second. The daily allowance being spent
 * is over at midnight UTC, and for a caller with no key it is also the one
 * failure the user can end themselves: requests without a key draw on a tenth
 * of a free key's allowance, and share that tenth with everyone behind the
 * same IP address -- a whole campus, often. Both read "OpenAlex 429 Too Many
 * Requests", which told the user nothing a key would have fixed.
 *
 * The body tells them apart with `reason: "daily_budget"`. Read defensively:
 * a body that is not JSON, or one that names no reason, is judged by the
 * allowance the headers report instead, and a 429 that says neither is left
 * as the plain error it always was.
 *
 * `detail.keyless` is whether the request went without a key, which decides
 * what there is to offer; `detail.resetSeconds` is how long until the
 * allowance is whole again, where the response says.
 *
 * The other one is a key that was sent and refused: 401 for a key OpenAlex
 * does not know, 403 for one whose owner has not yet confirmed it. Every
 * request fails the same way until the key is corrected, and "OpenAlex 401
 * Unauthorized" did not say that the key was the thing to look at.
 */
async function httpError(res, init) {
	const err = new Error(`OpenAlex ${res.status} ${res.statusText}`);
	const keyless = !(init && init.headers && init.headers.Authorization);
	const refused = res.status === 401 || res.status === 403;
	if (res.status !== 429 && !(refused && !keyless)) return err;
	let body = null;
	try {
		body = await res.json();
	}
	catch (e) { /* not JSON: the status and the headers are all there is */ }
	const said = name => (body && typeof body[name] === 'string' ? body[name] : '');

	if (refused) {
		// A 403 can be other things than the key; a 401 with one sent cannot.
		if (res.status === 401 || /key/i.test(said('reason') + ' ' + said('error'))) err.code = BAD_KEY;
		return err;
	}

	const header = (name) => {
		try {
			const v = res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
			return v == null || v === '' ? null : Number(v);
		}
		catch (e) {
			return null;
		}
	};
	const reason = said('reason');
	const remaining = header('X-RateLimit-Remaining');
	const spent = reason ? reason === 'daily_budget' : remaining != null && remaining <= 0;
	if (!spent) return err;
	const reset = header('X-RateLimit-Reset');
	err.code = QUOTA;
	err.detail = {
		keyless,
		resetSeconds: Number.isFinite(reset) && reset > 0 ? reset : null,
	};
	return err;
}

/**
 * An OpenAlex work back into the shape core/enrich.js merges. Only the fields
 * we actually know are set: a null lets a later enricher in the chain fill it.
 *
 * Filed under one key: the DOI's when that was asked for, else the OpenAlex
 * ID's. See allMetadata for a work that was asked for both ways.
 */
function toMetadata(w, byFilterValue) {
	return allMetadata(w, byFilterValue)[0] || null;
}

/**
 * The same, once for every key the work was asked by.
 *
 * One work can be two nodes at the time it is asked about: `doi:` from a PDF
 * that links it and `openalex:` from a reference list that names it by ID.
 * Both are in one request, and the answer was filed under the DOI alone. The
 * other node stayed nameless -- and since the name, and the DOI it brings, are
 * what fold the two into one, they stayed two, and the ID was asked about
 * again on every build.
 */
function allMetadata(w, byFilterValue) {
	if (!w) return [];
	const doi = normDoi(w.doi);
	const keys = [];
	const byDoi = doi && byFilterValue.get('doi:' + doi);
	if (byDoi) keys.push(byDoi);
	const byId = w.id && byFilterValue.get('openalex:' + shortOpenAlexId(w.id));
	if (byId && byId !== byDoi) keys.push(byId);
	return keys.map(key => metadataFor(w, key, doi));
}

function metadataFor(w, key, doi) {
	return {
		key,
		title: w.display_name || null,
		creators: (w.authorships || [])
			.map(a => surname(a && a.author && a.author.display_name))
			.filter(Boolean),
		year: w.publication_year != null ? Number(w.publication_year) : null,
		itemType: w.type || null,
		doi: doi || null,
		url: w.id || null,
		// Deliberately NOT called citedBy: externalNodes[].citedBy already means
		// "how many papers in this collection cite it", which is a different
		// number and the one the graph is actually about.
		citedByGlobal: w.cited_by_count != null ? Number(w.cited_by_count) : null,
	};
}

/** 'https://openalex.org/W123' | 'W123' -> 'W123' */
function shortOpenAlexId(id) {
	const s = String(id || '');
	const slash = s.lastIndexOf('/');
	return slash >= 0 ? s.slice(slash + 1) : s;
}

/**
 * OpenAlex gives full display names ("Georg Kucsko"); the rest of the graph
 * labels nodes by surname, so take the last whitespace-separated word. Wrong
 * for a handful of multi-word surnames, and still better than a first name.
 */
function surname(displayName) {
	const parts = String(displayName || '').trim().split(/\s+/);
	return parts.length ? parts[parts.length - 1] : '';
}

module.exports.toMetadata = toMetadata;
module.exports.fetchWorks = fetchWorks;
module.exports.QUOTA = QUOTA;
module.exports.BAD_KEY = BAD_KEY;
module.exports.endsTheAsking = endsTheAsking;
module.exports.pageSize = pageSize;
module.exports.surname = surname;
