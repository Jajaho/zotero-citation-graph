'use strict';

/**
 * Regenerate `external-refs.json` -- the tier-2 reference set -- from Crossref.
 *
 *   node tools/accuracy/build-external.js            (uses the cache if present)
 *   node tools/accuracy/build-external.js --refetch  (ignore the cache)
 *
 * Tier 1 (`ground-truth.json`) is the 29 in-collection edges, read by hand out
 * of the citing PDFs. It is small enough to be exhaustive and strong enough to
 * call a strategy wrong.
 *
 * Tier 2 is everything those papers cite and the collection does NOT hold --
 * 809 external DOIs. Reading 809 references by hand was not on, so this is
 * machine-built from **Crossref's deposited reference lists**: the publisher's
 * own deposit for each citing DOI. Crossref is not one of the graded strategies
 * (the graded network strategy is OpenAlex), so the set stays independent of
 * what it measures -- the same rule tier 1 follows.
 *
 * What that buys, and what it does not:
 *
 *   PRESENCE is reliable. If Crossref says A cites DOI X, A cites X.
 *   ABSENCE IS NOT. A publisher deposits what it deposits. barry2016 prints 75
 *   numbered references and Crossref holds 59 of them, so a third of that
 *   paper's real citations are missing from this set through no fault of any
 *   strategy.
 *
 * So recall against this set is a true lower bound, and an emitted DOI that is
 * not in it is reported as UNCONFIRMED and never as a false positive. Only two
 * things here are graded as defects, both provable without Crossref being
 * complete:
 *
 *   suffix-artifact -- stripping a URL tail (/abstract, /epdf, ...) turns the
 *                      emitted string into a DOI that IS in the set, so the
 *                      emitted one is a phantom and the real one was missed.
 *   truncated       -- the emitted DOI is a strict prefix of one in the set,
 *                      so it was cut short (old Wiley DOIs carry <...> which
 *                      the DOI pattern stops at).
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'external-refs.json');
const CACHE = path.join(__dirname, '.crossref-cache');
const GT = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground-truth.json'), 'utf8'));
const UA = 'zotero-citation-graph accuracy benchmark (https://github.com/Jajaho/zotero-citation-graph)';

/**
 * Crossref stores a DOI's angle brackets HTML-escaped -- the legacy Wiley DOI
 * 10.1002/...181:1<99::AID-PSSA99>3.0.CO;2-5 comes back with &lt; and &gt; in
 * it. The DOI itself has the literal characters, so they are decoded here;
 * otherwise the key disagrees with every correct extractor on exactly the DOIs
 * this benchmark exists to catch.
 */
const unescapeEntities = (s) => String(s)
	.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');

const norm = (d) => unescapeEntities(String(d || ''))
	.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');

async function main() {
	const refetch = process.argv.includes('--refetch');
	fs.mkdirSync(CACHE, { recursive: true });

	const held = new Set(GT.works.map((w) => w.doi).filter(Boolean).map(norm));
	const sources = {};
	let totalRefs = 0, totalExternal = 0;

	for (const w of GT.works) {
		if (!w.doi) { sources[w.id] = { doi: null, covered: false, reason: 'no DOI - not resolvable in Crossref' }; continue; }
		const file = path.join(CACHE, w.id + '.json');
		if (refetch || !fs.existsSync(file)) {
			const res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(w.doi),
				{ headers: { 'User-Agent': UA } });
			if (!res.ok) {
				sources[w.id] = { doi: w.doi, covered: false, reason: 'Crossref HTTP ' + res.status };
				console.log(w.id.padEnd(13), 'HTTP', res.status);
				await sleep(1200);
				continue;
			}
			fs.writeFileSync(file, await res.text());
			await sleep(1200);
		}
		const msg = JSON.parse(fs.readFileSync(file, 'utf8')).message;
		const refs = msg.reference || [];
		const externalDois = [...new Set(
			refs.map((r) => norm(r.DOI)).filter((d) => d && !held.has(d))
		)].sort();
		// Titles, for scoring the `ref:` nodes that carry no identifier at all.
		const titles = refs
			.map((r) => r['article-title'] || r['volume-title'] || r.unstructured || null)
			.filter(Boolean);
		sources[w.id] = {
			doi: norm(w.doi),
			covered: true,
			crossrefRefCount: refs.length,
			refsWithDoi: refs.filter((r) => r.DOI).length,
			externalDoiCount: externalDois.length,
			externalDois,
			referenceTitles: titles,
		};
		totalRefs += refs.length;
		totalExternal += externalDois.length;
		console.log(w.id.padEnd(13), 'refs', String(refs.length).padStart(4),
			'external', String(externalDois.length).padStart(4));
	}

	const out = {
		_comment: 'Tier-2 reference set for the accuracy benchmark: everything the collection cites and does NOT hold. Machine-built from Crossref deposited reference lists; regenerate with `node tools/accuracy/build-external.js`. Tier 1 (ground-truth.json) is the hand-read in-collection core and is the authority on those 29 edges.',
		_provenance: 'Crossref REST, one request per citing DOI. Crossref is deliberately NOT one of the graded strategies, so this set is independent of what it measures - the same rule ground-truth.json follows about never being built from OpenAlex.',
		_presenceIsReliableAbsenceIsNot: 'If Crossref says A cites X, A cites X. The converse does NOT hold: publishers deposit incomplete lists. barry2016 prints 75 numbered references and Crossref holds 59. So recall computed against this set is a LOWER BOUND, and an emitted DOI absent from it is reported as UNCONFIRMED, never as a false positive.',
		_whatIsGradedAsWrong: 'Only two things, both provable despite the incompleteness: suffix-artifact (stripping /abstract, /epdf, /full, /pdf, /meta, /html yields a DOI that IS in the set) and truncated (the emitted DOI is a strict prefix of one in the set). Both mean the strategy minted a ghost node for a work that does not exist under that identifier.',
		fetchedOn: new Date().toISOString().slice(0, 10),
		totals: { crossrefReferences: totalRefs, externalDois: totalExternal },
		sources,
	};
	fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
	console.log('\nwrote', path.relative(process.cwd(), OUT),
		'-', totalExternal, 'external DOIs from', totalRefs, 'deposited references');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => { console.error(e); process.exit(1); });
