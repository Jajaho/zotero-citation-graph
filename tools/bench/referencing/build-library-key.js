'use strict';

/**
 * Build a Crossref answer key for a WHOLE Zotero library.
 *
 *   node tools/bench/referencing/build-library-key.js --data-dir "C:/Users/me/Zotero" \
 *     --db ./lib.sqlite --cache <dir> --out library-key.json
 *
 * `build-external.js` does this for the 14-work curated collection, whose
 * in-collection edges are already known by hand. Here nothing is known by hand,
 * so Crossref has to supply BOTH halves:
 *
 *   internal -- a deposited reference whose DOI the library also holds. These
 *               are the edges the graph is supposed to draw, and the only ones
 *               a precision/recall figure can be computed against.
 *   external -- a deposited reference the library does not hold. The ghost
 *               nodes, measured exactly as tier 2 measures them.
 *
 * The honesty caveat is the same one, and it matters more here because there is
 * no hand-read key underneath to catch it:
 *
 *   PRESENCE IS RELIABLE, ABSENCE IS NOT. A publisher deposits what it
 *   deposits. Roughly a fifth of journal articles have no deposited list at
 *   all, and plenty of the rest are partial. So a predicted edge Crossref does
 *   not list is UNCONFIRMED, not false -- except where the citing work has a
 *   list that is demonstrably complete enough to argue with, which is what
 *   `covered` and `crossrefRefCount` are recorded for.
 *
 * One request per held DOI, cached on disk, so a re-run costs nothing and the
 * key is rebuildable byte-for-byte rather than being whatever Crossref returns
 * today. The cache defaults outside the repo: it is a few hundred megabytes of
 * one person's library and has no business in git.
 */

const fs = require('fs');
const path = require('path');
const { LocalSqliteAdapter } = require('../../../addon/citation-graph/adapters/localSqlite');
const { normDoi, buildWorks } = require('./libraryWorks');

const UA = 'zotero-citation-graph accuracy benchmark (https://github.com/Jajaho/zotero-citation-graph)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Crossref HTML-escapes a DOI's angle brackets; the DOI itself has the literals. */
const unescapeEntities = (s) => String(s)
	.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
const norm = (d) => normDoi(unescapeEntities(String(d || '')));

function parseArgs(argv) {
	const a = { dataDir: null, db: null, cache: null, out: null, refetch: false, delay: 900 };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i], next = () => argv[++i];
		if (k === '--data-dir') a.dataDir = next();
		else if (k === '--db') a.db = next();
		else if (k === '--cache') a.cache = next();
		else if (k === '--out') a.out = next();
		else if (k === '--delay') a.delay = Number(next());
		else if (k === '--refetch') a.refetch = true;
	}
	return a;
}

async function main() {
	const args = parseArgs(process.argv);
	if (!args.dataDir || !args.out || !args.cache) {
		console.log('usage: build-library-key.js --data-dir <dir> --cache <dir> --out <file.json> [--db <copy>] [--refetch]');
		process.exit(1);
	}
	fs.mkdirSync(args.cache, { recursive: true });

	const adapter = new LocalSqliteAdapter({ dataDir: args.dataDir, dbPath: args.db || undefined });
	const items = await adapter.listItems();
	const { works, doiToWork } = buildWorks(items);

	const withDoi = [...works.values()].filter((w) => w.doi);
	console.log('library:', items.length, 'items ->', works.size, 'works,', withDoi.length, 'with a DOI');

	const sources = {};
	let covered = 0, noDeposit = 0, failed = 0, totalRefs = 0, totalInternal = 0, totalExternal = 0;
	let n = 0;

	for (const w of withDoi) {
		n++;
		const file = path.join(args.cache, encodeURIComponent(w.doi) + '.json');
		if (args.refetch || !fs.existsSync(file)) {
			let res;
			try {
				res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(w.doi),
					{ headers: { 'User-Agent': UA } });
			}
			catch (e) {
				sources[w.id] = { doi: w.doi, covered: false, reason: 'fetch failed: ' + e.message };
				failed++; console.log(String(n).padStart(4), w.doi, 'FETCH FAILED'); await sleep(args.delay); continue;
			}
			if (!res.ok) {
				// 404 is the common one and is information, not an error: the DOI
				// is registered somewhere that is not Crossref (DataCite, a
				// publisher's own) or the record is wrong in the library.
				sources[w.id] = { doi: w.doi, covered: false, reason: 'Crossref HTTP ' + res.status };
				failed++;
				console.log(String(n).padStart(4), w.doi, 'HTTP', res.status);
				await sleep(args.delay);
				continue;
			}
			fs.writeFileSync(file, await res.text());
			await sleep(args.delay);
		}

		let msg;
		try { msg = JSON.parse(fs.readFileSync(file, 'utf8')).message; }
		catch (e) { sources[w.id] = { doi: w.doi, covered: false, reason: 'unparseable cache' }; failed++; continue; }

		const refs = msg.reference || [];
		if (!refs.length) {
			// A record with no deposited list can neither confirm nor deny an
			// edge, so it is excluded from grading rather than counted as a work
			// that cites nothing -- which is what would silently turn every true
			// edge out of it into a false positive.
			sources[w.id] = { doi: w.doi, covered: false, reason: 'no deposited reference list',
				crossrefRefCount: 0, type: msg.type || null };
			noDeposit++;
			continue;
		}

		const refDois = [...new Set(refs.map((r) => norm(r.DOI)).filter(Boolean))];
		const internal = [], external = [];
		for (const d of refDois) {
			const target = doiToWork.get(d);
			if (target && target !== w.id) internal.push(target);
			else if (!target) external.push(d);
		}
		const titles = refs
			.map((r) => r['article-title'] || r['volume-title'] || r.unstructured || null)
			.filter(Boolean);

		sources[w.id] = {
			doi: w.doi,
			covered: true,
			type: msg.type || null,
			crossrefRefCount: refs.length,
			refsWithDoi: refs.filter((r) => r.DOI).length,
			internalTargets: [...new Set(internal)].sort(),
			externalDois: [...new Set(external)].sort(),
			referenceTitles: titles,
		};
		covered++;
		totalRefs += refs.length;
		totalInternal += new Set(internal).size;
		totalExternal += new Set(external).size;
		if (n % 25 === 0) console.log(String(n).padStart(4), '/', withDoi.length, '·', covered, 'covered');
	}

	const out = {
		_comment: 'Crossref answer key for a whole Zotero library. Both halves come from publishers deposited reference lists: internalTargets are references the library also holds (the edges the graph should draw), externalDois are the ones it does not.',
		_presenceIsReliableAbsenceIsNot: 'If Crossref says A cites X, A cites X. The converse does NOT hold: publishers deposit incomplete lists, and works with no list at all are marked covered:false and excluded from grading entirely. Recall is therefore a LOWER BOUND and a predicted edge absent from the key is UNCONFIRMED rather than false.',
		fetchedOn: new Date().toISOString().slice(0, 10),
		library: { items: items.length, works: works.size, worksWithDoi: withDoi.length },
		totals: {
			covered, noDeposit, failed,
			crossrefReferences: totalRefs,
			internalEdges: totalInternal,
			externalDois: totalExternal,
		},
		sources,
	};
	fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
	console.log('\nwrote', args.out);
	console.log(' covered', covered, '· no deposit', noDeposit, '· failed', failed);
	console.log(' internal edges', totalInternal, '· external DOIs', totalExternal,
		'· from', totalRefs, 'deposited references');
}

main().catch((e) => { console.error(e); process.exit(1); });
