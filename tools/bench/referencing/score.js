'use strict';

/**
 * Score the edge strategies against the answer key, and write a report that a
 * later run can be compared against.
 *
 *   node tools/bench/referencing/score.js --data-dir "C:/Users/me/Zotero citation_graph_testing"
 *   node tools/bench/referencing/score.js --data-dir <dir> --db ./snap.sqlite   (Zotero running)
 *   node tools/bench/referencing/score.js --enable openalex --api-key KEY
 *   node tools/bench/referencing/score.js --report docs/accuracy.md --json run.json
 *   node tools/bench/referencing/score.js --baseline run.json     compare with an earlier run
 *   node tools/bench/referencing/score.js --no-external           in-collection edges only
 *
 * tools/bench measures how fast the graph draws. This measures whether the
 * edges in it are true, which needs a different instrument: a fixed collection
 * whose citations are known independently of the strategies being graded.
 *
 * TWO TIERS, because they are known to different standards.
 *
 * Tier 1, `ground-truth.json`: the 29 citations BETWEEN the 12 held works, read
 * by hand out of each citing PDF and cross-checked against Crossref for
 * completeness. Exhaustive, so it can call a strategy wrong -- a predicted
 * in-collection edge that is not in it is a false positive.
 *
 * Tier 2, `external-refs.json`: the 809 works the collection cites and does not
 * hold, from Crossref's deposited reference lists. Presence is reliable,
 * absence is not -- publishers deposit incomplete lists -- so tier-2 recall is
 * a lower bound and an unlisted DOI is reported as UNCONFIRMED, never as a
 * false positive. Only provable defects are graded: a DOI carrying a URL tail,
 * and a DOI cut short.
 *
 * Scored at WORK level. The collection holds one work twice on purpose, so an
 * item-level count would let a strategy score the same citation twice and would
 * punish one that correctly merged the duplicate. An edge between the two
 * copies becomes a self-loop and is reported on its own column rather than as a
 * false positive: that is a duplicate-merging failure, not a wrong citation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { LocalSqliteAdapter } = require('../../../addon/citation-graph/adapters/localSqlite');
const cg = require('../../../addon/citation-graph/index');

const GT_PATH = path.join(__dirname, 'ground-truth.json');
const EXT_PATH = path.join(__dirname, 'external-refs.json');
const OA_CACHE = path.join(__dirname, '.openalex-doi-cache.json');

const SUFFIX_RE = /\/(abstract|epdf|full|pdf|meta|html)$/;

function parseArgs(argv) {
	const a = { dataDir: null, db: null, enable: null, apiKey: null, json: null, report: null,
		baseline: null, external: true, resolve: true, help: false };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		const next = () => argv[++i];
		if (k === '--data-dir') a.dataDir = next();
		else if (k === '--db') a.db = next();
		else if (k === '--enable') a.enable = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--api-key') a.apiKey = next();
		else if (k === '--json') a.json = next();
		else if (k === '--report') a.report = next();
		else if (k === '--baseline') a.baseline = next();
		else if (k === '--no-external') a.external = false;
		else if (k === '--no-resolve') a.resolve = false;
		else if (k === '--help' || k === '-h') a.help = true;
	}
	return a;
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const pct = (x) => (x * 100).toFixed(0) + '%';
const normDoi = (d) => String(d || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
const f1 = (p, r) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

function sh(cmd, args) {
	try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); }
	catch (_) { return null; }
}

/**
 * Everything needed to reproduce the run. A number without the conditions it
 * was taken under cannot be compared with a number taken later -- the point of
 * writing a report at all is that the next one is comparable, and it only is if
 * both say what they measured and what they measured it with.
 */
function conditions(args, adapter, ids, gt, ext) {
	const dbPath = args.db || path.join(args.dataDir, 'zotero.sqlite');
	const dbBuf = fs.readFileSync(dbPath);
	let pdfCount = 0;
	const pdfHashes = [];
	try {
		const storage = path.join(args.dataDir, 'storage');
		for (const dir of fs.readdirSync(storage).sort()) {
			const d = path.join(storage, dir);
			if (!fs.statSync(d).isDirectory()) continue;
			for (const f of fs.readdirSync(d).sort()) {
				if (!/\.pdf$/i.test(f)) continue;
				pdfCount++;
				pdfHashes.push(sha(fs.readFileSync(path.join(d, f))));
			}
		}
	} catch (_) { /* storage unreadable: reported as 0 below */ }

	return {
		when: new Date().toISOString(),
		commit: sh('git', ['rev-parse', '--short', 'HEAD']),
		dirty: (sh('git', ['status', '--porcelain']) || '') !== '',
		node: process.version,
		platform: os.platform() + ' ' + os.release() + ' ' + process.arch,
		dataDir: args.dataDir,
		dbPath,
		dbSha: sha(dbBuf),
		dbBytes: dbBuf.length,
		pdfCount,
		pdfSetSha: sha(pdfHashes.join('')),
		groundTruthSha: sha(fs.readFileSync(GT_PATH)),
		groundTruthEdges: gt.edges.length,
		externalRefsSha: ext ? sha(fs.readFileSync(EXT_PATH)) : null,
		externalDois: ext ? ext.totals.externalDois : null,
		externalFetchedOn: ext ? ext.fetchedOn : null,
		strategies: cg.listStrategies()
			.filter((s) => ids.includes(s.id))
			.map((s) => ({ id: s.id, confidence: s.defaultConfidence,
				network: s.requiresNetwork, options: s.options })),
		network: cg.listStrategies().some((s) => ids.includes(s.id) && s.requiresNetwork),
		apiKey: args.apiKey ? 'supplied' : 'none (anonymous)',
	};
}

/** OpenAlex work IDs -> DOI. Identity resolution only; the TRUTH stays Crossref. */
async function openalexDoiMap(ids, allowNetwork) {
	let map = {};
	if (fs.existsSync(OA_CACHE)) map = JSON.parse(fs.readFileSync(OA_CACHE, 'utf8'));
	const todo = ids.filter((i) => !(i in map));
	if (todo.length && allowNetwork) {
		for (let i = 0; i < todo.length; i += 50) {
			const batch = todo.slice(i, i + 50);
			const url = 'https://api.openalex.org/works?per-page=50&select=id,doi&filter=openalex_id:'
				+ batch.join('|');
			const res = await fetch(url, { headers: { Accept: 'application/json' } });
			if (!res.ok) break;
			for (const w of ((await res.json()).results) || []) {
				map[String(w.id).slice(String(w.id).lastIndexOf('/') + 1)] = w.doi ? normDoi(w.doi) : null;
			}
			for (const b of batch) if (!(b in map)) map[b] = null;
			await new Promise((r) => setTimeout(r, 400));
		}
		fs.writeFileSync(OA_CACHE, JSON.stringify(map));
	}
	return { map, resolved: ids.filter((i) => map[i]).length, unresolved: ids.filter((i) => !map[i]).length };
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.help || (!args.dataDir && !args.db)) {
		console.log('usage: node tools/bench/referencing/score.js --data-dir <zotero data dir> [--db <copy>]');
		console.log('       [--enable a,b,c] [--api-key KEY] [--report out.md] [--json out.json]');
		console.log('       [--baseline earlier.json] [--no-external] [--no-resolve]');
		process.exit(args.help ? 0 : 1);
	}

	const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
	const ext = args.external && fs.existsSync(EXT_PATH)
		? JSON.parse(fs.readFileSync(EXT_PATH, 'utf8')) : null;

	const keyToWork = new Map();
	for (const w of gt.works) for (const k of w.itemKeys) keyToWork.set(k, w.id);

	const truth = new Set(gt.edges.map((e) => e.from + ' -> ' + e.to));
	const reachable = new Set(
		gt.edges.filter((e) => e.citingPdfHeld !== false).map((e) => e.from + ' -> ' + e.to));
	const traps = gt.expectedNonEdges.filter((t) => t.from !== '*' && t.to !== '*');
	const controlWorks = new Set(gt.expectedNonEdges
		.filter((t) => t.from === '*' || t.to === '*')
		.map((t) => (t.from === '*' ? t.to : t.from)));

	// Tier-2 lookup: work id -> Set(external doi), plus normalised reference titles.
	const extDois = new Map(), extTitles = new Map();
	if (ext) {
		for (const [id, s] of Object.entries(ext.sources)) {
			if (!s.covered) continue;
			extDois.set(id, new Set(s.externalDois));
			extTitles.set(id, (s.referenceTitles || [])
				.map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
		}
	}
	const extTotal = [...extDois.values()].reduce((a, s) => a + s.size, 0);

	const adapter = new LocalSqliteAdapter({ dataDir: args.dataDir, dbPath: args.db || undefined });
	const ids = args.enable || cg.listStrategies().filter((p) => !p.requiresNetwork).map((p) => p.id);
	const providerOpts = args.apiKey ? { openalex: { apiKey: args.apiKey } } : {};

	// One build per strategy, then two unions, all with externals so tier 2 has
	// something to grade. Tier 1 ignores external targets either way.
	//
	// The OFFLINE union is reported beside the full one because it is what a
	// default install actually draws: `openalex` needs the network and is
	// off by default, so a figure that includes it describes a graph most
	// libraries never build. The gap between the two rows is the price of
	// staying offline, which is the number the pref is really asking about.
	const offlineIds = ids.filter((id) => {
		const p = cg.listStrategies().find((s) => s.id === id);
		return p && !p.requiresNetwork;
	});
	const runs = [];
	for (const id of ids) {
		try {
			const r = await cg.build(adapter, { enable: [id], includeExternal: !!ext, providers: providerOpts });
			runs.push({ id, edges: r.edges, errors: (r.meta && r.meta.errors) || [] });
		} catch (e) { runs.push({ id, error: e.message }); }
	}
	const unions = [['OFFLINE (union)', offlineIds], ['ALL (union)', ids]];
	for (const [label, enable] of unions) {
		// Only when it says something the single-strategy rows do not: one
		// offline strategy makes the offline union a copy of that row.
		if (enable.length < 2 || (label === 'OFFLINE (union)' && enable.length === ids.length)) continue;
		try {
			const r = await cg.build(adapter, { enable, includeExternal: !!ext, providers: providerOpts });
			runs.push({ id: label, union: true, edges: r.edges, errors: (r.meta && r.meta.errors) || [] });
		} catch (e) { runs.push({ id: label, union: true, error: e.message }); }
	}

	// Resolve OpenAlex ids once, across every run that produced them.
	const oaIds = new Set();
	for (const r of runs) for (const e of (r.edges || [])) {
		if (String(e.to).startsWith('openalex:')) oaIds.add(String(e.to).slice(9));
	}
	const oa = ext && oaIds.size
		? await openalexDoiMap([...oaIds], args.resolve)
		: { map: {}, resolved: 0, unresolved: 0 };

	const results = runs.map((r) => (r.error
		? { id: r.id, union: !!r.union, error: r.error }
		: { id: r.id, union: !!r.union, errors: r.errors, ...gradeCore(r.edges),
			external: ext ? gradeExternal(r.edges) : null }));

	// What each strategy alone contributes: the true edges no other strategy in
	// this run found. A strategy whose unique count is zero is, on this
	// collection, carrying nothing the rest do not already carry -- which is the
	// question "should this one be on by default?" in its measurable form. Union
	// rows are excluded from the comparison and report no unique count of their
	// own, since every edge in them came from one of the rows above.
	const singles = results.filter((r) => !r.union && !r.error);
	for (const r of singles) {
		const others = singles.filter((o) => o !== r).flatMap((o) => o.truePositives);
		r.uniqueTp = r.truePositives.filter((k) => !others.includes(k));
	}

	const cond = conditions(args, adapter, ids, gt, ext);
	cond.openalexIdsResolved = oa.resolved;
	cond.openalexIdsUnresolved = oa.unresolved;

	const run = { conditions: cond, tier1: { edges: gt.edges.length, reachable: reachable.size },
		tier2: ext ? { externalDois: extTotal } : null, results };

	const baseline = args.baseline && fs.existsSync(args.baseline)
		? JSON.parse(fs.readFileSync(args.baseline, 'utf8')) : null;

	report(run, baseline, args.baseline);
	if (args.json) { fs.writeFileSync(args.json, JSON.stringify(run, null, 1)); console.log('\nwrote', args.json); }
	if (args.report) { fs.writeFileSync(args.report, markdown(run, baseline, args.baseline)); console.log('wrote', args.report); }

	/** Tier 1: citations between held works. Exhaustive, so FP means wrong. */
	function gradeCore(edges) {
		const seen = new Set();
		let selfLoop = 0;
		for (const e of edges) {
			const from = keyToWork.get(e.from), to = keyToWork.get(e.to);
			if (!from || !to) continue;                 // external: tier 2's business
			if (from === to) { selfLoop++; continue; }   // the duplicated work
			seen.add(from + ' -> ' + to);
		}
		const tp = [...seen].filter((k) => truth.has(k));
		const fp = [...seen].filter((k) => !truth.has(k));
		const fn = [...truth].filter((k) => !seen.has(k));
		const precision = seen.size ? tp.length / seen.size : 0;
		const recall = truth.size ? tp.length / truth.size : 0;
		return {
			predicted: seen.size, tp: tp.length, fp: fp.length, fn: fn.length,
			precision, recall,
			recallReachable: reachable.size ? tp.filter((k) => reachable.has(k)).length / reachable.size : 0,
			f1: f1(precision, recall),
			duplicateSelfLoops: selfLoop,
			trapsHit: traps.filter((t) => seen.has(t.from + ' -> ' + t.to))
				.map((t) => t.from + ' -> ' + t.to + '  [' + t.trap + ']'),
			controlHit: [...seen].filter((k) => {
				const [a, b] = k.split(' -> ');
				return controlWorks.has(a) || controlWorks.has(b);
			}),
			truePositives: tp, falsePositives: fp, missed: fn,
		};
	}

	/** Tier 2: cited works the collection does not hold. Incomplete, so no FP. */
	function gradeExternal(edges) {
		const byNs = {};
		const perSource = new Map();       // work -> Set(doi)
		const refNodes = new Map();        // work -> Set(slug)
		let unresolvable = 0;
		for (const e of edges) {
			const from = keyToWork.get(e.from);
			const to = String(e.to);
			const i = to.indexOf(':');
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
			else if (ns === 'openalex') doi = oa.map[rest] || null;
			else if (ns === 'arxiv') doi = '10.48550/arxiv.' + rest.toLowerCase();
			if (!doi) { unresolvable++; continue; }
			if (!perSource.has(from)) perSource.set(from, new Set());
			perSource.get(from).add(doi);
		}

		let tp = 0, unconfirmed = 0;
		const suffixArtifacts = [], truncated = [];
		for (const [src, set] of perSource) {
			const t = extDois.get(src);
			if (!t) continue;                            // source Crossref cannot cover
			for (const d of set) {
				if (t.has(d)) { tp++; continue; }
				// Provable defects: the emitted string is not a DOI anyone holds,
				// and the real one is right there in the set.
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
		// `ref:` nodes carry no identifier, so they are checked against the
		// reference TITLES Crossref deposited: a slug whose words appear in one
		// is a reference that exists, whatever its identity.
		let refTotal = 0, refCorroborated = 0;
		for (const [src, slugs] of refNodes) {
			const titles = extTitles.get(src);
			for (const s of slugs) {
				refTotal++;
				if (!titles || !titles.length) continue;
				const words = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
				if (words.length >= 12 && titles.some((t) => t.includes(words.slice(0, 40)))) refCorroborated++;
			}
		}
		return {
			byNamespace: byNs, unresolvableIds: unresolvable,
			tp, missed, unconfirmed,
			recallLowerBound: extTotal ? tp / extTotal : 0,
			suffixArtifacts, truncated,
			defects: suffixArtifacts.length + truncated.length,
			refNodes: refTotal, refNodesCorroborated: refCorroborated,
		};
	}

	function report(run, baseline, basePath) {
		const c = run.conditions;
		console.log('Accuracy ·', c.when.slice(0, 16).replace('T', ' '), '· commit', c.commit + (c.dirty ? '+dirty' : ''));
		console.log('tier 1:', run.tier1.edges, 'hand-read in-collection edges (' + run.tier1.reachable + ' PDF-reachable)');
		if (run.tier2) console.log('tier 2:', run.tier2.externalDois, 'external DOIs from Crossref deposits (recall is a LOWER BOUND)');
		console.log('');
		console.log(pad('strategy', 16), rpad('pred', 5), rpad('TP', 4), rpad('uniq', 5), rpad('FP', 4),
			rpad('prec', 6), rpad('recall', 7), rpad('F1', 6), rpad('dup', 4), rpad('traps', 6),
			run.tier2 ? '  | ext TP  miss  unconf  defect' : '');
		const bm = new Map((baseline && baseline.results || []).map((r) => [r.id, r]));
		for (const r of run.results) {
			if (r.error) { console.log(pad(r.id, 16), ' ERROR:', r.error); continue; }
			const e = r.external;
			console.log(pad(r.id, 16), rpad(r.predicted, 5), rpad(r.tp, 4),
				rpad(r.union ? '-' : r.uniqueTp.length, 5), rpad(r.fp, 4),
				rpad(pct(r.precision), 6), rpad(pct(r.recall), 7), rpad(r.f1.toFixed(2), 6),
				rpad(r.duplicateSelfLoops, 4), rpad(r.trapsHit.length || '-', 6),
				e ? '  | ' + rpad(e.tp, 6) + rpad(e.missed, 6) + rpad(e.unconfirmed, 8) + rpad(e.defects, 7) : '');
			const b = bm.get(r.id);
			if (b && !b.error) {
				const d = (x, y) => (y - x === 0 ? null : (y - x > 0 ? '+' : '') + (y - x));
				const parts = [['TP', d(b.tp, r.tp)], ['FP', d(b.fp, r.fp)],
					['extTP', e && b.external ? d(b.external.tp, e.tp) : null],
					['defects', e && b.external ? d(b.external.defects, e.defects) : null]]
					.filter(([, v]) => v).map(([k, v]) => k + ' ' + v);
				if (parts.length) console.log(pad('', 16), '  vs baseline:', parts.join(', '));
			}
		}

		for (const r of run.results) {
			if (r.error) continue;
			const lines = [];
			for (const t of r.trapsHit) lines.push('   TRAP   ' + t);
			for (const c2 of r.controlHit) lines.push('   CONTROL violated   ' + c2);
			for (const fp of r.falsePositives) lines.push('   FP     ' + fp);
			for (const s of (r.external ? r.external.suffixArtifacts : [])) lines.push('   DEFECT suffix     ' + s);
			for (const t of (r.external ? r.external.truncated : [])) lines.push('   DEFECT truncated  ' + t);
			if (lines.length) console.log('\n' + r.id + ':\n' + lines.join('\n'));
		}
		if (baseline) console.log('\nbaseline:', basePath, '·', (baseline.conditions || {}).when || 'unknown');
	}

	function markdown(run, baseline, basePath) {
		const c = run.conditions, L = [];
		L.push('# Citation accuracy');
		L.push('');
		L.push('Generated by `node tools/bench/referencing/score.js --report`. Do not edit by hand —');
		L.push('the next run overwrites it. Every column is defined in');
		L.push('[README.md](README.md), which is also where to look for what the answer key');
		L.push('can and cannot prove.');
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
		L.push('| PDFs | ' + c.pdfCount + ' files · set sha256 `' + c.pdfSetSha + '` |');
		L.push('| tier 1 key | `ground-truth.json` sha256 `' + c.groundTruthSha + '` · ' + c.groundTruthEdges + ' edges |');
		if (c.externalRefsSha) {
			L.push('| tier 2 key | `external-refs.json` sha256 `' + c.externalRefsSha + '` · '
				+ c.externalDois + ' DOIs · Crossref fetched ' + c.externalFetchedOn + ' |');
		}
		L.push('| network | ' + (c.network ? 'yes — API key ' + c.apiKey : 'no (offline strategies only)') + ' |');
		if (c.openalexIdsResolved) {
			L.push('| OpenAlex ids resolved | ' + c.openalexIdsResolved + ' to a DOI, '
				+ c.openalexIdsUnresolved + ' with none (identity only; truth stays Crossref) |');
		}
		L.push('');
		L.push('Strategy configuration as run:');
		L.push('');
		L.push('| strategy | confidence | network | options |');
		L.push('|---|---|---|---|');
		for (const s of c.strategies) {
			L.push('| `' + s.id + '` | ' + s.confidence + ' | ' + (s.network ? 'yes' : 'no') + ' | `'
				+ JSON.stringify(s.options || {}).replace(/\|/g, '\\|') + '` |');
		}
		L.push('');
		L.push('To reproduce: check out that commit, point `--data-dir` at a profile whose');
		L.push('database and PDF set hash to the values above, and run the same `--enable`.');
		L.push('');

		L.push('## Tier 1 — citations between held works');
		L.push('');
		L.push(run.tier1.edges + ' edges, ' + run.tier1.reachable + ' of them PDF-reachable.');
		L.push('');
		L.push('| strategy | pred | TP | uniq | FP | precision | recall | rec/pdf | F1 | dup | traps |');
		L.push('|---|---|---|---|---|---|---|---|---|---|---|');
		for (const r of run.results) {
			if (r.error) { L.push('| `' + r.id + '` | ERROR: ' + r.error + ' | | | | | | | | | |'); continue; }
			L.push('| `' + r.id + '` | ' + r.predicted + ' | ' + r.tp + ' | ' + (r.union ? '—' : r.uniqueTp.length)
				+ ' | ' + r.fp + ' | ' + pct(r.precision)
				+ ' | ' + pct(r.recall) + ' | ' + pct(r.recallReachable) + ' | ' + r.f1.toFixed(2)
				+ ' | ' + r.duplicateSelfLoops + ' | ' + (r.trapsHit.length || '—') + ' |');
		}
		L.push('');
		const uniq = run.results.filter((r) => !r.union && !r.error && r.uniqueTp.length);
		if (uniq.length) {
			L.push('Edges found by one strategy and no other:');
			L.push('');
			for (const r of uniq) L.push('- `' + r.id + '` — ' + r.uniqueTp.map((k) => '`' + k + '`').join(', '));
			L.push('');
		}

		if (run.tier2) {
			L.push('## Tier 2 — cited works the collection does not hold');
			L.push('');
			L.push(run.tier2.externalDois + ' external DOIs. Presence is reliable, absence is not, so');
			L.push('`recall ≥` is a lower bound and `unconf` is not an error count.');
			L.push('');
			L.push('| strategy | emitted by namespace | TP | missed | unconf | defects | recall ≥ | ref: nodes |');
			L.push('|---|---|---|---|---|---|---|---|');
			for (const r of run.results) {
				if (r.error || !r.external) continue;
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
				for (const r of defects) {
					L.push('**`' + r.id + '`**');
					L.push('');
					for (const s of r.external.suffixArtifacts) L.push('- suffix artifact — `' + s + '`');
					for (const t of r.external.truncated) L.push('- truncated — `' + t + '`');
					L.push('');
				}
			}
		}

		if (baseline) {
			L.push('## Against the baseline');
			L.push('');
			const bc = baseline.conditions || {};
			L.push('`' + basePath + '`, measured ' + (bc.when || 'unknown') + ' at commit `' + (bc.commit || '?') + '`.');
			if (bc.dbSha && bc.dbSha !== c.dbSha) L.push('');
			if (bc.dbSha && bc.dbSha !== c.dbSha) {
				L.push('> **The dataset changed** (`' + bc.dbSha + '` → `' + c.dbSha
					+ '`). Differences below are not attributable to the code alone.');
			}
			if (bc.groundTruthSha && bc.groundTruthSha !== c.groundTruthSha) {
				L.push('');
				L.push('> **The answer key changed** (`' + bc.groundTruthSha + '` → `' + c.groundTruthSha
					+ '`). Scores are against different keys and are not directly comparable.');
			}
			L.push('');
			L.push('| strategy | TP | FP | ext TP | defects |');
			L.push('|---|---|---|---|---|');
			const bm = new Map((baseline.results || []).map((r) => [r.id, r]));
			for (const r of run.results) {
				if (r.error) continue;
				const b = bm.get(r.id);
				if (!b || b.error) { L.push('| `' + r.id + '` | new | | | |'); continue; }
				const d = (x, y) => (y - x === 0 ? '—' : (y - x > 0 ? '+' : '') + (y - x));
				L.push('| `' + r.id + '` | ' + d(b.tp, r.tp) + ' | ' + d(b.fp, r.fp) + ' | '
					+ (r.external && b.external ? d(b.external.tp, r.external.tp) : '—') + ' | '
					+ (r.external && b.external ? d(b.external.defects, r.external.defects) : '—') + ' |');
			}
			L.push('');
		}
		return L.join('\n') + '\n';
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
