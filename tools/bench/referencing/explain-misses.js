'use strict';

/**
 * Say WHY each missed edge was missed, by asking what signal the citing
 * document actually carried.
 *
 *   node tools/bench/referencing/explain-misses.js --data-dir <dir> --db <copy> \
 *     --key library-key.json [--json run.json] [--out misses.md]
 *
 * `score-library.js` says a strategy missed 200 edges. That number cannot be
 * acted on, because it merges two populations that need opposite work:
 *
 *   the signal was NOT THERE -- the cited work's DOI is nowhere in the file and
 *       its title is nowhere in the text. No amount of parsing recovers it, and
 *       the honest response is to stop counting it against the strategies.
 *   the signal WAS there and we dropped it -- the DOI is in the PDF's links, or
 *       in the text but outside the section we cut; the title is in the text but
 *       outside the section, or inside it and below a threshold. Every one of
 *       these is a bug with an address.
 *
 * So for each missed edge this looks for the target's DOI and title in the
 * citing document at four widening scopes -- link annotations, the reference
 * section, the whole text -- and reports the narrowest place the evidence was
 * found. The buckets ARE the fix list, in priority order by size.
 */

const fs = require('fs');
const path = require('path');
const { LocalSqliteAdapter } = require('../../../addon/citation-graph/adapters/localSqlite');
const cg = require('../../../addon/citation-graph/index');
const { segment } = require('../../../addon/citation-graph/edges/refSection');
const { findDois, normTitle } = require('../../../addon/citation-graph/core/normalize');
const locatorMatch = require('../../../addon/citation-graph/edges/locatorMatch');
const { buildWorks } = require('./libraryWorks');

function parseArgs(argv) {
	const a = { dataDir: null, db: null, key: null, enable: null, out: null, limit: 0 };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i], next = () => argv[++i];
		if (k === '--data-dir') a.dataDir = next();
		else if (k === '--db') a.db = next();
		else if (k === '--key') a.key = next();
		else if (k === '--enable') a.enable = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--out') a.out = next();
		else if (k === '--limit') a.limit = Number(next());
	}
	return a;
}

/**
 * The buckets, narrowest evidence first. Order matters: an edge is reported in
 * the FIRST bucket whose evidence is present, so `linkPresent` beating
 * `sectionDoi` says the strongest signal available was a hyperlink -- which is
 * the one that should have been easiest to catch.
 */
const BUCKETS = [
	['linkPresent', 'the DOI is in the PDF\'s link annotations — pdf-links should have had it'],
	['sectionDoi', 'the DOI is printed inside the reference section — text-doi should have had it'],
	['textDoiOutsideSection', 'the DOI is in the text but OUTSIDE the section we cut — segmentation scope'],
	['sectionTitle', 'the title is inside the section — title-match should have had it'],
	['textTitleOutsideSection', 'the title is in the text but outside the section — segmentation scope'],
	['sectionLocator', 'the journal, volume and page are in the section — locator-match should have had it'],
	['textLocatorOutsideSection', 'the locator is in the text but OUTSIDE the section we cut — segmentation scope'],
	['noLocatorMetadata', 'the reference names no DOI or title, and the LIBRARY\'s own record has no volume or pages to match it by'],
	['noSection', 'the splitter found no reference section in this document'],
	['noText', 'the PDF yielded no text'],
	['noPdf', 'the citing work has no PDF'],
	['absent', 'neither the DOI, the title nor a locator occurs anywhere in the document'],
];

async function main() {
	const args = parseArgs(process.argv);
	if (!args.dataDir || !args.key) {
		console.log('usage: explain-misses.js --data-dir <dir> --key <library-key.json> [--db <copy>] [--out <file.md>]');
		process.exit(1);
	}

	const key = JSON.parse(fs.readFileSync(args.key, 'utf8'));
	const adapter = new LocalSqliteAdapter({ dataDir: args.dataDir, dbPath: args.db || undefined });
	const items = await adapter.listItems();
	const { works, keyToWork } = buildWorks(items);

	const truth = new Set();
	for (const [id, s] of Object.entries(key.sources)) {
		if (!s.covered) continue;
		for (const t of s.internalTargets || []) if (works.has(t)) truth.add(id + ' -> ' + t);
	}

	const byItemKey = new Map(items.map((it) => [it.key, it]));
	const locatorOpts = (cg.listStrategies().find((s) => s.id === 'locator-match') || {}).options || {};

	const ids = args.enable || cg.listStrategies().filter((p) => !p.requiresNetwork).map((p) => p.id);
	const built = await cg.build(adapter, { enable: ids, includeExternal: true });
	const drawn = new Set();
	for (const e of built.edges) {
		const from = keyToWork.get(e.from), to = keyToWork.get(e.to);
		if (from && to && from !== to) drawn.add(from + ' -> ' + to);
	}
	const missed = [...truth].filter((k) => !drawn.has(k));
	console.log(truth.size, 'edges in the key ·', truth.size - missed.length, 'drawn ·', missed.length, 'missed');

	// One pass over each citing work that owns a miss, since the expensive part
	// (reading the PDF, extracting text, segmenting) is per document and the
	// misses cluster heavily on a few heavily-citing papers.
	const bySource = new Map();
	for (const k of missed) {
		const [from, to] = k.split(' -> ');
		if (!bySource.has(from)) bySource.set(from, []);
		bySource.get(from).push(to);
	}

	const counts = Object.fromEntries(BUCKETS.map(([b]) => [b, 0]));
	const detail = [];
	let n = 0;
	for (const [from, targets] of bySource) {
		if (++n % 20 === 0) console.log(' ', n, '/', bySource.size, 'citing works examined');
		const w = works.get(from);
		const evidence = await documentEvidence(adapter, w);
		for (const to of targets) {
			const t = works.get(to);
			const b = classify(evidence, t, t.itemKeys.map((k) => byItemKey.get(k)).filter(Boolean), locatorOpts);
			counts[b]++;
			detail.push({ from, to, bucket: b, targetDoi: t.doi, targetTitle: t.title,
				quality: evidence.quality });
		}
	}

	const L = [];
	L.push('# Why the missed edges were missed');
	L.push('');
	L.push('Generated by `npm run bench-ref:misses`. Each edge in the Crossref key that the');
	L.push('offline union did not draw, filed under the **narrowest place its evidence was');
	L.push('found** in the citing document.');
	L.push('');
	L.push('The first seven buckets are signal the document carried and we did not use —');
	L.push('each one is a bug with an address, and the count is how much it is worth. The');
	L.push('last four are edges no offline strategy can reach: there is no PDF, no text in');
	L.push('it, no reference section to be found, or the citation itself names the work in');
	L.push('a way the page never prints.');
	L.push('');
	L.push('| bucket | edges | what it means |');
	L.push('|---|---|---|');
	for (const [b, why] of BUCKETS) L.push('| `' + b + '` | ' + counts[b] + ' | ' + why + ' |');
	L.push('');
	const recoverable = counts.linkPresent + counts.sectionDoi + counts.textDoiOutsideSection
		+ counts.sectionTitle + counts.textTitleOutsideSection + counts.sectionLocator
		+ counts.textLocatorOutsideSection;
	L.push('**' + recoverable + ' of ' + missed.length + ' missed edges have evidence in the document.**');
	L.push('The rest need a PDF, a text layer, or a citation the document never printed.');
	L.push('');
	L.push('## The edges');
	L.push('');
	L.push('| citing | cited | bucket | section | cited DOI |');
	L.push('|---|---|---|---|---|');
	const rows = args.limit ? detail.slice(0, args.limit) : detail;
	for (const d of rows) {
		L.push('| `' + d.from + '` | `' + d.to + '` | `' + d.bucket + '` | ' + (d.quality || '—')
			+ ' | ' + (d.targetDoi || '—') + ' |');
	}
	L.push('');

	const out = L.join('\n') + '\n';
	if (args.out) { fs.writeFileSync(args.out, out); console.log('wrote', args.out); }
	console.log('');
	for (const [b] of BUCKETS) console.log('  ', String(counts[b]).padStart(5), b);
	console.log('  ', String(recoverable).padStart(5), 'RECOVERABLE (evidence present)');
}

/** Everything one citing document carries, read once. */
async function documentEvidence(adapter, work) {
	const ev = { hasPdf: false, hasText: false, quality: null,
		linkDois: new Set(), textDois: new Set(), sectionDois: new Set(),
		normText: '', normSection: '' };
	for (const itemKey of work.itemKeys) {
		for (const att of await adapter.getAttachments(itemKey)) {
			if (att.contentType !== 'application/pdf') continue;
			ev.hasPdf = true;
			for (const u of await adapter.getPdfLinkUris(att.key)) {
				for (const d of findDois(u)) ev.linkDois.add(d);
			}
			const text = await adapter.getAttachmentText(att.key);
			if (!text) continue;
			ev.hasText = true;
			for (const d of findDois(text)) ev.textDois.add(d);
			ev.normText += ' ' + normTitle(text);
			const seg = segment(text);
			const rank = { heading: 3, numbered: 2, tail: 1, none: 0 };
			if (!ev.quality || rank[seg.quality] > rank[ev.quality]) ev.quality = seg.quality;
			if (seg.quality !== 'none') {
				for (const d of findDois(seg.flat)) ev.sectionDois.add(d);
				ev.normSection += ' ' + normTitle(seg.flat);
			}
		}
	}
	if (ev.hasPdf && !ev.quality) ev.quality = 'none';
	return ev;
}

function classify(ev, target, targetItems, locatorOpts) {
	if (!ev.hasPdf) return 'noPdf';
	if (!ev.hasText) return 'noText';
	const doi = target.doi;
	if (doi && ev.linkDois.has(doi)) return 'linkPresent';
	if (doi && ev.sectionDois.has(doi)) return 'sectionDoi';
	if (doi && ev.textDois.has(doi)) return 'textDoiOutsideSection';
	// A title only counts as evidence when it is long enough to be an identity
	// on its own -- the same floor title-match applies, so this never reports a
	// signal the strategy was right to ignore.
	const nt = normTitle(target.title);
	if (nt.length >= 30) {
		if (ev.normSection.includes(nt)) return 'sectionTitle';
		if (ev.normText.includes(nt)) return 'textTitleOutsideSection';
	}
	// The locator, asked with the strategy's own index and scan rather than a
	// second copy of its rule. Two different answers hide under a missing
	// locator and they belong to different people: a reference we failed to
	// read is ours to fix, and a library record with no volume or pages in it
	// is the user's -- no strategy can match a coordinate the library does not
	// know. Only the first is a defect in this code.
	const index = locatorMatch.locatorIndex(targetItems);
	if (index.size) {
		if (locatorMatch.scanLocators(ev.normSection, index, locatorOpts, null).length) return 'sectionLocator';
		if (locatorMatch.scanLocators(ev.normText, index, locatorOpts, null).length) return 'textLocatorOutsideSection';
	}
	if (ev.quality === 'none') return 'noSection';
	if (!index.size && !doi) return 'noLocatorMetadata';
	return 'absent';
}

main().catch((e) => { console.error(e); process.exit(1); });
