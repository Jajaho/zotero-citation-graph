'use strict';

/**
 * Score the edge strategies against a WHOLE Zotero library, with Crossref's
 * deposited reference lists as the answer key.
 *
 *   node tools/bench/referencing/score-library.js --data-dir "C:/Users/me/Zotero" \
 *     --db ./lib.sqlite --key library-key.json --report REPORT-library.md
 *
 * `score.js` grades against a 14-work collection whose in-collection edges were
 * read by hand. This grades against 400-odd works nobody has read, which buys
 * scale and costs certainty -- so the two numbers it reports are deliberately
 * different in kind:
 *
 *   recall     is honest and is the number to optimise. Crossref listing an
 *              edge the strategies missed is a miss, full stop.
 *   precision  is NOT, and is reported as `susp` (suspect) rather than FP. A
 *              predicted edge Crossref does not list may be a real citation
 *              from an incomplete deposit. Works with no deposited list at all
 *              are excluded from grading on both sides, which is the only way
 *              to stop their true edges from being scored as false ones.
 *
 * The point of the run is the DIAGNOSTICS, not the table: a miss is classified
 * by how far down the pipeline it got -- no PDF, no text, no reference section,
 * section found but nothing extracted -- because those four buckets need four
 * different fixes and a single recall figure hides which one to work on.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { LocalSqliteAdapter } = require('../../../addon/citation-graph/adapters/localSqlite');
const cg = require('../../../addon/citation-graph/index');
const { segment } = require('../../../addon/citation-graph/edges/refSection');
const { normDoi, buildWorks } = require('./libraryWorks');

const SUFFIX_RE = /\/(abstract|epdf|full|pdf|meta|html)$/;

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const pct = (x) => (x * 100).toFixed(0) + '%';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const ms = (n) => (n == null ? '-' : n < 10000 ? n + 'ms' : (n / 1000).toFixed(1) + 's');

function sh(cmd, a) {
	try { return execFileSync(cmd, a, { encoding: 'utf8' }).trim(); } catch (_) { return null; }
}

function parseArgs(argv) {
	const a = { dataDir: null, db: null, key: null, enable: null, report: null, json: null,
		baseline: null, overwrite: false, limitLists: 40 };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i], next = () => argv[++i];
		if (k === '--data-dir') a.dataDir = next();
		else if (k === '--db') a.db = next();
		else if (k === '--key') a.key = next();
		else if (k === '--enable') a.enable = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--report') a.report = next();
		else if (k === '--json') a.json = next();
		else if (k === '--baseline') a.baseline = next();
		else if (k === '--overwrite') a.overwrite = true;
		else if (k === '--lists') a.limitLists = Number(next());
	}
	return a;
}

function stampPath(p, when) {
	const stamp = String(when).slice(0, 19).replace('T', '-').replace(/:/g, '');
	const ext = path.extname(p);
	return path.join(path.dirname(p), path.basename(p, ext) + '-' + stamp + ext);
}

function timing(meta) {
	const per = (meta && meta.perProvider) || {};
	return { buildMs: (meta && meta.ms) || 0,
		deriveMs: Object.values(per).reduce((a, p) => a + ((p && p.ms) || 0), 0) };
}

/**
 * How far each citing work gets down the pipeline, independent of any strategy.
 *
 * Every offline strategy needs the same four things in order: an attachment, a
 * PDF, text out of it, and a reference section found in that text. Measuring
 * them once, here, is what lets a miss be attributed rather than just counted
 * -- and it is measured with the SAME segmenter the strategies use, so the
 * `none` bucket is the real splitter failing, not a second opinion about it.
 */
async function pipelineState(adapter, works) {
	const state = new Map();
	for (const [id, w] of works) {
		const s = { hasAttachment: false, hasPdf: false, hasText: false, quality: null, textLen: 0 };
		for (const key of w.itemKeys) {
			const atts = await adapter.getAttachments(key);
			if (atts.length) s.hasAttachment = true;
			for (const att of atts) {
				if (att.contentType !== 'application/pdf') continue;
				s.hasPdf = true;
				const text = await adapter.getAttachmentText(att.key);
				if (!text) continue;
				s.hasText = true;
				s.textLen = Math.max(s.textLen, text.length);
				const seg = segment(text);
				// Best section across a work's attachments: a work held twice, or
				// with a preprint beside the published PDF, is reachable if ANY of
				// them yields a section -- which is what the strategies see too.
				const rank = { heading: 3, numbered: 2, tail: 1, none: 0 };
				if (!s.quality || rank[seg.quality] > rank[s.quality]) s.quality = seg.quality;
			}
		}
		if (s.hasPdf && !s.quality) s.quality = 'none';
		state.set(id, s);
	}
	return state;
}

async function main() {
	const args = parseArgs(process.argv);
	if (!args.dataDir || !args.key) {
		console.log('usage: score-library.js --data-dir <dir> --key <library-key.json> [--db <copy>]');
		console.log('       [--enable a,b,c] [--report out.md] [--json out.json] [--baseline earlier.json]');
		process.exit(1);
	}

	const key = JSON.parse(fs.readFileSync(args.key, 'utf8'));
	const adapter = new LocalSqliteAdapter({ dataDir: args.dataDir, dbPath: args.db || undefined });
	const items = await adapter.listItems();
	const { works, keyToWork } = buildWorks(items);

	// The answer key, as edges. Only `covered` sources take part: a work whose
	// publisher deposited nothing can neither confirm an edge nor deny one.
	const covered = new Set();
	const truth = new Set();
	const extDois = new Map(), extTitles = new Map();
	for (const [id, s] of Object.entries(key.sources)) {
		if (!s.covered) continue;
		covered.add(id);
		for (const t of s.internalTargets || []) if (works.has(t)) truth.add(id + ' -> ' + t);
		extDois.set(id, new Set(s.externalDois || []));
		extTitles.set(id, (s.referenceTitles || [])
			.map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
	}
	const extTotal = [...extDois.values()].reduce((a, s) => a + s.size, 0);

	const state = await pipelineState(adapter, works);

	const ids = args.enable || cg.listStrategies().filter((p) => !p.requiresNetwork).map((p) => p.id);
	const runs = [];
	for (const id of ids) {
		try {
			const r = await cg.build(adapter, { enable: [id], includeExternal: true });
			runs.push({ id, edges: r.edges, ...timing(r.meta) });
		}
		catch (e) { runs.push({ id, error: e.message }); }
	}
	if (ids.length > 1) {
		try {
			const r = await cg.build(adapter, { enable: ids, includeExternal: true });
			runs.push({ id: 'OFFLINE (union)', union: true, edges: r.edges, ...timing(r.meta) });
		}
		catch (e) { runs.push({ id: 'OFFLINE (union)', union: true, error: e.message }); }
	}

	const results = runs.map((r) => (r.error
		? { id: r.id, union: !!r.union, error: r.error }
		: { id: r.id, union: !!r.union, buildMs: r.buildMs, deriveMs: r.deriveMs,
			...gradeInternal(r.edges), external: gradeExternal(r.edges) }));

	const singles = results.filter((r) => !r.union && !r.error);
	for (const r of singles) {
		const others = new Set(singles.filter((o) => o !== r).flatMap((o) => o.truePositives));
		r.uniqueTp = r.truePositives.filter((k) => !others.has(k));
	}

	const dbPath = args.db || path.join(args.dataDir, 'zotero.sqlite');
	const cond = {
		when: new Date().toISOString(),
		commit: sh('git', ['rev-parse', '--short', 'HEAD']),
		dirty: (sh('git', ['status', '--porcelain']) || '') !== '',
		node: process.version,
		platform: os.platform() + ' ' + os.release() + ' ' + process.arch,
		dataDir: args.dataDir,
		dbPath, dbSha: sha(fs.readFileSync(dbPath)), dbBytes: fs.statSync(dbPath).size,
		keyPath: args.key, keySha: sha(fs.readFileSync(args.key)), keyFetchedOn: key.fetchedOn,
		items: items.length, works: works.size,
		worksWithDoi: [...works.values()].filter((w) => w.doi).length,
		worksCovered: covered.size,
		worksNoDeposit: key.totals.noDeposit, worksFailed: key.totals.failed,
		worksWithPdf: [...state.values()].filter((s) => s.hasPdf).length,
		worksWithText: [...state.values()].filter((s) => s.hasText).length,
		strategies: cg.listStrategies().filter((s) => ids.includes(s.id))
			.map((s) => ({ id: s.id, confidence: s.defaultConfidence, network: s.requiresNetwork, options: s.options })),
	};

	const run = { conditions: cond,
		truth: { internalEdges: truth.size, externalDois: extTotal, coveredSources: covered.size },
		missAnatomy: missAnatomy(), results };

	const baseline = args.baseline && fs.existsSync(args.baseline)
		? JSON.parse(fs.readFileSync(args.baseline, 'utf8')) : null;

	console.log(text(run, baseline));
	if (args.json) { fs.writeFileSync(args.json, JSON.stringify(run, null, 1)); console.log('wrote', args.json); }
	if (args.report) {
		const to = args.overwrite ? args.report : stampPath(args.report, cond.when);
		fs.writeFileSync(to, markdown(run, baseline, args.baseline));
		console.log('wrote', to);
	}

	/** Internal edges: both ends held. Recall is honest, precision is not. */
	function gradeInternal(edges) {
		const seen = new Set();
		let selfLoop = 0;
		for (const e of edges) {
			const from = keyToWork.get(e.from), to = keyToWork.get(e.to);
			if (!from || !to) continue;
			if (from === to) { selfLoop++; continue; }
			seen.add(from + ' -> ' + to);
		}
		// Only edges whose CITING work Crossref covers can be graded at all.
		const gradable = [...seen].filter((k) => covered.has(k.split(' -> ')[0]));
		const tp = gradable.filter((k) => truth.has(k));
		const suspect = gradable.filter((k) => !truth.has(k));
		const ungradable = seen.size - gradable.length;
		const missed = [...truth].filter((k) => !seen.has(k));
		return {
			predicted: seen.size, gradable: gradable.length, ungradable,
			tp: tp.length, suspect: suspect.length, missed: missed.length,
			recall: truth.size ? tp.length / truth.size : 0,
			precisionGraded: gradable.length ? tp.length / gradable.length : 0,
			duplicateSelfLoops: selfLoop,
			truePositives: tp, suspects: suspect, missedEdges: missed,
		};
	}

	/** External DOIs. Presence reliable, absence not: no false positives here. */
	function gradeExternal(edges) {
		const byNs = {};
		const perSource = new Map(), refNodes = new Map();
		for (const e of edges) {
			const from = keyToWork.get(e.from);
			const to = String(e.to), i = to.indexOf(':');
			if (!from || i < 0) continue;
			const ns = to.slice(0, i), rest = to.slice(i + 1);
			if (!['doi', 'openalex', 'arxiv', 'ref'].includes(ns)) continue;
			byNs[ns] = (byNs[ns] || 0) + 1;
			if (ns === 'ref') {
				if (!refNodes.has(from)) refNodes.set(from, new Set());
				refNodes.get(from).add(rest);
				continue;
			}
			let doi = null;
			if (ns === 'doi') doi = normDoi(rest);
			else if (ns === 'arxiv') doi = '10.48550/arxiv.' + rest.toLowerCase();
			if (!doi) continue;
			if (!perSource.has(from)) perSource.set(from, new Set());
			perSource.get(from).add(doi);
		}

		let tp = 0, unconfirmed = 0, emittedGradable = 0;
		const suffixArtifacts = [], truncated = [];
		for (const [src, set] of perSource) {
			const t = extDois.get(src);
			if (!t) continue;
			emittedGradable += set.size;
			for (const d of set) {
				if (t.has(d)) { tp++; continue; }
				const stripped = d.replace(SUFFIX_RE, '');
				if (stripped !== d && t.has(stripped)) { suffixArtifacts.push(src + '  ' + d); continue; }
				const longer = [...t].find((x) => x.startsWith(d) && x.length > d.length);
				if (longer) { truncated.push(src + '  ' + d + '  ->  ' + longer); continue; }
				unconfirmed++;
			}
		}
		let missed = 0;
		for (const [src, t] of extDois) {
			const s = perSource.get(src) || new Set();
			for (const d of t) if (!s.has(d)) missed++;
		}
		let refTotal = 0, refCorroborated = 0;
		for (const [src, slugs] of refNodes) {
			const titles = extTitles.get(src);
			for (const s of slugs) {
				refTotal++;
				if (!titles || !titles.length) continue;
				const w = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
				if (w.length >= 12 && titles.some((t) => t.includes(w.slice(0, 40)))) refCorroborated++;
			}
		}
		return { byNamespace: byNs, tp, missed, unconfirmed, emittedGradable,
			recallLowerBound: extTotal ? tp / extTotal : 0,
			suffixArtifacts, truncated, defects: suffixArtifacts.length + truncated.length,
			refNodes: refTotal, refNodesCorroborated: refCorroborated };
	}

	/**
	 * Where the truth lives, by how far its citing work gets down the pipeline.
	 *
	 * Computed from the KEY, not from any strategy, so it is the ceiling: an
	 * edge whose citing work has no PDF is unreachable by every offline
	 * strategy there will ever be, and counting it in a recall denominator
	 * without saying so makes the strategies look worse than they are.
	 */
	function missAnatomy() {
		const bucket = { noPdf: 0, noText: 0, noSection: 0, sectionTail: 0, sectionGood: 0 };
		const bySource = new Map();
		for (const k of truth) {
			const src = k.split(' -> ')[0];
			const s = state.get(src) || {};
			const b = !s.hasPdf ? 'noPdf' : !s.hasText ? 'noText'
				: s.quality === 'none' ? 'noSection' : s.quality === 'tail' ? 'sectionTail' : 'sectionGood';
			bucket[b]++;
			if (!bySource.has(src)) bySource.set(src, { total: 0, bucket: b });
			bySource.get(src).total++;
		}
		return { bucket, reachable: bucket.sectionGood + bucket.sectionTail + bucket.noSection,
			bySource: [...bySource.entries()].map(([id, v]) => ({ id, ...v })) };
	}

	function text(run, baseline) {
		const c = run.conditions, L = [];
		L.push('Library accuracy · ' + c.when.slice(0, 16).replace('T', ' ') + ' · commit ' + c.commit + (c.dirty ? '+dirty' : ''));
		L.push(c.items + ' items -> ' + c.works + ' works · ' + c.worksWithDoi + ' with a DOI · '
			+ c.worksCovered + ' with a Crossref deposit · ' + c.worksWithPdf + ' with a PDF');
		L.push('key: ' + run.truth.internalEdges + ' internal edges, ' + run.truth.externalDois
			+ ' external DOIs (recall is a LOWER BOUND; `susp` is not an error count)');
		L.push('');
		L.push(pad('strategy', 16) + rpad('pred', 6) + rpad('TP', 5) + rpad('uniq', 6) + rpad('susp', 6)
			+ rpad('missed', 8) + rpad('recall', 8) + rpad('prec*', 7)
			+ '  | ' + rpad('extTP', 7) + rpad('miss', 7) + rpad('unconf', 8) + rpad('defect', 7) + rpad('derive', 9));
		for (const r of run.results) {
			if (r.error) { L.push(pad(r.id, 16) + '  ERROR: ' + r.error); continue; }
			const e = r.external;
			L.push(pad(r.id, 16) + rpad(r.predicted, 6) + rpad(r.tp, 5)
				+ rpad(r.union ? '-' : r.uniqueTp.length, 6) + rpad(r.suspect, 6) + rpad(r.missed, 8)
				+ rpad(pct(r.recall), 8) + rpad(pct(r.precisionGraded), 7)
				+ '  | ' + rpad(e.tp, 7) + rpad(e.missed, 7) + rpad(e.unconfirmed, 8) + rpad(e.defects, 7)
				+ rpad(ms(r.deriveMs), 9));
		}
		const m = run.missAnatomy.bucket;
		L.push('');
		L.push('Where the answer key lives: noPdf ' + m.noPdf + ' · noText ' + m.noText
			+ ' · noSection ' + m.noSection + ' · tail ' + m.sectionTail + ' · good ' + m.sectionGood);
		return L.join('\n');
	}

	function markdown(run, baseline, basePath) {
		const c = run.conditions, L = [];
		L.push('# Citation accuracy — whole library');
		L.push('');
		L.push('Generated by `npm run bench-ref:library -- --report`. Do not edit by hand.');
		L.push('Columns are defined in [README.md](README.md#the-whole-library-run); the short');
		L.push('version is that **recall is honest and precision is not** — Crossref deposits are');
		L.push('incomplete, so a predicted edge it does not list is `susp` (suspect), never a');
		L.push('counted error.');
		L.push('');
		L.push('## Conditions');
		L.push('');
		L.push('| | |');
		L.push('|---|---|');
		L.push('| measured | ' + c.when + ' |');
		L.push('| commit | `' + c.commit + '`' + (c.dirty ? ' **+ uncommitted changes**' : '') + ' |');
		L.push('| runtime | node ' + c.node + ' on ' + c.platform + ' |');
		L.push('| data dir | `' + c.dataDir + '` |');
		L.push('| database | `' + path.basename(c.dbPath) + '` · sha256 `' + c.dbSha + '` · ' + c.dbBytes + ' bytes |');
		L.push('| library | ' + c.items + ' items → ' + c.works + ' works · ' + c.worksWithDoi
			+ ' with a DOI · ' + c.worksWithPdf + ' with a PDF · ' + c.worksWithText + ' with text |');
		L.push('| answer key | `' + path.basename(c.keyPath) + '` sha256 `' + c.keySha
			+ '` · Crossref fetched ' + c.keyFetchedOn + ' |');
		L.push('| coverage | ' + c.worksCovered + ' works with a deposited list · ' + c.worksNoDeposit
			+ ' with none · ' + c.worksFailed + ' unresolvable |');
		L.push('| network | no (offline strategies only) |');
		L.push('');
		L.push('Strategy configuration as run:');
		L.push('');
		L.push('| strategy | confidence | options |');
		L.push('|---|---|---|');
		for (const s of c.strategies) {
			L.push('| `' + s.id + '` | ' + s.confidence + ' | `'
				+ JSON.stringify(s.options || {}).replace(/\|/g, '\\|') + '` |');
		}
		L.push('');

		L.push('## Internal edges — citations between works the library holds');
		L.push('');
		L.push(run.truth.internalEdges + ' edges, from the ' + run.truth.coveredSources
			+ ' citing works whose publisher deposited a reference list.');
		L.push('');
		L.push('| strategy | pred | TP | uniq | susp | missed | recall | prec\\* | dup | derive |');
		L.push('|---|---|---|---|---|---|---|---|---|---|');
		for (const r of run.results) {
			if (r.error) { L.push('| `' + r.id + '` | ERROR: ' + r.error + ' | | | | | | | | |'); continue; }
			L.push('| `' + r.id + '` | ' + r.predicted + ' | ' + r.tp + ' | ' + (r.union ? '—' : r.uniqueTp.length)
				+ ' | ' + r.suspect + ' | ' + r.missed + ' | ' + pct(r.recall) + ' | '
				+ pct(r.precisionGraded) + ' | ' + r.duplicateSelfLoops + ' | ' + ms(r.deriveMs) + ' |');
		}
		L.push('');
		L.push('\\* `prec` counts a predicted edge as wrong whenever Crossref does not list it, which');
		L.push('is the one thing this key cannot prove. Read it as a floor, and `susp` as the pool');
		L.push('that floor is taken out of.');
		L.push('');

		const m = run.missAnatomy;
		L.push('### Where the answer key lives');
		L.push('');
		L.push('Every internal edge, bucketed by how far its **citing** work gets down the shared');
		L.push('pipeline — attachment → PDF → text → reference section. This is the ceiling, not a');
		L.push('score: an edge whose citing work has no PDF is out of reach of every offline');
		L.push('strategy there will ever be.');
		L.push('');
		L.push('| bucket | edges | meaning |');
		L.push('|---|---|---|');
		L.push('| no PDF | ' + m.bucket.noPdf + ' | nothing to read — unreachable offline |');
		L.push('| PDF, no text | ' + m.bucket.noText + ' | no ft-cache and no pdftotext — scanned or broken |');
		L.push('| text, no section | ' + m.bucket.noSection + ' | the splitter found no reference list |');
		L.push('| section (tail) | ' + m.bucket.sectionTail + ' | last-resort section: the tail of the document |');
		L.push('| section (good) | ' + m.bucket.sectionGood + ' | a heading or numbered list was found |');
		L.push('');
		L.push('Reachable ceiling: **' + m.reachable + ' / ' + run.truth.internalEdges + '** ('
			+ pct(m.reachable / run.truth.internalEdges) + ').');
		L.push('');

		L.push('## External references — cited works the library does not hold');
		L.push('');
		L.push(run.truth.externalDois + ' external DOIs. Presence is reliable, absence is not, so');
		L.push('`recall ≥` is a lower bound and `unconf` is not an error count.');
		L.push('');
		L.push('| strategy | emitted by namespace | TP | missed | unconf | defects | recall ≥ | ref: nodes |');
		L.push('|---|---|---|---|---|---|---|---|');
		for (const r of run.results) {
			if (r.error) continue;
			const e = r.external;
			const ns = Object.entries(e.byNamespace).map(([k, v]) => k + ' ' + v).join(', ') || '—';
			L.push('| `' + r.id + '` | ' + ns + ' | ' + e.tp + ' | ' + e.missed + ' | ' + e.unconfirmed
				+ ' | ' + e.defects + ' | ' + pct(e.recallLowerBound) + ' | ' + e.refNodes
				+ (e.refNodes ? ' (' + e.refNodesCorroborated + ' corroborated)' : '') + ' |');
		}
		L.push('');
		const defects = run.results.filter((r) => r.external && r.external.defects);
		if (defects.length) {
			L.push('### Defects');
			L.push('');
			L.push('Provable despite the incompleteness: stripping a URL tail, or extending a cut-off');
			L.push('DOI, turns the emitted string into one the key *does* hold. Both mint a ghost node');
			L.push('for a work that exists under no such identifier.');
			L.push('');
			for (const r of defects) {
				L.push('**`' + r.id + '`** — ' + r.external.defects + ' (' + r.external.suffixArtifacts.length
					+ ' suffix, ' + r.external.truncated.length + ' truncated)');
				L.push('');
				for (const s of r.external.suffixArtifacts.slice(0, args.limitLists)) L.push('- suffix — `' + s + '`');
				for (const t of r.external.truncated.slice(0, args.limitLists)) L.push('- truncated — `' + t + '`');
				L.push('');
			}
		}

		L.push('## Missed edges');
		L.push('');
		L.push('Edges Crossref lists and the union did not draw, up to ' + args.limitLists + ' shown.');
		L.push('');
		const union = run.results.find((r) => r.union) || run.results[run.results.length - 1];
		if (union && union.missedEdges) {
			for (const k of union.missedEdges.slice(0, args.limitLists)) L.push('- `' + k + '`');
			if (union.missedEdges.length > args.limitLists) {
				L.push('- … and ' + (union.missedEdges.length - args.limitLists) + ' more');
			}
		}
		L.push('');
		L.push('## Suspect edges');
		L.push('');
		L.push('Predicted, and not in any deposit. Some are extraction errors, some are real');
		L.push('citations from an incomplete deposit — the key cannot tell them apart.');
		L.push('');
		if (union && union.suspects) {
			for (const k of union.suspects.slice(0, args.limitLists)) L.push('- `' + k + '`');
			if (union.suspects.length > args.limitLists) {
				L.push('- … and ' + (union.suspects.length - args.limitLists) + ' more');
			}
		}
		L.push('');

		if (baseline) {
			L.push('## Against the baseline');
			L.push('');
			const bc = baseline.conditions || {};
			L.push('`' + basePath + '`, measured ' + (bc.when || 'unknown') + ' at commit `' + (bc.commit || '?') + '`.');
			if (bc.dbSha && bc.dbSha !== c.dbSha) {
				L.push('');
				L.push('> **The library changed** (`' + bc.dbSha + '` → `' + c.dbSha
					+ '`). Differences below are not attributable to the code alone.');
			}
			if (bc.keySha && bc.keySha !== c.keySha) {
				L.push('');
				L.push('> **The answer key changed** (`' + bc.keySha + '` → `' + c.keySha + '`).');
			}
			L.push('');
			L.push('| strategy | TP | susp | missed | ext TP | defects |');
			L.push('|---|---|---|---|---|---|');
			const bm = new Map((baseline.results || []).map((r) => [r.id, r]));
			for (const r of run.results) {
				if (r.error) continue;
				const b = bm.get(r.id);
				if (!b || b.error) { L.push('| `' + r.id + '` | new | | | | |'); continue; }
				const d = (x, y) => (y - x === 0 ? '—' : (y - x > 0 ? '+' : '') + (y - x));
				L.push('| `' + r.id + '` | ' + d(b.tp, r.tp) + ' | ' + d(b.suspect, r.suspect) + ' | '
					+ d(b.missed, r.missed) + ' | ' + d(b.external.tp, r.external.tp) + ' | '
					+ d(b.external.defects, r.external.defects) + ' |');
			}
			L.push('');
		}
		return L.join('\n') + '\n';
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
