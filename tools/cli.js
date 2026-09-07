'use strict';

/**
 * Benchmark harness: run any combination of strategies over a real Zotero data
 * directory and print what each contributed, plus a pairwise overlap matrix.
 *
 *   node citation-graph/cli.js --data-dir "C:/Users/me/Zotero" --db ./z.sqlite
 *   node citation-graph/cli.js --enable pdf-links,title-match
 *   node citation-graph/cli.js --enable openalex --api-key KEY
 *   node citation-graph/cli.js --compare pdf-links,text-doi,title-match,openalex
 *   node citation-graph/cli.js --include-external      also count works NOT held
 *   node citation-graph/cli.js --include-external --enrich   ...and name them
 *
 * --enrich resolves the outside works' DOIs to titles, authors and global
 * citation counts (OpenAlex). It is the only part of the CLI that touches the
 * network besides --enable openalex, and it implies --include-external.
 *
 * --compare runs each named strategy on its own, then reports overlap. That is
 * how the precision question gets settled: an edge found only by title-match
 * and by nothing else is the population to hand-check.
 */

const path = require('path');
const fs = require('fs');
const { LocalSqliteAdapter } = require('../addon/citation-graph/adapters/localSqlite');
const cg = require('../addon/citation-graph/index');
const { normDoi } = require('../addon/citation-graph/core/normalize');

function parseArgs(argv) {
	const a = { dataDir: null, db: null, enable: null, disable: [], offline: false, compare: null, json: null, apiKey: null, includeExternal: false, enrich: false, maxEnrich: 500 };
	for (let i = 2; i < argv.length; i++) {
		const k = argv[i];
		const next = () => argv[++i];
		if (k === '--data-dir') a.dataDir = next();
		else if (k === '--db') a.db = next();
		else if (k === '--enable') a.enable = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--disable') a.disable = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--compare') a.compare = next().split(',').map((s) => s.trim()).filter(Boolean);
		else if (k === '--offline') a.offline = true;
		else if (k === '--include-external') a.includeExternal = true;
		else if (k === '--json') a.json = next();
		else if (k === '--enrich') { a.enrich = true; a.includeExternal = true; }
		else if (k === '--max-enrich') a.maxEnrich = Number(next());
		else if (k === '--api-key') a.apiKey = next();
		// Accepted and ignored: OpenAlex dropped the polite pool on 13 Feb 2026
		// and the server ignores the parameter. Kept so an old command line
		// fails loudly on the flag rather than silently swallowing its value.
		else if (k === '--mailto') {
			console.error('warning: --mailto is dead (OpenAlex removed the polite pool, Feb 2026); use --api-key');
			next();
		}
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
		console.log('Registered edge strategies:\n');
		for (const s of cg.listStrategies()) {
			console.log(' ', pad(s.id, 14), pad(s.requiresNetwork ? 'network' : 'offline', 9),
				pad(s.defaultEnabled ? 'on' : 'off', 4), 'conf=' + s.defaultConfidence, ' ', s.label);
		}
		console.log('\nRegistered enrichers (--enrich):\n');
		for (const s of cg.listEnrichers()) {
			console.log(' ', pad(s.id, 14), pad(s.requiresNetwork ? 'network' : 'offline', 9),
				pad(s.defaultEnabled ? 'on' : 'off', 4), 'ns=' + s.supports.join('|'), ' ', s.label);
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
	if (args.apiKey) providerOpts.openalex = { apiKey: args.apiKey };

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
		includeExternal: args.includeExternal,
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
	// nodeKeys includes out-of-collection targets when --include-external is on,
	// so count the two populations separately rather than printing "3969 of 395".
	const held = r.nodeKeys.filter((k) => r.index.byKey.has(k)).length;
	console.log('\nTOTAL', r.edges.length, 'edges over', held, 'of', r.items.length, 'items'
		+ (r.externalNodes.length ? ' (+' + r.externalNodes.length + ' outside)' : ''),
	'in', (r.meta.ms / 1000).toFixed(1) + 's');

	const byN = {};
	for (const e of r.edges) { const n = e.via.length; byN[n] = (byN[n] || 0) + 1; }
	console.log('edges by number of corroborating strategies:', JSON.stringify(byN));

	let metadata = Object.create(null);
	if (args.includeExternal) {
		// Nearly all of these are cited exactly once, which is why the plugin
		// filters on the count rather than showing them all.
		const hist = {};
		for (const x of r.externalNodes) {
			const b = x.citedBy >= 5 ? '5+' : String(x.citedBy);
			hist[b] = (hist[b] || 0) + 1;
		}
		console.log('\noutside works cited:', r.externalNodes.length, 'by citedBy:', JSON.stringify(hist));

		if (args.enrich) {
			// Held items are looked up too, exactly as the plugin does: sizing or
			// ranking by global citations is meaningless if only half the graph
			// has a count. Both populations key off the same doi: namespace.
			const heldByDoiKey = new Map();
			for (const it of r.items) {
				const d = normDoi(it.doi);
				if (d) heldByDoiKey.set('doi:' + d, it.key);
			}
			const toName = [...new Set([
				...r.externalNodes.slice(0, args.maxEnrich).map((x) => x.key),
				...heldByDoiKey.keys(),
			])];
			process.stderr.write(`resolving ${toName.length} identifiers…\r`);
			const e = await cg.enrich(toName, {
				providers: { openalex: { apiKey: args.apiKey || null } },
			});
			process.stderr.write(''.padEnd(40) + '\r');
			metadata = e.metadata;
			console.log('enriched  :', e.meta.resolved, 'of', e.meta.requested,
				`(${heldByDoiKey.size} held, ${toName.length - heldByDoiKey.size} outside)`,
				'via', e.meta.ran.join(', ') || '(none)', 'in', (e.meta.ms / 1000).toFixed(1) + 's');
			if (e.meta.errors.length) console.log('errors    :', JSON.stringify(e.meta.errors));

			// The comparison the graph's two sizing modes make visually: what this
			// library leans on, versus what the literature does.
			const held = [...heldByDoiKey].map(([dk, key]) => ({ key, m: metadata[dk] }))
				.filter((x) => x.m && x.m.citedByGlobal != null)
				.sort((a, b) => b.m.citedByGlobal - a.m.citedByGlobal);
			if (held.length) {
				console.log('\nheld items, most cited globally:');
				for (const h of held.slice(0, 5)) {
					console.log(' ', rpad(h.m.citedByGlobal, 8), pad(h.key, 10),
						String(h.m.title || '').slice(0, 58));
				}
			}
		}

		// "cited by N here" is the signal the ghost feature exists to surface;
		// the global count is context and is printed second, never sorted on.
		console.log('most cited (here):');
		for (const x of r.externalNodes.slice(0, 10)) {
			const m = metadata[x.key];
			const name = m && m.title
				? (m.creators || []).slice(0, 1).join('') + (m.year || '') + ' — ' + m.title.slice(0, 52)
				: '';
			console.log(' ', rpad(x.citedBy, 4), pad(x.key, 44),
				pad(m && m.citedByGlobal != null ? m.citedByGlobal + ' cites' : '', 12), name || x.via.join(','));
		}
	}

	for (const t of [0.9, 0.7, 0.5]) {
		console.log(`  confidence >= ${t}:`, cg.filterEdges(r.edges, { minConfidence: t }).length, 'edges');
	}

	if (args.json) {
		fs.writeFileSync(args.json, JSON.stringify({
			// nodeKeys includes out-of-collection targets under --include-external,
			// and those are not in the index -- fall back to whatever the
			// enrichment phase learned, or to the bare identifier.
			nodes: r.nodeKeys.map((k) => {
				const it = r.index.byKey.get(k);
				if (it) return { key: k, title: it.title, date: it.date, itemType: it.itemType };
				const m = metadata[k];
				return {
					key: k,
					external: true,
					title: (m && m.title) || null,
					date: m && m.year != null ? String(m.year) : null,
					itemType: (m && m.itemType) || null,
					citedByGlobal: (m && m.citedByGlobal) != null ? m.citedByGlobal : null,
				};
			}),
			links: r.edges.map((e) => ({ source: e.from, target: e.to, confidence: e.confidence, via: e.via })),
		}, null, 1));
		console.log('\nwrote', args.json);
	}
})().catch((e) => { console.error(e); process.exit(1); });
