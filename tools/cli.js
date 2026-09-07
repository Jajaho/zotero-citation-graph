'use strict';

/**
 * Benchmark harness: run any combination of strategies over a real Zotero data
 * directory and print what each contributed, plus a pairwise overlap matrix.
 *
 *   node citation-graph/cli.js --data-dir "C:/Users/me/Zotero" --db ./z.sqlite
 *   node citation-graph/cli.js --enable pdf-links,title-match
 *   node citation-graph/cli.js --enable openalex --mailto me@example.com
 *   node citation-graph/cli.js --compare pdf-links,text-doi,title-match,openalex
 *
 * --compare runs each named strategy on its own, then reports overlap. That is
 * how the precision question gets settled: an edge found only by title-match
 * and by nothing else is the population to hand-check.
 */

const path = require('path');
const fs = require('fs');
const { LocalSqliteAdapter } = require('../addon/citation-graph/adapters/localSqlite');
const cg = require('../addon/citation-graph/index');

function parseArgs(argv) {
	const a = { dataDir: null, db: null, enable: null, disable: [], offline: false, compare: null, json: null, mailto: null, apiKey: null };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		const next = () => argv[++i];
		if (k === '--data-dir') a.dataDir = next();
		else if (k === '--db') a.db = next();
		else if (k === '--enable') a.enable = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--disable') a.disable = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--compare') a.compare = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--offline') a.offline = true;
		else if (k === '--json') a.json = next();
		else if (k === '--mailto') a.mailto = next();
		else if (k === '--api-key') a.apiKey = next();
		else if (k === '--list') a.list = true;
		else if (k === '--help' || k === '-h') a.help = true;
	}
	return a;
}

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

(async () => {
	const args = parseArgs(process.argv);

	if (args.help) {
		console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^\s*\*ᅠ?/gm, ''));
		return;
	}
	if (args.list) {
		console.log('Registered strategies:\n');
		for (const s of cg.listStrategies()) {
			console.log(' ', pad(s.id, 14), pad(s.requiresNetwork ? 'network' : 'offline', 9),
				pad(s.defaultEnabled ? 'on' : 'off', 4), 'conf=' + s.defaultConfidence, ' ', s.label);
		}
		return;
	}
	if (!args.dataDir) {
		console.error('error: --data-dir is required (path to the Zotero data directory)');
		process.exit(2);
	}

	const adapter = new LocalSqliteAdapter({
		dataDir: args.dataDir,
		dbPath: args.db ? path.resolve(args.db) : undefined,
	});

	const providerOpts = {};
	if (args.mailto || args.apiKey) providerOpts.openalex = { mailto: args.mailto, apiKey: args.apiKey };

	// ---- comparison mode: one run per strategy, then overlap ----
	if (args.compare) {
		const sets = new Map();
		for (const id of args.compare) {
			const t = Date.now();
			const r = await cg.build(adapter, { enable: [id], providers: providerOpts });
			const s = new Set(r.edges.map((e) => e.from + ' ' + e.to));
			sets.set(id, s);
			const nodes = new Set();
			for (const e of r.edges) { nodes.add(e.from); nodes.add(e.to); }
			console.log(pad(id, 14), rpad(s.size, 5), 'edges', rpad(nodes.size, 5), 'nodes',
				rpad(((Date.now() - t) / 1000).toFixed(1) + 's', 8),
				r.meta.errors.length ? 'ERRORS: ' + JSON.stringify(r.meta.errors) : '');
		}

		const ids = [...sets.keys()];
		const union = new Set();
		for (const s of sets.values()) for (const e of s) union.add(e);
		console.log('\nUNION:', union.size, 'edges');

		console.log('\nPairwise overlap (row ∩ col):');
		console.log(pad('', 14) + ids.map((i) => rpad(i.slice(0, 11), 12)).join(''));
		for (const a of ids) {
			const row = ids.map((b) => rpad([...sets.get(a)].filter((e) => sets.get(b).has(e)).length, 12)).join('');
			console.log(pad(a, 14) + row);
		}

		console.log('\nEdges unique to one strategy (the population to hand-validate):');
		for (const a of ids) {
			const only = [...sets.get(a)].filter((e) => ids.every((b) => b === a || !sets.get(b).has(e)));
			console.log(' ', pad(a, 14), rpad(only.length, 5),
				sets.get(a).size ? '(' + (100 * only.length / sets.get(a).size).toFixed(0) + '% of its own output)' : '');
		}
		return;
	}

	// ---- normal build ----
	let lastNote = '';
	const r = await cg.build(adapter, {
		enable: args.enable,
		disable: args.disable,
		offline: args.offline,
		providers: providerOpts,
		onProgress: ({ provider, done, total }) => {
			const note = `${provider} ${done}/${total}`;
			if (note !== lastNote && done % 25 === 0) { process.stderr.write('\r' + note.padEnd(40)); lastNote = note; }
		},
	});
	process.stderr.write('\r'.padEnd(42) + '\r');

	console.log('index      :', JSON.stringify(r.meta.indexStats));
	console.log('ran        :', r.meta.ran.join(', ') || '(none)');
	if (r.meta.skippedForOffline.length) console.log('skipped    :', r.meta.skippedForOffline.join(', '), '(offline)');
	if (r.meta.errors.length) console.log('errors     :', JSON.stringify(r.meta.errors));
	console.log('\nper strategy:');
	for (const [id, s] of Object.entries(r.meta.perProvider)) {
		console.log(' ', pad(id, 14), rpad(s.produced, 6), 'produced', rpad(s.newEdges, 6), 'new', rpad((s.ms / 1000).toFixed(1) + 's', 8));
	}
	console.log('\nTOTAL', r.edges.length, 'edges over', r.nodeKeys.length, 'of', r.items.length, 'items',
		'in', (r.meta.ms / 1000).toFixed(1) + 's');

	const byN = {};
	for (const e of r.edges) { const n = e.via.length; byN[n] = (byN[n] || 0) + 1; }
	console.log('edges by number of corroborating strategies:', JSON.stringify(byN));

	for (const t of [0.9, 0.7, 0.5]) {
		console.log(`  confidence >= ${t}:`, cg.filterEdges(r.edges, { minConfidence: t }).length, 'edges');
	}

	if (args.json) {
		fs.writeFileSync(args.json, JSON.stringify({
			nodes: r.nodeKeys.map((k) => {
				const it = r.index.byKey.get(k);
				return { key: k, title: it.title, date: it.date, itemType: it.itemType };
			}),
			links: r.edges.map((e) => ({ source: e.from, target: e.to, confidence: e.confidence, via: e.via })),
		}, null, 1));
		console.log('\nwrote', args.json);
	}
})().catch((e) => { console.error(e); process.exit(1); });
