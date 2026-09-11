'use strict';

/**
 * Score the edge strategies against the hand-built answer key.
 *
 *   node tools/accuracy/score.js --data-dir "C:/Users/me/Zotero citation_graph_testing"
 *   node tools/accuracy/score.js --db ./snap.sqlite          (Zotero running: use a copy)
 *   node tools/accuracy/score.js --enable openalex --api-key KEY
 *   node tools/accuracy/score.js --json out.json
 *
 * The bench in tools/bench measures how fast the graph draws. This measures
 * whether the edges in it are true, which is a different question and needs a
 * different instrument: a fixed collection whose citations were read by hand
 * (tools/accuracy/ground-truth.json, built from the citing PDFs and never from
 * a metadata API -- an answer key resolved through OpenAlex would score
 * edges/openalex.js against itself).
 *
 * Scored at WORK level, not item level. The collection deliberately holds one
 * work twice, so an item-level count would let a strategy score the same
 * citation twice and would punish one that correctly merged the duplicate.
 * Key -> work collapsing happens before anything is counted; an edge between
 * the two copies of the same work becomes a self-loop and is reported on its
 * own line rather than as a false positive, because it is a duplicate-merging
 * failure and not a wrong citation.
 *
 * Only edges between works the collection HOLDS are scored. A strategy that
 * emits A -> doi:<not held> is naming a ghost, which the answer key says
 * nothing about; those are counted and reported, never graded.
 */

const fs = require('fs');
const path = require('path');
const { LocalSqliteAdapter } = require('../../addon/citation-graph/adapters/localSqlite');
const cg = require('../../addon/citation-graph/index');

const GT_PATH = path.join(__dirname, 'ground-truth.json');

function parseArgs(argv) {
	const a = { dataDir: null, db: null, enable: null, apiKey: null, json: null, help: false };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		const next = () => argv[++i];
		if (k === '--data-dir') a.dataDir = next();
		else if (k === '--db') a.db = next();
		else if (k === '--enable') a.enable = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--api-key') a.apiKey = next();
		else if (k === '--json') a.json = next();
		else if (k === '--help' || k === '-h') a.help = true;
	}
	return a;
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const pct = (x) => (x * 100).toFixed(0) + '%';

/** f1 of 0 precision and 0 recall is 0, not NaN. */
function f1(p, r) { return p + r === 0 ? 0 : (2 * p * r) / (p + r); }

function main() {
	const args = parseArgs(process.argv);
	if (args.help || (!args.dataDir && !args.db)) {
		console.log('usage: node tools/accuracy/score.js --data-dir <zotero data dir> [--db <copy of zotero.sqlite>]');
		console.log('       [--enable a,b,c] [--api-key KEY] [--json out.json]');
		process.exit(args.help ? 0 : 1);
	}

	const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));

	// key -> work id. A work held twice contributes both of its keys.
	const keyToWork = new Map();
	for (const w of gt.works) for (const k of w.itemKeys) keyToWork.set(k, w.id);
	const workById = new Map(gt.works.map((w) => [w.id, w]));

	const truth = new Set(gt.edges.map((e) => e.from + ' -> ' + e.to));
	// Edges whose citing work is held WITHOUT a PDF are real, but no PDF-reading
	// strategy can reach them. Recall is reported against both populations so an
	// offline strategy is not marked down for a citation it had no way to read,
	// and a metadata-backed one still gets credit for finding it.
	const reachable = new Set(
		gt.edges.filter((e) => e.citingPdfHeld !== false).map((e) => e.from + ' -> ' + e.to)
	);
	const traps = gt.expectedNonEdges.filter((t) => t.from !== '*' && t.to !== '*');
	const controlWorks = new Set(
		gt.expectedNonEdges.filter((t) => t.from === '*' || t.to === '*')
			.map((t) => (t.from === '*' ? t.to : t.from))
	);

	const adapter = new LocalSqliteAdapter({
		dataDir: args.dataDir,
		dbPath: args.db || undefined,
	});

	const ids = args.enable || cg.listStrategies().filter((p) => !p.requiresNetwork).map((p) => p.id);
	const providerOpts = args.apiKey ? { openalex: { apiKey: args.apiKey } } : {};

	return (async () => {
		const results = [];
		for (const id of ids) {
			let r;
			try {
				r = await cg.build(adapter, { enable: [id], providers: providerOpts });
			} catch (e) {
				results.push({ id, error: e.message });
				continue;
			}
			results.push({ id, ...grade(r.edges), errors: (r.meta && r.meta.errors) || [] });
		}

		// Every strategy at once, as the plugin actually ships it.
		let union = null;
		try {
			const r = await cg.build(adapter, { enable: ids, providers: providerOpts });
			union = { id: 'ALL (union)', ...grade(r.edges), errors: (r.meta && r.meta.errors) || [] };
		} catch (e) { union = { id: 'ALL (union)', error: e.message }; }

		report(results, union);
		if (args.json) {
			fs.writeFileSync(args.json, JSON.stringify({ groundTruth: GT_PATH, results, union }, null, 1));
			console.log('\nwrote', args.json);
		}
	})();

	/** Collapse an edge list to works and compare it with the key. */
	function grade(edges) {
		const seen = new Set();
		let ghost = 0, selfLoop = 0;
		for (const e of edges) {
			const from = keyToWork.get(e.from), to = keyToWork.get(e.to);
			// Either endpoint outside the held collection: a ghost. Not graded.
			if (!from || !to) { ghost++; continue; }
			if (from === to) { selfLoop++; continue; }
			seen.add(from + ' -> ' + to);
		}
		const tp = [...seen].filter((k) => truth.has(k));
		const fp = [...seen].filter((k) => !truth.has(k));
		const fn = [...truth].filter((k) => !seen.has(k));
		const precision = seen.size ? tp.length / seen.size : 0;
		const recall = truth.size ? tp.length / truth.size : 0;
		const tpReach = tp.filter((k) => reachable.has(k));
		const recallReachable = reachable.size ? tpReach.length / reachable.size : 0;
		const trapsHit = traps.filter((t) => seen.has(t.from + ' -> ' + t.to));
		const controlHit = [...seen].filter((k) => {
			const [a, b] = k.split(' -> ');
			return controlWorks.has(a) || controlWorks.has(b);
		});
		return {
			predicted: seen.size, tp: tp.length, fp: fp.length, fn: fn.length,
			precision, recall, recallReachable, f1: f1(precision, recall),
			ghostEdges: ghost, duplicateSelfLoops: selfLoop,
			trapsHit: trapsHit.map((t) => t.from + ' -> ' + t.to + '  [' + t.trap + ']'),
			controlHit,
			falsePositives: fp, missed: fn,
		};
	}

	function report(results, union) {
		console.log('Accuracy against', path.relative(process.cwd(), GT_PATH));
		console.log(gt.works.length, 'works ·', gt.edges.length, 'true edges (' + reachable.size +
			' reachable from a held PDF) · scored at work level');
		console.log('recall = against all ' + gt.edges.length + '; rec/pdf = against the ' + reachable.size +
			' a PDF-reading strategy can actually reach\n');

		console.log(pad('strategy', 14), rpad('pred', 5), rpad('TP', 4), rpad('FP', 4), rpad('FN', 4),
			rpad('prec', 6), rpad('recall', 7), rpad('rec/pdf', 8), rpad('F1', 6), rpad('dup', 4), ' traps');
		const rows = [...results, union].filter(Boolean);
		for (const r of rows) {
			if (r.error) { console.log(pad(r.id, 14), ' ERROR:', r.error); continue; }
			console.log(
				pad(r.id, 14), rpad(r.predicted, 5), rpad(r.tp, 4), rpad(r.fp, 4), rpad(r.fn, 4),
				rpad(pct(r.precision), 6), rpad(pct(r.recall), 7), rpad(pct(r.recallReachable), 8), rpad(r.f1.toFixed(2), 6),
				rpad(r.duplicateSelfLoops, 4),
				' ' + (r.trapsHit.length ? r.trapsHit.length + ' HIT' : '-')
			);
		}

		console.log('\nceilings the collection imposes (no strategy can beat these):');
		console.log('  printed DOI            ', gt.summary.ceilingPrintedDoiOnly);
		console.log('  printed title (exact)  ', gt.summary.ceilingTitleMatchExact);
		console.log('  PDF link annotation    ', gt.summary.ceilingPdfLinkOnly);
		console.log('  all three channels     ', gt.summary.ceilingAllThreeChannels);

		for (const r of rows) {
			if (r.error || (!r.trapsHit.length && !r.controlHit.length && !r.falsePositives.length)) continue;
			console.log('\n' + r.id + ':');
			for (const t of r.trapsHit) console.log('   TRAP  ', t);
			for (const c of r.controlHit) console.log('   CONTROL violated  ', c);
			for (const fp of r.falsePositives) {
				if (r.trapsHit.some((t) => t.startsWith(fp))) continue;
				console.log('   FP    ', fp);
			}
		}

		const best = rows.filter((r) => !r.error).sort((a, b) => b.recall - a.recall)[0];
		if (best) {
			console.log('\nmissed by ' + best.id + ' (' + best.missed.length + '):');
			for (const m of best.missed) {
				const [a, b] = m.split(' -> ');
				const e = gt.edges.find((x) => x.from === a && x.to === b);
				const why = e && !e.doi && !e.title ? 'author-year only' :
					e && !e.doi && e.title ? 'title only' : e && e.doi && !e.title ? 'DOI only' : '';
				console.log('   ', pad(m, 34), why, e && e.note ? '- ' + e.note.slice(0, 70) : '');
			}
		}
	}
}

main();
