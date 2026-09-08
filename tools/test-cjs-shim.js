'use strict';

/**
 * Pre-flight for addon/lib/cjs.js.
 *
 * The shim depends on Services.scriptloader.loadSubScriptWithOptions() executing
 * a file with a plain object as its global-ish target. This harness fakes that
 * with vm.runInNewContext so the resolver and the module cache can be exercised
 * under Node, before any of it runs inside Zotero.
 *
 * It proves the thing that actually matters: that citation-graph/ -- the whole
 * tree, unmodified -- loads through this loader.
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const addonDir = path.join(__dirname, '..', 'addon');
const rootURI = pathToFileURL(addonDir).href + '/';

// --- fake just enough of the Zotero chrome sandbox --------------------------
const Services = {
	scriptloader: {
		loadSubScriptWithOptions(url, opts) {
			const file = fileURLToPath(url);
			const code = fs.readFileSync(file, 'utf8');
			const ctx = vm.createContext(opts.target);
			vm.runInContext(code, ctx, { filename: file });
		},
	},
};

// --- load the shim exactly as bootstrap.js does -----------------------------
const shim = { Services, URL };
Services.scriptloader.loadSubScriptWithOptions(rootURI + 'lib/cjs.js', { target: shim });

if (typeof shim.makeRequire !== 'function') {
	console.error('FAIL: cjs.js did not define makeRequire');
	process.exit(1);
}

// Stubs for the chrome globals lib/ touches. Nothing here is exercised beyond
// module load -- the point is that the chrome modules parse and resolve through
// the same loader, so a typo cannot wait until Zotero is running to show up.
const Zotero = {
	debug: () => {},
	logError: () => {},
	Promise: { delay: ms => new Promise(r => setTimeout(r, ms)) },
	DataDirectory: { dir: addonDir },
	// lib/l10n.js reads its .ftl through these two, so the chrome side of
	// localisation runs here exactly as it does inside Zotero.
	locale: 'en-US',
	File: { getResourceAsync: async url => fs.readFileSync(fileURLToPath(url), 'utf8') },
};

const require_ = shim.makeRequire(rootURI, {
	Services, URL, console,
	Zotero,
	IOUtils: {
		exists: async () => false,
		read: async () => new Uint8Array(),
		stat: async () => ({ size: 0, lastModified: 0 }),
		readJSON: async () => { throw new Error('no cache'); },
		writeJSON: async () => {},
		makeDirectory: async () => {},
	},
	PathUtils: { join: (...p) => p.join('/'), parent: p => p.slice(0, p.lastIndexOf('/')) },
	setTimeout, clearTimeout,
	fetch: () => { throw new Error('network disabled in this harness'); },
});

// Started here rather than inside a check, because several checks want the
// strings loaded and the chrome side loads them exactly once, at startup.
const l10nReady = require_('./lib/l10n.js').load(rootURI);

let failures = 0;
const pending = [];

function check(label, fn) {
	const run = (async () => {
		try {
			await fn();
			console.log('  ok    ' + label);
		}
		catch (e) {
			console.log('  FAIL  ' + label + ' -- ' + e.message);
			failures++;
		}
	})();
	pending.push(run);
	return run;
}

console.log('cjs shim pre-flight (rootURI=' + rootURI + ')\n');

check('loads citation-graph/index.js through the shim', () => {
	const cg = require_('./citation-graph/index.js');
	if (typeof cg.build !== 'function') throw new Error('no build()');
	if (typeof cg.filterEdges !== 'function') throw new Error('no filterEdges()');
	if (typeof cg.listStrategies !== 'function') throw new Error('no listStrategies()');
});

check('all four strategies registered via nested requires', () => {
	const cg = require_('./citation-graph/index.js');
	// Ignore anything a later check registers -- the registry is process-wide and
	// this must not depend on which check ran first.
	const ids = cg.listStrategies().map(s => s.id).filter(id => !id.startsWith('test-')).sort();
	const want = ['openalex', 'pdf-links', 'text-doi', 'title-match'];
	if (JSON.stringify(ids) !== JSON.stringify(want)) {
		throw new Error('got ' + JSON.stringify(ids));
	}
});

check('module cache returns the same instance (no double registration)', () => {
	const a = require_('./citation-graph/index.js');
	const b = require_('./citation-graph/index.js');
	if (a !== b) throw new Error('two different module instances');
});

check('extensionless specifier resolves to .js', () => {
	const n = require_('./citation-graph/core/normalize');
	if (typeof n.normDoi !== 'function') throw new Error('no normDoi()');
});

check('normalize behaves identically to the Node-loaded copy', () => {
	const viaShim = require_('./citation-graph/core/normalize');
	const viaNode = require(path.join(addonDir, 'citation-graph/core/normalize.js'));
	const cases = ['https://doi.org/10.1038/NATURE12373', 'doi: 10.1103/PhysRevX.5.041037.', 'nonsense'];
	for (const c of cases) {
		if (viaShim.normDoi(c) !== viaNode.normDoi(c)) throw new Error('mismatch on ' + c);
	}
});

check('graphBuilder runs end-to-end against a stub adapter', () => {
	const cg = require_('./citation-graph/index.js');
	const items = [
		{ key: 'A', itemType: 'journalArticle', title: 'Nanometre-scale thermometry in a living cell', doi: '10.1038/nature12373', date: '2013', creators: ['Kucsko'] },
		{ key: 'B', itemType: 'journalArticle', title: 'A paper that cites the thermometry work and has a long enough title', doi: '10.1000/x', date: '2015', creators: ['Smith'] },
	];
	// segment() refuses text under 200 chars, so pad the body -- a real PDF's
	// text is never this short, and the guard is deliberate.
	const body = 'Introduction. '.repeat(30)
		+ '\nReferences\n'
		+ '[1] Kucsko et al. Nanometre-scale thermometry in a living cell. Nature 2013.\n'
		+ '[2] Someone else. An unrelated work not in this collection. Journal 2011.\n';
	const adapter = {
		listItems: async () => items,
		getAttachments: async k => (k === 'B' ? [{ key: 'B1', parentKey: 'B', contentType: 'application/pdf' }] : []),
		getAttachmentText: async () => body,
		getPdfLinkUris: async () => [],
	};
	return cg.build(adapter, { offline: true }).then((r) => {
		if (!r.edges.some(e => e.from === 'B' && e.to === 'A')) {
			throw new Error('expected B -> A edge, got ' + JSON.stringify(r.edges));
		}
		if (r.edges.some(e => e.from === e.to)) {
			throw new Error('self-edge leaked through');
		}
	});
});

check('short text is refused by segmentation (no bogus edges)', () => {
	const cg = require_('./citation-graph/index.js');
	const adapter = {
		listItems: async () => ([
			{ key: 'A', itemType: 'journalArticle', title: 'Nanometre-scale thermometry in a living cell', doi: null, date: '2013', creators: ['Kucsko'] },
			{ key: 'B', itemType: 'journalArticle', title: 'Another paper with a sufficiently long title here', doi: null, date: '2015', creators: ['Smith'] },
		]),
		getAttachments: async () => [{ key: 'X', contentType: 'application/pdf' }],
		getAttachmentText: async () => 'Nanometre-scale thermometry in a living cell',
		getPdfLinkUris: async () => [],
	};
	return cg.build(adapter, { offline: true }).then((r) => {
		if (r.edges.length) throw new Error('expected no edges, got ' + r.edges.length);
	});
});

// --- external (out-of-collection) nodes -------------------------------------

/** One item citing three DOIs, only one of which the collection holds. */
function externalFixture() {
	const items = [
		{ key: 'AAAAAAAA', itemType: 'journalArticle', title: 'Citing paper with a nice long title', doi: '10.1000/citing', date: '2020', creators: ['Smith'] },
		{ key: 'BBBBBBBB', itemType: 'journalArticle', title: 'Nanometre-scale thermometry in a living cell', doi: '10.1038/nature12373', date: '2013', creators: ['Kucsko'] },
		{ key: 'CCCCCCCC', itemType: 'journalArticle', title: 'A second citing paper with a long enough title', doi: '10.1000/citing2', date: '2021', creators: ['Jones'] },
	];
	return {
		listItems: async () => items,
		getAttachments: async k => (k === 'BBBBBBBB' ? [] : [{ key: k + '1', parentKey: k, contentType: 'application/pdf' }]),
		getAttachmentText: async () => null,
		getPdfLinkUris: async (attKey) => {
			// Both citing papers link the same outside work; only one links the
			// second outside work. That difference is what citedBy has to capture.
			const common = ['https://doi.org/10.1038/nature12373', 'https://doi.org/10.5555/shared'];
			return attKey === 'AAAAAAAA1' ? common.concat('https://doi.org/10.5555/lonely') : common;
		},
	};
}

check('external targets are dropped unless includeExternal is set', () => {
	const cg = require_('./citation-graph/index.js');
	return cg.build(externalFixture(), { enable: ['pdf-links'], offline: true }).then((r) => {
		if (r.externalNodes.length) throw new Error('leaked ' + r.externalNodes.length + ' external nodes');
		// The in-collection edges must be entirely unaffected by the new code path.
		const keys = r.edges.map(e => e.from + '->' + e.to).sort();
		if (JSON.stringify(keys) !== JSON.stringify(['AAAAAAAA->BBBBBBBB', 'CCCCCCCC->BBBBBBBB'])) {
			throw new Error('in-collection edges changed: ' + JSON.stringify(keys));
		}
	});
});

check('includeExternal adds ghost nodes with a citedBy count', () => {
	const cg = require_('./citation-graph/index.js');
	return cg.build(externalFixture(), { enable: ['pdf-links'], offline: true, includeExternal: true }).then((r) => {
		const byKey = Object.fromEntries(r.externalNodes.map(x => [x.key, x]));
		if (!byKey['doi:10.5555/shared']) throw new Error('missing shared external node');
		if (byKey['doi:10.5555/shared'].citedBy !== 2) {
			throw new Error('shared citedBy = ' + byKey['doi:10.5555/shared'].citedBy);
		}
		if (byKey['doi:10.5555/lonely'].citedBy !== 1) throw new Error('lonely citedBy wrong');
		// Sorted most-cited first, which is what makes the payload cap safe.
		if (r.externalNodes[0].key !== 'doi:10.5555/shared') throw new Error('not sorted by citedBy');
		// A work the collection DOES hold must stay a real node, never a ghost.
		if (byKey['doi:10.1038/nature12373']) throw new Error('resolved DOI became a ghost');
	});
});

check('an edge between two outside works is never kept', () => {
	const cg = require_('./citation-graph/index.js');
	const registry = require_('./citation-graph/core/registry');
	// Register a deliberately misbehaving provider rather than trusting that no
	// real one ever does this: the citing side must be a collection item.
	if (!registry._providers.has('test-rogue')) {
		registry.register({
			id: 'test-rogue',
			label: 'rogue',
			defaultEnabled: false,
			derive: () => [{ from: 'doi:10.1/a', to: 'doi:10.1/b', via: 'test-rogue', confidence: 1 }],
		});
	}
	return cg.build(externalFixture(), { enable: ['test-rogue'], offline: true, includeExternal: true })
		.then((r) => {
			if (r.edges.length) throw new Error('kept ' + r.edges.length + ' ghost-to-ghost edges');
		});
});

check('external keys cannot collide with Zotero item keys', () => {
	const t = require_('./citation-graph/core/types');
	// Zotero item keys are 8 uppercase alphanumerics -- no colon, so no overlap.
	if (t.isExternalKey('ABCD1234')) throw new Error('item key read as external');
	if (!t.isExternalKey('doi:10.1038/nature12373')) throw new Error('doi key not recognised');
	if (t.isExternalKey('nonsense:x')) throw new Error('unknown namespace accepted');
	const p = t.parseExternalKey(t.externalKey('doi', '10.1038/nature12373'));
	if (p.ns !== 'doi' || p.id !== '10.1038/nature12373') throw new Error('round-trip failed');
});

check('collectExternalNodes merges across separate builds without double-counting', () => {
	const cg = require_('./citation-graph/index.js');
	// The plugin runs text strategies and the PDF scan as two builds, so the same
	// outside work can appear in both edge lists. Summing the two builds' counts
	// would say 2 citers where there is 1.
	const edges = [
		{ from: 'AAAAAAAA', to: 'doi:10.5555/x', confidence: 0.9, via: ['text-doi'] },
		{ from: 'AAAAAAAA', to: 'doi:10.5555/x', confidence: 0.95, via: ['pdf-links'] },
	];
	const merged = require_('./lib/graphTab.js').mergeEdges([edges[0]], [edges[1]]);
	const out = cg.collectExternalNodes(merged, () => false);
	if (out.length !== 1) throw new Error('expected 1 external node, got ' + out.length);
	if (out[0].citedBy !== 1) throw new Error('double-counted: citedBy = ' + out[0].citedBy);
	if (out[0].via.length !== 2) throw new Error('lost provenance: ' + JSON.stringify(out[0].via));
});

// --- metadata enrichment ----------------------------------------------------

/** A canned OpenAlex /works response, in the shape the real API returns. */
function fakeOpenAlex(results) {
	return async (url) => ({
		ok: true,
		status: 200,
		_url: url,
		json: async () => ({ results }),
	});
}

check('the enrich registry is separate from the edge registry', () => {
	const cg = require_('./citation-graph/index.js');
	// Same id, two populations. If these ever shared a registry, registering the
	// enricher would have thrown on the duplicate 'openalex'.
	if (cg.registry === cg.enrichRegistry) throw new Error('one registry, not two');
	const ids = cg.listEnrichers().map(e => e.id).filter(id => !id.startsWith('test-'));
	if (JSON.stringify(ids) !== JSON.stringify(['openalex'])) {
		throw new Error('enrichers: ' + JSON.stringify(ids));
	}
	const oa = cg.listEnrichers().find(e => e.id === 'openalex');
	// Off by default: the plugin must not start using the network silently.
	if (oa.defaultEnabled) throw new Error('openalex enricher is on by default');
	if (!oa.requiresNetwork) throw new Error('openalex enricher not marked network');
});

check('both registries share one select() so offline means one thing', () => {
	const cg = require_('./citation-graph/index.js');
	const a = cg.registry.select({ enable: ['openalex'], offline: true });
	const b = cg.enrichRegistry.select({ enable: ['openalex'], offline: true });
	if (a.providers.length || b.providers.length) throw new Error('offline let a network provider through');
	if (JSON.stringify(a.skippedForOffline) !== JSON.stringify(b.skippedForOffline)) {
		throw new Error('registries disagree about what offline skipped');
	}
});

check('openalex enricher builds one filtered call and maps the response back', () => {
	const cg = require_('./citation-graph/index.js');
	const seen = [];
	const fetchImpl = async (url) => {
		seen.push(url);
		return fakeOpenAlex([
			{
				id: 'https://openalex.org/W2049772957',
				// The API returns DOIs as resolver URLs and in whatever case it
				// stored them; normDoi has to close that loop for the key to match.
				doi: 'https://doi.org/10.1038/NATURE12373',
				display_name: 'Nanometre-scale thermometry in a living cell',
				publication_year: 2013,
				authorships: [{ author: { display_name: 'Georg Kucsko' } },
					{ author: { display_name: 'Peter C. Maurer' } }],
				cited_by_count: 1234,
				type: 'article',
			},
		])(url);
	};
	return cg.enrich(['doi:10.1038/nature12373', 'doi:10.5555/missing'], {
		enable: ['openalex'],
		providers: { openalex: { fetchImpl } },
	}).then((r) => {
		const m = r.metadata['doi:10.1038/nature12373'];
		if (!m) throw new Error('did not resolve; got ' + JSON.stringify(Object.keys(r.metadata)));
		if (m.title !== 'Nanometre-scale thermometry in a living cell') throw new Error('title ' + m.title);
		if (m.year !== 2013) throw new Error('year ' + m.year);
		// Surnames only, to match how every other node in the graph is labelled.
		if (JSON.stringify(m.creators) !== JSON.stringify(['Kucsko', 'Maurer'])) {
			throw new Error('creators ' + JSON.stringify(m.creators));
		}
		if (m.citedByGlobal !== 1234) throw new Error('citedByGlobal ' + m.citedByGlobal);
		// The name that must never be `citedBy` -- that one means "citers in this
		// collection" and is computed locally.
		if ('citedBy' in m) throw new Error('enricher leaked a citedBy field');
		// A DOI the API did not return simply has no metadata; it must not appear.
		if (r.metadata['doi:10.5555/missing']) throw new Error('invented metadata');
		// Both DOIs in one request, not two.
		if (seen.length !== 1) throw new Error(seen.length + ' requests, expected 1');
		if (!/filter=doi%3A10\.1038%2Fnature12373%7C10\.5555%2Fmissing/.test(seen[0])) {
			throw new Error('unexpected filter: ' + seen[0]);
		}
		if (r.meta.resolved !== 1 || r.meta.requested !== 2) throw new Error(JSON.stringify(r.meta));
	});
});

check('the API key travels in a header, never in the URL', () => {
	const cg = require_('./citation-graph/index.js');
	let seenUrl = null;
	let seenHeaders = null;
	const fetchImpl = async (url, opts) => {
		seenUrl = url;
		seenHeaders = opts && opts.headers;
		return { ok: true, json: async () => ({ results: [] }) };
	};
	// A real-shaped DOI: normDoi requires 4-9 digits in the registrant code, so
	// '10.1/x' would be rejected before any request was built.
	return cg.enrich(['doi:10.1000/x'], {
		enable: ['openalex'],
		providers: { openalex: { fetchImpl, apiKey: 'SECRET' } },
	}).then(() => {
		if (seenUrl.includes('SECRET')) throw new Error('key leaked into the URL: ' + seenUrl);
		if (seenHeaders.Authorization !== 'Bearer SECRET') {
			throw new Error('no bearer header: ' + JSON.stringify(seenHeaders));
		}
		// mailto was removed by OpenAlex in Feb 2026 and must not be sent.
		if (seenUrl.includes('mailto')) throw new Error('still sending mailto');
	});
});

check('enrichers chain fill-first and are only asked about what is missing', () => {
	const cg = require_('./citation-graph/index.js');
	const enrichRegistry = require_('./citation-graph/core/enrichRegistry');
	const asked = { first: null, second: null };
	if (!enrichRegistry._providers.has('test-first')) {
		enrichRegistry.register({
			id: 'test-first',
			label: 'first',
			requiresNetwork: false,
			supports: ['doi'],
			// Knows a title for A, and a count for neither.
			resolve: ({ refs }) => {
				asked.first = refs.map(r => r.key).sort();
				return [{ key: 'doi:10.1/a', title: 'A title', citedByGlobal: 7 },
					{ key: 'doi:10.1/b', title: 'B title' }];
			},
		});
		enrichRegistry.register({
			id: 'test-second',
			label: 'second',
			requiresNetwork: false,
			supports: ['doi'],
			resolve: ({ refs }) => {
				asked.second = refs.map(r => r.key).sort();
				// Would overwrite A's title if the merge were last-wins.
				return [{ key: 'doi:10.1/a', title: 'WRONG', citedByGlobal: 999 },
					{ key: 'doi:10.1/b', citedByGlobal: 42 }];
			},
		});
	}
	return cg.enrich(['doi:10.1/a', 'doi:10.1/b'], {
		enable: ['test-first', 'test-second'],
	}).then((r) => {
		// A was complete after the first enricher, so the second never saw it.
		if (JSON.stringify(asked.second) !== JSON.stringify(['doi:10.1/b'])) {
			throw new Error('second enricher was asked about ' + JSON.stringify(asked.second));
		}
		if (r.metadata['doi:10.1/a'].title !== 'A title') throw new Error('later enricher overwrote a title');
		if (r.metadata['doi:10.1/a'].citedByGlobal !== 7) throw new Error('later enricher overwrote a count');
		// B was filled across the two, and provenance records both.
		if (r.metadata['doi:10.1/b'].title !== 'B title') throw new Error('lost B title');
		if (r.metadata['doi:10.1/b'].citedByGlobal !== 42) throw new Error('did not fill B count');
		if (JSON.stringify(r.metadata['doi:10.1/b'].source) !== JSON.stringify(['test-first', 'test-second'])) {
			throw new Error('provenance ' + JSON.stringify(r.metadata['doi:10.1/b'].source));
		}
	});
});

check('an enricher is never handed a namespace it does not support', () => {
	const cg = require_('./citation-graph/index.js');
	const enrichRegistry = require_('./citation-graph/core/enrichRegistry');
	let got = null;
	if (!enrichRegistry._providers.has('test-doionly')) {
		enrichRegistry.register({
			id: 'test-doionly',
			label: 'doi only',
			requiresNetwork: false,
			supports: ['doi'],
			resolve: ({ refs }) => { got = refs.map(r => r.ns); return []; },
		});
	}
	return cg.enrich(['doi:10.1/a', 'arxiv:2101.00001', 'not-a-key'], {
		enable: ['test-doionly'],
	}).then((r) => {
		if (JSON.stringify(got) !== JSON.stringify(['doi'])) throw new Error('got ' + JSON.stringify(got));
		// A bare string that is not a namespaced key is dropped, not guessed at.
		if (r.meta.requested !== 2) throw new Error('requested ' + r.meta.requested);
	});
});

check('a failing enricher costs names, not the run', () => {
	const cg = require_('./citation-graph/index.js');
	const enrichRegistry = require_('./citation-graph/core/enrichRegistry');
	if (!enrichRegistry._providers.has('test-boom')) {
		enrichRegistry.register({
			id: 'test-boom',
			label: 'boom',
			requiresNetwork: false,
			supports: ['doi'],
			resolve: () => { throw new Error('429 Too Many Requests'); },
		});
	}
	return cg.enrich(['doi:10.1/a'], { enable: ['test-boom', 'test-first'] }).then((r) => {
		if (r.meta.errors.length !== 1) throw new Error('swallowed or duplicated the error');
		// The enricher after the failure still ran.
		if (!r.metadata['doi:10.1/a']) throw new Error('one failure lost the whole chain');
	});
});

check('enrichment honours the global offline switch', () => {
	const cg = require_('./citation-graph/index.js');
	return cg.enrich(['doi:10.1038/nature12373'], {
		enable: ['openalex'],
		offline: true,
		// Would throw if it were ever called -- the harness has no network.
		providers: { openalex: { fetchImpl: () => { throw new Error('network reached'); } } },
	}).then((r) => {
		if (JSON.stringify(r.meta.skippedForOffline) !== JSON.stringify(['openalex'])) {
			throw new Error('skipped ' + JSON.stringify(r.meta.skippedForOffline));
		}
		if (Object.keys(r.metadata).length) throw new Error('resolved something while offline');
	});
});

check('a cache hit short-circuits the providers entirely', () => {
	const cg = require_('./citation-graph/index.js');
	const enrichRegistry = require_('./citation-graph/core/enrichRegistry');
	let calls = 0;
	if (!enrichRegistry._providers.has('test-counting')) {
		enrichRegistry.register({
			id: 'test-counting',
			label: 'counting',
			requiresNetwork: false,
			supports: ['doi'],
			resolve: ({ refs }) => {
				calls++;
				return refs.map(r => ({ key: r.key, title: 'T', citedByGlobal: 1 }));
			},
		});
	}
	const store = new Map();
	const cache = { get: k => store.get(k) || null, set: (k, m) => store.set(k, m) };
	const cfg = () => ({ enable: ['test-counting'], cache });

	return cg.enrich(['doi:10.1000/a'], cfg()).then((first) => {
		if (calls !== 1) throw new Error('first run made ' + calls + ' provider calls');
		if (first.meta.fromCache !== 0) throw new Error('reported a hit on a cold cache');
		if (!store.has('doi:10.1000/a')) throw new Error('nothing was written back');
		return cg.enrich(['doi:10.1000/a'], cfg());
	}).then((second) => {
		// The whole point: a warm cache costs no requests at all.
		if (calls !== 1) throw new Error('warm run still called the provider (' + calls + ')');
		if (second.meta.fromCache !== 1) throw new Error('fromCache ' + second.meta.fromCache);
		if (second.metadata['doi:10.1000/a'].title !== 'T') throw new Error('lost the cached value');
	});
});

check('a half-answer is never cached, so the chain can still complete it', () => {
	const cg = require_('./citation-graph/index.js');
	const enrichRegistry = require_('./citation-graph/core/enrichRegistry');
	if (!enrichRegistry._providers.has('test-countonly')) {
		enrichRegistry.register({
			id: 'test-countonly',
			label: 'count only',
			requiresNetwork: false,
			supports: ['doi'],
			// Knows the count but not the title -- exactly the case that must not
			// be cached, or the enricher that knows the title never gets asked.
			resolve: ({ refs }) => refs.map(r => ({ key: r.key, citedByGlobal: 5 })),
		});
	}
	const store = new Map();
	const cache = { get: k => store.get(k) || null, set: (k, m) => store.set(k, m) };
	return cg.enrich(['doi:10.1000/b'], { enable: ['test-countonly'], cache }).then(() => {
		if (store.has('doi:10.1000/b')) throw new Error('cached a titleless entry');
	});
});

check('MetadataCache expires on age, unlike the content-stamped PDF cache', () => {
	const { MetadataCache } = require_('./lib/metadataCache.js');
	const c = new MetadataCache('/tmp/nowhere', { ttl: 50 });
	c.set('doi:10.1000/a', { key: 'doi:10.1000/a', title: 'T' });
	if (!c.get('doi:10.1000/a')) throw new Error('fresh entry missed');
	// Backdate past the TTL rather than sleeping.
	c.data.entries['doi:10.1000/a'].at = Date.now() - 1000;
	if (c.get('doi:10.1000/a')) throw new Error('stale entry served');
	// A citation count has no local invalidation signal, which is the whole
	// reason this cache ages out where pdfLinkCache stamps instead.
	if (c.size !== 1) throw new Error('expiry should not evict, only refuse');
});

check('toWireExternal keeps local and global counts as separate fields', () => {
	const { toWireExternal } = require_('./lib/graphTab.js');
	const x = { key: 'doi:10.1/a', ns: 'doi', id: '10.1/a', citedBy: 3, via: ['pdf-links'] };
	const bare = toWireExternal(x, null);
	if (bare.citedBy !== 3) throw new Error('lost the local count');
	if ('citedByGlobal' in bare) throw new Error('invented a global count with no metadata');
	const named = toWireExternal(x, { key: x.key, title: 'T', creators: ['Kucsko'], year: 2013, citedByGlobal: 900 });
	// The distinction the whole ghost feature rests on: 3 papers HERE cite a work
	// the literature cites 900 times. Collapsing these would be a silent bug.
	if (named.citedBy !== 3 || named.citedByGlobal !== 900) throw new Error(JSON.stringify(named));
});

// --- node sizing (content/nodeScale.js) -------------------------------------

/** Evaluate the content-page script the same way the browser does. */
function loadScale() {
	const src = fs.readFileSync(path.join(addonDir, 'content/nodeScale.js'), 'utf8');
	// Deliberately empty: nodeScale.js falls back to globalThis when `window` is
	// absent, and inside a vm context that IS the context object. Defining a
	// `globalThis` key here would shadow it and swallow the export.
	const ctx = {};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'nodeScale.js' });
	if (!ctx.ZGScale) throw new Error('nodeScale.js did not publish ZGScale');
	return ctx.ZGScale;
}

check('the citation scale separates magnitudes instead of flattening them', () => {
	const S = loadScale();
	// A heavy-tailed spread with one landmark, which is the realistic shape.
	const counts = [0, 3, 8, 17, 25, 40, 55, 80, 100, 140, 190, 260, 350, 470,
		640, 900, 1200, 1600, 2200, 4000, 41000];
	const ref = S.referenceCount(counts);
	const r = (g) => S.globalRadius(g, ref);

	// The regression this exists for: the log scale it replaced drew these at
	// 8.5 and 10.8 -- a 1.27x radius for a 40x difference in citations.
	const ratio = r(4000) / r(100);
	if (ratio < 2.5) throw new Error('4000 vs 100 citations is only ' + ratio.toFixed(2) + 'x radius');

	// Strictly increasing across the whole domain: no plateau anywhere.
	for (let i = 1; i < counts.length; i++) {
		if (counts[i] === counts[i - 1]) continue;
		if (!(r(counts[i]) > r(counts[i - 1]))) {
			throw new Error(`not monotone at ${counts[i - 1]} -> ${counts[i]}`);
		}
	}
	// Including above the reference, where a hard clamp used to tie the
	// 41,000-citation landmark with the 4,000-citation one.
	if (!(r(41000) > r(4000))) throw new Error('outliers above the reference are tied');
	if (r(41000) > S.R_HARD) throw new Error('blew through the ceiling');
});

check('one landmark paper cannot flatten the rest of the graph', () => {
	const S = loadScale();
	// Same distribution, once with and once without an extreme outlier. The
	// outlier must not change how the bulk of the graph is drawn -- which is
	// exactly what normalising on the maximum would do.
	const bulk = [];
	for (let i = 0; i < 40; i++) bulk.push(10 * i);
	const withOutlier = bulk.concat([500000]);
	const a = S.referenceCount(bulk);
	const b = S.referenceCount(withOutlier);
	const shift = Math.abs(S.globalRadius(100, a) - S.globalRadius(100, b));
	if (shift > 1.5) throw new Error('outlier moved a typical node by ' + shift.toFixed(1) + ' units');
});

check('unknown counts stay distinguishable from zero counts', () => {
	const S = loadScale();
	// "not looked up" must not read as "never cited".
	const unknown = S.globalRadius(null, 100);
	const zero = S.globalRadius(0, 100);
	if (!(unknown < zero)) throw new Error(`unknown ${unknown} should be smaller than zero ${zero}`);
	if (unknown <= 0) throw new Error('unknown nodes would be invisible');
});

check('areaFor round-trips through force-graph own sqrt', () => {
	const S = loadScale();
	// force-graph draws radius = sqrt(val) * nodeRelSize. If this identity ever
	// breaks, every radius above is silently wrong -- which is the bug class
	// that produced the original flattened scale.
	for (const r of [2, 3, 7.5, 20, 28]) {
		const back = Math.sqrt(S.areaFor(r)) * S.NODE_REL_SIZE;
		if (Math.abs(back - r) > 1e-9) throw new Error(`radius ${r} came back as ${back}`);
	}
});

// --- chrome-side modules ---------------------------------------------------

check('lib/ modules load through the shim', () => {
	const za = require_('./lib/zoteroAdapter.js');
	if (typeof za.ZoteroAdapter !== 'function') throw new Error('no ZoteroAdapter');
	const c = require_('./lib/pdfLinkCache.js');
	if (typeof c.PdfLinkCache !== 'function') throw new Error('no PdfLinkCache');
	const m = require_('./lib/metadataCache.js');
	if (typeof m.MetadataCache !== 'function') throw new Error('no MetadataCache');
	const t = require_('./lib/graphTab.js');
	if (typeof t.open !== 'function') throw new Error('no open()');
	const r = require_('./lib/readerPane.js');
	if (typeof r.open !== 'function' || typeof r.readable !== 'function') {
		throw new Error('readerPane must expose open()/readable()');
	}
	const i = require_('./lib/itemPane.js');
	if (typeof i.show !== 'function') throw new Error('itemPane must expose show()');
	// Closing is the panel's, not either occupant's: one divider puts both away.
	const s = require_('./lib/splitPane.js');
	// The whole surface, not a sample: the module's stylesheet is a template
	// literal, and one stray backtick in a CSS comment ends the string, turns the
	// rest of the file into whatever it happens to parse as, and leaves exports
	// silently missing rather than throwing.
	for (const fn of ['claim', 'has', 'collapsed', 'close']) {
		if (typeof s[fn] !== 'function') throw new Error('splitPane must expose ' + fn + '()');
	}
	if (s.MIN_WIDTH !== 357) throw new Error('splitPane.MIN_WIDTH: ' + s.MIN_WIDTH);
	// Same reasoning as splitPane above: addDialog.js interpolates its own id
	// into a CSS template literal, so its exports are the canary for that string
	// ending where it was meant to.
	const a = require_('./lib/addDialog.js');
	if (typeof a.open !== 'function') throw new Error('addDialog must expose open()');
	if (a.PANEL_WIDTH !== 420) throw new Error('addDialog.PANEL_WIDTH: ' + a.PANEL_WIDTH);
});

/**
 * A window just real enough for splitPane.js and the two things that build into
 * it: elements that can be appended, detached and asked for their first child,
 * since handing the panel over empties it one child at a time.
 */
class FakeElement {
	constructor(localName, made, onRender) {
		this.localName = localName;
		this.children = [];
		this.attrs = {};
		this.className = '';
		this.style = { props: {}, setProperty(k, v) {
			this.props[k] = v;
		} };
		this.parent = null;
		this.removed = false;
		this.listeners = {};
		if (localName === 'item-details') this.render = () => onRender(this);
		// Core's sidenav starts disabled and is told when something is being
		// viewed; record the telling so a check can insist it happened.
		if (localName === 'item-pane-sidenav') {
			this.defaultStatus = true;
			this.toggleDefaultStatus = (val) => {
				this.defaultStatus = val;
				this.toldWhileContainerWas = this.container;
			};
		}
		made.push(this);
	}

	get firstChild() {
		return this.children[0] || null;
	}

	setAttribute(k, v) {
		this.attrs[k] = String(v);
	}

	getAttribute(k) {
		return k in this.attrs ? this.attrs[k] : null;
	}

	removeAttribute(k) {
		delete this.attrs[k];
	}

	appendChild(c) {
		if (c.parent) c.remove();
		c.parent = this;
		this.children.push(c);
		return c;
	}

	remove() {
		if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
		this.parent = null;
		this.removed = true;
	}

	replaceChildren(...kids) {
		for (const c of [...this.children]) c.remove();
		for (const c of kids) this.appendChild(c);
	}

	get tagName() {
		return this.localName;
	}

	/** Enough of a selector engine for the two shapes asked of it: [value="..."],
	 *  which is how addDialog.js finds the collection the menu ticked, and a
	 *  bare .class, which is how graphTab.load() asks whether a container it is
	 *  about to mount into already holds a graph. */
	querySelector(sel) {
		let match;
		const attr = /^\[value="(.*)"\]$/.exec(sel);
		const cls = /^\.([\w-]+)$/.exec(sel);
		if (attr) match = c => c.getAttribute('value') === attr[1];
		else if (cls) match = c => String(c.className).split(/\s+/).includes(cls[1]);
		else throw new Error('unsupported selector: ' + sel);
		const walk = (el) => {
			for (const c of el.children) {
				if (match(c)) return c;
				const found = walk(c);
				if (found) return found;
			}
			return null;
		};
		return walk(this);
	}

	focus() {}

	select() {}

	// A XUL popup announces both edges of its life, and addDialog.js hangs the
	// focus on one and the answer on the other.
	openPopup() {
		this.fire('popupshown', { target: this });
	}

	hidePopup() {
		this.fire('popuphidden', { target: this });
	}

	addEventListener(type, fn) {
		(this.listeners[type] = this.listeners[type] || []).push(fn);
	}

	/** Press the chevron, or whatever else the panel wired up. */
	fire(type, event) {
		for (const fn of this.listeners[type] || []) fn(event);
	}

	getBoundingClientRect() {
		// Zero once collapsed, the way a width:0 box measures -- which is what
		// stops a collapse from being remembered as a width.
		return { width: this.getAttribute('data-zg-collapsed') ? 0 : 400 };
	}
}

function fakeWindow(onRender = async () => {}) {
	const made = [];
	const element = localName => new FakeElement(localName, made, onRender);
	const win = {
		document: {
			createElement: element,
			createXULElement: element,
			// A dialog is appended to the window itself and looked up by id,
			// which is how a second one displaces the first.
			documentElement: element('window'),
			getElementById: id => made.find(el => el.id === id && !el.removed) || null,
		},
		// splitPane mirrors the splitter's width attribute through one of these.
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		addEventListener() {},
		removeEventListener() {},
	};
	return { made, win, element };
}

/** A graph tab with nothing in its side panel yet. */
function fakeEntry(win, element, tabID) {
	return { win, split: element('hbox'), tabID, pane: null, reader: null, itemPane: null };
}

check('the side panel holds one thing at a time', async () => {
	const splitPane = require_('./lib/splitPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-9');
	Zotero.Prefs = { get: () => 420, set: () => {} };

	let dropped = 0;
	let first = splitPane.claim(entry, 'reader', () => dropped++);
	first.appendChild(element('browser'));
	if (!splitPane.has(entry, 'reader')) throw new Error('the reader did not get the panel');

	// The chevron is a child of the panel, and it belongs to the panel rather
	// than to whoever is in it -- so it is not part of any of these counts.
	const toggle = made.find(el => el.className === 'zg-pane-toggle');
	const occupants = box => box.children.filter(c => c !== toggle);

	// The same occupant asking again keeps what it built.
	if (splitPane.claim(entry, 'reader', () => dropped++) !== first) throw new Error('the panel was rebuilt');
	if (dropped) throw new Error('a re-claim tore the occupant down');
	if (occupants(first).length !== 1) throw new Error('a re-claim emptied the panel');

	// Someone else asking takes it, and the reader is told before its elements go.
	let second = splitPane.claim(entry, 'item', () => dropped++);
	if (second !== first) throw new Error('the two occupants got different panels');
	if (dropped !== 1) throw new Error('the displaced occupant was not told');
	if (occupants(second).length) throw new Error('the panel was handed over still full');
	if (toggle.parent !== second) throw new Error('the handover took the chevron with it');
	if (splitPane.has(entry, 'reader')) throw new Error('the reader still claims the panel');

	splitPane.close(entry);
	if (dropped !== 2) throw new Error('close() did not tell the occupant');
	if (entry.pane) throw new Error('close() left the panel on the tab');
	if (!second.removed) throw new Error('close() left the panel in the DOM');
});

check('the chevron hangs off the panel and is never positioned by arithmetic', () => {
	const splitPane = require_('./lib/splitPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-11');
	Zotero.Prefs = { get: () => 400, set: () => {} };

	const box = splitPane.claim(entry, 'item', () => {});
	const toggle = made.find(el => el.className === 'zg-pane-toggle');
	const splitter = made.find(el => el.className === 'zg-pane-splitter');
	// A XUL <splitter> is a leaf frame in current Gecko -- it lays out no
	// children, so a button inside one is invisible. That is not a thing a
	// stylesheet can rescue, hence the check.
	if (splitter.children.length) throw new Error('the divider has children, and they never paint');
	// Inside the panel, so that every way the panel's edge can move -- a drag, a
	// narrower window, min-width biting -- moves the button with it. An offset
	// computed once and stored goes stale on all three, and a stale offset puts
	// the button off the side of the tab, which is how it kept vanishing.
	if (toggle.parent !== box) throw new Error('the chevron must be a child of the panel');
	if (Object.keys(entry.split.style.props).length) {
		throw new Error('the chevron is being placed by measurement again: '
			+ JSON.stringify(entry.split.style.props));
	}

	// Collapsing is width, not display: a panel that is display:none takes the
	// button down with it, and then there is no way back.
	toggle.fire('click');
	if (box.getAttribute('data-zg-collapsed') !== 'true') throw new Error('the panel did not collapse');
	if (box.getAttribute('hidden')) throw new Error('display:none would hide the chevron too');
	// Neither an inline width nor a XUL width attribute may be left behind to
	// argue with `width: 0`.
	if (box.style.width) throw new Error('an inline width outranks the collapsed rule: ' + box.style.width);
	if (box.getAttribute('width')) throw new Error('a width attribute survived the collapse');
	if (toggle.parent !== box) throw new Error('collapsing detached the chevron');
	// The attribute is what the panel comes back at, so it survives the collapse.
	toggle.fire('click');
	if (box.style.width !== '400px') throw new Error('came back at ' + box.style.width);
});

check('hiding the panel keeps what is in it, and asking again brings it back', () => {
	const splitPane = require_('./lib/splitPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-10');
	Zotero.Prefs = { get: () => 480, set: () => {} };

	let dropped = 0;
	let box = splitPane.claim(entry, 'reader', () => dropped++);
	box.appendChild(element('browser'));
	const toggle = made.find(el => el.className === 'zg-pane-toggle');
	if (!toggle) throw new Error('the panel has no chevron');
	const occupants = () => box.children.filter(c => c !== toggle);

	toggle.fire('click');
	if (box.getAttribute('data-zg-collapsed') !== 'true') throw new Error('the chevron did not hide the panel');
	// Hidden, not emptied: a reader keeps its page and an item pane its scroll
	// position, so the way back is instant and lands where you left.
	if (dropped) throw new Error('hiding tore the occupant down');
	if (occupants().length !== 1) throw new Error('hiding emptied the panel');
	if (toggle.textContent !== '«') throw new Error('the chevron points the wrong way: ' + toggle.textContent);

	// A claim that is not a request to SEE something leaves the chevron's
	// decision alone -- that is what stops a node click reopening the panel.
	splitPane.claim(entry, 'reader', () => dropped++, { show: false });
	if (box.getAttribute('data-zg-collapsed') !== 'true') throw new Error('a quiet claim reopened the panel');

	// "Open PDF beside the graph" is one, so it shows it again.
	if (splitPane.claim(entry, 'reader', () => dropped++) !== box) throw new Error('the panel was rebuilt');
	if (box.getAttribute('data-zg-collapsed')) throw new Error('claiming left the panel hidden');
	if (toggle.textContent !== '»') throw new Error('the chevron did not flip back');
	if (dropped) throw new Error('showing it again tore the occupant down');
});

check('the item pane is handed what <item-details> needs, and nothing more', async () => {
	const itemPane = require_('./lib/itemPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-7');
	// Set immediately before the call: show() reads Zotero.Items synchronously,
	// and the checks in this file share one Zotero stub.
	Zotero.Items = { getAsync: async id => ({ id, libraryID: 1, parentItem: false, deleted: false }) };
	Zotero.Libraries = { get: () => ({ editable: true }) };
	Zotero.Prefs = { get: () => 400, set: () => {} };
	await itemPane.show(entry, 11);

	const details = made.find(el => el.localName === 'item-details');
	const sidenav = made.find(el => el.localName === 'item-pane-sidenav');
	if (!details || !sidenav) throw new Error('no item pane was built');
	// The three properties contextPane.js sets on its own item-details. Without
	// tabID the pane renders in a tab nobody is looking at; without a sidenav
	// ItemDetails throws the first time it updates one; and tabType decides
	// which of core's library-only branches are taken.
	if (details.tabID !== 'tab-7') throw new Error('tabID: ' + details.tabID);
	if (details.tabType !== 'graph') throw new Error('tabType: ' + details.tabType);
	if (details.sidenav !== sidenav) throw new Error('the sidenav was not attached');
	// A sidenav starts with every button disabled -- 60% opacity and no pointer
	// events -- until something says an item is being viewed. Nothing says it
	// for a graph tab, so this has to.
	if (sidenav.defaultStatus !== false) throw new Error('the sidenav was left greyed out');
	// And said before the container was attached, which is the order
	// contextPane.js uses: render() no-ops until there is a container, so the
	// strip is drawn once and drawn already enabled.
	if (sidenav.toldWhileContainerWas !== undefined) {
		throw new Error('the sidenav was enabled after its container was set');
	}
	if (details.item.id !== 11) throw new Error('the item never arrived');
	if (details.editable !== true) throw new Error('an editable library came out read-only');

	// Hidden from the divider, then clicked again. The click must NOT put the
	// panel back -- hiding it was a decision -- but the pane behind the chevron
	// stays current, so bringing it back lands on the paper last chosen.
	const toggle = made.find(el => el.className === 'zg-pane-toggle');
	toggle.fire('click');
	Zotero.Items = { getAsync: async id => ({ id, libraryID: 1, parentItem: false, deleted: false }) };
	await itemPane.show(entry, 12);
	if (!entry.pane.box.getAttribute('data-zg-collapsed')) throw new Error('a click reopened a hidden panel');
	if (details.item.id !== 12) throw new Error('the hidden pane did not follow the click');
	toggle.fire('click');
	if (entry.pane.box.getAttribute('data-zg-collapsed')) throw new Error('the chevron did not bring it back');

	require_('./lib/splitPane.js').close(entry);
	if (entry.itemPane) throw new Error('close() left the pane on the tab');
	if (entry.pane) throw new Error('close() left the panel on the tab');
	// The row is what the panel holds, and taking it out is what disconnects
	// <item-details> -- which is the whole of the item pane's cleanup, since
	// ItemDetails unregisters its observers from disconnectedCallback.
	if (details.parent !== made.find(el => el.className === 'zg-item-row')) {
		throw new Error('the pane was not left inside the row it was built in');
	}
	if (!details.parent.removed) throw new Error('close() left the pane in the DOM');
});

check('a pointer crossing three nodes draws the last, not all three', async () => {
	const itemPane = require_('./lib/itemPane.js');
	const drawn = [];
	let release;
	// The first render is held open, which is the whole scenario: a render walks
	// every section of the pane, and the pointer moves on while it does.
	const held = new Promise((r) => {
		release = r;
	});
	const { win, element } = fakeWindow(async (el) => {
		drawn.push(el.item.id);
		await held;
	});
	const entry = fakeEntry(win, element, 'tab-8');
	const items = { getAsync: async id => ({ id, libraryID: 1, parentItem: false, deleted: false }) };
	Zotero.Libraries = { get: () => ({ editable: true }) };
	Zotero.Prefs = { get: () => 400, set: () => {} };

	Zotero.Items = items;
	const first = itemPane.show(entry, 1);
	Zotero.Items = items;
	const second = itemPane.show(entry, 2);
	Zotero.Items = items;
	const third = itemPane.show(entry, 3);
	// Let all three past their item lookups before the held render lets go.
	await new Promise(r => setTimeout(r, 0));
	release();
	await Promise.all([first, second, third]);

	// 2 was passed over while 1 was still drawing, and drawing it would have
	// cost a full render of a pane nobody was going to look at.
	if (drawn.join(',') !== '1,3') throw new Error('drew ' + drawn.join(','));
});

/**
 * Core's collection menu, as far as this side of it goes: a flat list of
 * entries, each carrying the treeViewID addDialog.js ticks against and calling
 * back with the library or collection it stands for.
 */
function collectionMenuStub(element, rows) {
	return (libraryOrCollection, elem, currentTarget, clickAction) => {
		let first = null;
		for (const row of rows) {
			const item = element('menuitem');
			item.setAttribute('value', row.target.treeViewID);
			item.setAttribute('label', row.target.name);
			item.setAttribute('image', '');
			if (row.target.treeViewID === currentTarget) item.setAttribute('checked', 'true');
			item.addEventListener('command', () => clickAction({ target: item }, row.target));
			elem.appendChild(item);
			first = first || item;
		}
		return first;
	};
}

const MY_LIBRARY = {
	libraryID: 1, objectType: 'library', name: 'My Library', treeViewID: 'L1', treeViewImage: '',
};
const READING_LIST = {
	libraryID: 1, objectType: 'collection', id: 7, name: 'Reading list',
	treeViewID: 'C7', treeViewImage: '',
};

/** A dialog on screen, with core's two collaborators stubbed. Everything the
 *  dialog asks of them it asks synchronously, inside open(). */
function openAddDialog(opts = {}) {
	const addDialog = require_('./lib/addDialog.js');
	const { win, made, element } = fakeWindow();
	Zotero.Libraries = { get: () => MY_LIBRARY };
	Zotero.Utilities = {
		Internal: {
			createMenuForTarget: collectionMenuStub(element, [
				{ target: MY_LIBRARY }, { target: READING_LIST },
			]),
		},
	};
	const asked = addDialog.open(win, {
		doi: '10.5555/outside',
		title: 'A paper the collection cites',
		libraryID: 1,
		collectionID: 7,
		tag: 'added by citation graph',
		...opts,
	});
	const find = (localName, pred = () => true) =>
		made.find(el => el.localName === localName && !el.removed && pred(el));
	const press = label => find('button', el => el.textContent === label).fire('click');
	return { asked, made, find, press, panel: made.find(el => el.id === addDialog.PANEL_ID) };
}

check('the add dialog opens on the collection the graph is of', async () => {
	await l10nReady;
	const { asked, find, press } = openAddDialog();
	// Not "selected" in the menulist's own sense -- a native menulist filled by
	// core's menu builder wears the label of whichever entry is ticked.
	if (find('menulist').getAttribute('label') !== 'Reading list') {
		throw new Error('opened on ' + find('menulist').getAttribute('label'));
	}
	press('Add');
	const out = await asked;
	if (out.libraryID !== 1 || out.collectionID !== 7) {
		throw new Error('target: ' + JSON.stringify(out));
	}
	if (out.tag !== 'added by citation graph' || out.tagOn !== true) {
		throw new Error('tag: ' + JSON.stringify(out));
	}
});

check('picking the library itself out of the menu means the library root', async () => {
	await l10nReady;
	const { asked, find, press } = openAddDialog();
	find('menuitem', el => el.getAttribute('value') === 'L1').fire('command');
	if (find('menulist').getAttribute('label') !== 'My Library') {
		throw new Error('the menu did not follow the pick');
	}
	press('Add');
	const out = await asked;
	// No collection is an answer, not a missing one: it is what the translator
	// is handed as an empty collections list.
	if (out.collectionID !== null) throw new Error('collectionID: ' + out.collectionID);
});

check('unticking the tag greys the field without forgetting what is in it', async () => {
	await l10nReady;
	const { asked, find, press } = openAddDialog();
	const box = find('input', el => el.type === 'checkbox');
	box.checked = false;
	box.fire('change');
	if (!find('input', el => el.type === 'text').disabled) {
		throw new Error('the field stayed live with the box unticked');
	}
	press('Add');
	const out = await asked;
	// The two come back separately so that a box unticked this once is not what
	// forgets the tag someone typed -- chrome writes both back to the prefs.
	if (out.tagOn !== false) throw new Error('tagOn: ' + out.tagOn);
	if (out.tag !== 'added by citation graph') throw new Error('tag: ' + out.tag);
});

check('the collection menu opening and closing is not the dialog closing', async () => {
	await l10nReady;
	const { asked, find, press, panel } = openAddDialog();
	let answered = false;
	asked.then(() => {
		answered = true;
	});
	// Exactly what a pick out of the collection menu does. Popup events bubble,
	// and this one is a popup inside the dialog's own -- which is what used to
	// tear the dialog down and abort the add on every click in the menu.
	const menupopup = find('menupopup');
	panel.fire('popupshown', { target: menupopup });
	panel.fire('popuphidden', { target: menupopup });
	await Promise.resolve();
	await Promise.resolve();
	if (answered) throw new Error('the dialog took its own menu closing for a cancel');
	if (panel.removed) throw new Error('the dialog was torn down by its own menu');
	press('Add');
	if (!await asked) throw new Error('the dialog stopped answering');
});

check('a cancelled dialog answers null once and leaves nothing behind', async () => {
	await l10nReady;
	const { asked, press, panel } = openAddDialog();
	press('Cancel');
	// Cancelling hides the popup, which fires popuphidden, which answers again.
	// One question, one answer, whichever of the two paths gets there first.
	if (await asked !== null) throw new Error('cancel must answer null');
	if (!panel.removed) throw new Error('the panel outlived the question');
});

/** A Zotero item with just the surface itemRecord() reads. */
function fakeZoteroItem(over = {}) {
	const fields = { title: 'The work they all cite', DOI: '10.5555/outside', date: '2019' };
	return {
		key: 'BBBBBBBB',
		id: 42,
		itemTypeID: 1,
		isRegularItem: () => true,
		getField: name => fields[name] || '',
		getCreators: () => [{ lastName: 'Ada' }],
		getTags: () => [{ tag: 'added by citation graph' }],
		// The collection the graph is of, so the graph can take it in.
		getCollections: () => [11],
		...over,
	};
}

/** One held paper citing one work the collection does not hold. */
function fakeAddedTab() {
	const sent = [];
	const state = {
		items: [{ key: 'AAAAAAAA', itemType: 'journalArticle', title: 'Citing paper', doi: null }],
		inCollection: new Set(['AAAAAAAA']),
		edges: [{
			from: 'AAAAAAAA', to: 'doi:10.5555/outside',
			confidence: 0.95, via: ['pdf-links'], evidence: [],
		}],
		metadata: { 'doi:10.5555/outside': { title: 'The work they all cite', citedByGlobal: 90 } },
		heldCounts: Object.create(null),
	};
	const entry = {
		browser: { contentWindow: { wrappedJSObject: { zgSetData: j => sent.push(JSON.parse(j)) } } },
		collection: { id: 11, key: 'C1', name: 'Reading list' },
		options: { recursive: false, includeExternal: true, enrich: true },
		built: {
			state,
			baseMeta: { items: 1, perProvider: {}, errors: [] },
			ghostKeys: ['doi:10.5555/outside'],
			heldByDoiKey: new Map(),
		},
	};
	return { entry, state, sent };
}

check('an added paper is folded into the graph, not re-derived from it', async () => {
	const { adoptAdded } = require_('./lib/graphTab.js');
	const { entry, state, sent } = fakeAddedTab();
	Zotero.Items = { loadDataTypes: async () => {} };
	Zotero.ItemTypes = { getName: () => 'journalArticle' };

	const took = await adoptAdded(entry, 'doi:10.5555/outside', fakeZoteroItem(), ['Reading list']);
	if (!took) throw new Error('the graph refused a paper filed into its own collection');
	// One payload, and no phase-1 empty edge list before it -- that push is the
	// whole reason a rebuild re-anneals the layout.
	if (sent.length !== 1) throw new Error('pushes: ' + sent.length);
	const out = sent[0];
	if (out.edges.length !== 1 || out.edges[0].to !== 'BBBBBBBB') {
		throw new Error('the edge still points at the ghost: ' + JSON.stringify(out.edges));
	}
	if (out.external.length) throw new Error('the ghost outlived its promotion');
	const added = out.items.find(i => i.key === 'BBBBBBBB');
	if (!added) throw new Error('the paper is not in the collection it was filed into');
	if (added.collections.join() !== 'Reading list') throw new Error('collections: ' + added.collections);
	// The count it was looked up with, kept across the promotion: it is the same
	// work, and losing it would flatten the node under 'size by global citations'.
	if (added.citedByGlobal !== 90) throw new Error('citedByGlobal: ' + added.citedByGlobal);
	// What lets the page put the new node exactly where the ghost stood.
	if (!out.meta.adopted || out.meta.adopted.was !== 'doi:10.5555/outside'
		|| out.meta.adopted.now !== 'BBBBBBBB') {
		throw new Error('meta.adopted: ' + JSON.stringify(out.meta.adopted));
	}
	// A later lookup asks about it as a held item rather than as a ghost.
	if (entry.built.ghostKeys.length) throw new Error('still a ghost to the lookup');
	if (entry.built.heldByDoiKey.get('doi:10.5555/outside') !== 'BBBBBBBB') {
		throw new Error('the lookup cannot address it by DOI any more');
	}
	if (!state.inCollection.has('BBBBBBBB')) throw new Error('not in the collection set');
});

check('a paper filed somewhere else is not folded into this graph', async () => {
	const { adoptAdded } = require_('./lib/graphTab.js');
	const { entry, sent } = fakeAddedTab();
	Zotero.Items = { loadDataTypes: async () => {} };
	Zotero.ItemTypes = { getName: () => 'journalArticle' };
	// scopeNames() found nothing, which is what a collection outside this graph
	// comes to. The ghost is still a ghost, and nothing on screen may move.
	const took = await adoptAdded(entry, 'doi:10.5555/outside', fakeZoteroItem(), null);
	if (took) throw new Error('the graph took in a paper it does not hold');
	if (sent.length) throw new Error('it pushed anyway');
});

check('naming a graph changes no node and no edge', () => {
	const { pushData } = require_('./lib/graphTab.js');
	const sent = [];
	const entry = {
		browser: { contentWindow: { wrappedJSObject: { zgSetData: j => sent.push(JSON.parse(j)) } } },
		collection: { key: 'C1', name: 'Reading list' },
		options: { recursive: false, includeExternal: true, enrich: true },
	};
	// One held item citing one work the collection does not hold.
	const state = {
		items: [{ key: 'AAAAAAAA', itemType: 'journalArticle', title: 'Citing paper', doi: '10.1000/citing' }],
		inCollection: new Set(['AAAAAAAA']),
		edges: [{ from: 'AAAAAAAA', to: 'doi:10.5555/outside', confidence: 0.95, via: ['pdf-links'], evidence: [] }],
		metadata: Object.create(null),
		heldCounts: Object.create(null),
	};

	pushData(entry, state, { phase: 'edges' });
	// Exactly what the lookup phase writes, and nothing else.
	state.metadata['doi:10.5555/outside'] = { title: 'An outside work', creators: ['Kucsko'], year: 2013, citedByGlobal: 900 };
	state.heldCounts.AAAAAAAA = 7;
	pushData(entry, state, { phase: 'done' });

	const [before, after] = sent;
	// The renderer holds its layout only as long as the node set and the edges
	// come back unchanged; a lookup that altered either would re-anneal it.
	if (JSON.stringify(before.edges) !== JSON.stringify(after.edges)) {
		throw new Error('the lookup changed an edge');
	}
	const nodeKeys = p => p.items.map(i => i.key).concat(p.external.map(x => x.key)).join(',');
	if (nodeKeys(before) !== nodeKeys(after)) throw new Error('the lookup changed the node set');
	// And it does have to deliver what it went to the network for.
	if (before.external[0].title) throw new Error('a ghost was named before the lookup ran');
	if (after.external[0].title !== 'An outside work') throw new Error('the ghost was not named');
	if (after.external[0].citedBy !== 1) throw new Error('the local count was lost');
	if (after.items[0].citedByGlobal !== 7) throw new Error('the held count did not arrive');
});

/* --- what survives a restart ---------------------------------------------
 *
 * A graph tab comes back from session.json and nothing else, so what tabData()
 * puts there is the whole of what a restored tab can know about itself. These
 * check the round trip rather than the tab machinery: Zotero_Tabs.getState()
 * JSON-serialises tab.data, and restoreOptions() is what reads it back.
 */

check('a graph tab reduces to what session.json can hold, and reads back', () => {
	const { tabData, restoreOptions } = require_('./lib/graphTab.js');
	const collection = { key: 'ABCD1234', libraryID: 1, name: 'Reading list' };
	const options = { recursive: true, includeExternal: true, enrich: false };

	const data = JSON.parse(JSON.stringify(tabData(collection, options)));
	if (data.collectionKey !== 'ABCD1234') throw new Error('key: ' + data.collectionKey);
	if (data.libraryID !== 1) throw new Error('libraryID: ' + data.libraryID);
	// tabs.js _update() goes looking for an item to take a type icon from when
	// this is missing, and a graph tab has no item to find.
	if (data.icon !== 'zotero-graph') throw new Error('icon: ' + data.icon);
	// Nothing derived: an edge list or a layout stored here would be reread
	// stale, and is re-derived off the two caches far more cheaply than it
	// could be invalidated honestly.
	if (Object.keys(data).sort().join(',') !== 'collectionKey,icon,libraryID,options') {
		throw new Error('carries more than it should: ' + Object.keys(data).join(','));
	}
	if (JSON.stringify(restoreOptions(data)) !== JSON.stringify(options)) {
		throw new Error('scope did not survive: ' + JSON.stringify(restoreOptions(data)));
	}
	// The stored copy must not alias the live options, or a later rebuild would
	// silently rewrite what the last save recorded.
	options.recursive = false;
	if (!restoreOptions(data).recursive) throw new Error('the stored scope aliases the live one');
});

check('a scope written by an older version fills in from the defaults', () => {
	const { restoreOptions } = require_('./lib/graphTab.js');
	for (const data of [undefined, {}, { options: null }, { options: { recursive: true } }]) {
		const o = restoreOptions(data);
		for (const k of ['recursive', 'includeExternal', 'enrich']) {
			if (typeof o[k] !== 'boolean') {
				throw new Error(`${k} is ${o[k]} for ${JSON.stringify(data)}`);
			}
		}
	}
	// What it did know is still honoured; what it did not defaults off.
	const o = restoreOptions({ options: { recursive: true } });
	if (!o.recursive || o.includeExternal || o.enrich) throw new Error(JSON.stringify(o));
	// The network option is never entered by a default.
	if (restoreOptions({}).enrich) throw new Error('a restored tab defaulted into the lookup');
});

check('an empty collection reports why, and offers the switch only when it helps', () => {
	const { emptyReason } = require_('./lib/graphTab.js');
	const withKids = n => ({ getChildCollections: asIDs => Array(n).fill(asIDs ? 1 : {}) });

	// Something down there to include, and it is not included: worth offering.
	const offer = emptyReason(withKids(3), { recursive: false });
	if (offer.subcollections !== 3 || offer.recursive) throw new Error(JSON.stringify(offer));
	// Already recursive, or nothing below -- the page has nothing to offer, and
	// a button that would change nothing is worse than none.
	if (!emptyReason(withKids(3), { recursive: true }).recursive) throw new Error('lost recursive');
	if (emptyReason(withKids(0), { recursive: false }).subcollections !== 0) {
		throw new Error('counted a subcollection that is not there');
	}
	// A count that cannot be taken is a hint that cannot be offered, not a
	// build that fails.
	const throws = { getChildCollections: () => { throw new Error('not loaded'); } };
	if (emptyReason(throws, { recursive: false }).subcollections !== 0) {
		throw new Error('a throwing collection did not fall back to zero');
	}
});

/* --- the quit/restore round trip -----------------------------------------
 *
 * The whole of tab persistence is a handshake with core: a tab has to still be
 * in the strip when Zotero.Session reads it, getState() has to carry enough to
 * rebuild it, and restoreState has to put it back. These drive that handshake
 * against a Zotero_Tabs faithful to the parts of tabs.js it touches.
 */

/** Enough of Zotero_Tabs for open/restore/load: the tab list, the hooks table,
 *  getState()'s serialisation, and add()'s inline select. */
function fakeTabs(element) {
	let self = {
		_tabs: [{ id: 'zotero-pane', type: 'library', title: 'My Library', data: { icon: 'collection' } }],
		_selectedID: 'zotero-pane',
		_ids: 1,
		// tabs.js ships hooks for its own types; the library one is what keeps
		// the destructure below from throwing on the first tab of every session.
		tabHooks: { restoreState: { library: async () => ({ itemID: null }) } },
		containers: new Map(),
		closed: [],

		add({ id, type, data, title, index, select, onClose }) {
			// tabs.js throws on an index below 1; the library tab owns index 0.
			if (index !== undefined && (!Number.isInteger(index) || index < 1)) {
				throw new Error('bad index ' + index);
			}
			id = id || 'tab-' + (++self._ids);
			let container = element('tab-content');
			container.id = id;
			self.containers.set(id, container);
			self._tabs.splice(index === undefined ? self._tabs.length : index, 0,
				{ id, type, title, data, onClose });
			// add() runs select() inline, which for an unloaded tab calls the
			// load hook before add() has returned.
			if (select) self.select(id);
			return { id, container };
		},

		select(id) {
			let tab = self._tabs.find(t => t.id === id);
			self._selectedID = id;
			let [contentType, state] = tab.type.split('-');
			if (state === 'unloaded') {
				tab.type = contentType + '-loading';
				let hook = self.tabHooks.load && self.tabHooks.load[contentType];
				if (hook) {
					self.loading = Promise.resolve(hook(tab, self._tabs.indexOf(tab), {}))
						.then(() => { tab.type = contentType; });
				}
			}
		},

		close(id) {
			let tab = self._tabs.find(t => t.id === id);
			if (!tab) return;
			self.closed.push(id);
			self._tabs = self._tabs.filter(t => t !== tab);
			// The container is destroyed with the tab; a re-add builds a new one.
			self.containers.delete(id);
			if (tab.onClose) tab.onClose();
		},

		// Private in tabs.js, and what unload() reads to re-add a tab where it
		// was. Modelled because the plugin transcribes that method.
		_getTab(id) {
			let tabIndex = self._tabs.findIndex(t => t.id === id);
			return { tab: self._tabs[tabIndex] || null, tabIndex };
		},

		getTabContent: id => self.containers.get(id) || null,

		setTabData(id, data) {
			let tab = self._tabs.find(t => t.id === id);
			Object.assign(tab.data, data);
		},

		// tabs.js getState(): what actually reaches session.json.
		getState() {
			return self._tabs.map((tab) => {
				let type = tab.type.replace(/-unloaded$/, '');
				let o = { type, title: tab.title, timeUnselected: tab.timeUnselected };
				if (tab.data) o.data = tab.data;
				if (tab.id === self._selectedID) o.selected = true;
				return o;
			});
		},

		// tabs.js restoreState(): a plain loop, and the destructure that makes a
		// throwing hook cost every LATER tab rather than its own.
		async restoreState(tabs) {
			for (let i = 0; i < tabs.length; i++) {
				let contentType = tabs[i].type === 'zotero-pane'
					? 'library' : tabs[i].type.split('-')[0];
				let hook = (self.tabHooks.restoreState && self.tabHooks.restoreState[contentType])
					|| (async () => {});
				let { itemID } = await hook(tabs[i], i);
				void itemID;
			}
		},
	};
	return self;
}

/** A main window with a tab strip, and the collection the graph is of. */
function fakeMainWindow() {
	const { made, win, element } = fakeWindow();
	win.Zotero_Tabs = fakeTabs(element);
	win.MozXULElement = { insertFTLIfNeeded() {} };
	return { made, win, element };
}

const CFG = { resRoot: 'zotero-graph', pluginID: 'zotero-graph@jajaho.dev', rootURI };
const COLLECTION = { key: 'ABCD1234', libraryID: 1, id: 7, name: 'Reading list' };

/** Zotero.Collections as restore() asks about it. */
function stubCollections(found = COLLECTION) {
	Zotero.Collections = {
		getByLibraryAndKeyAsync: async (libraryID, key) => {
			if (!libraryID) throw new Error('Library ID not provided');
			return (found && found.libraryID === libraryID && found.key === key) ? found : false;
		},
	};
}

/**
 * These four share one module-level tab registry (graphTab's open_/pending_)
 * and one Zotero stub, so they are chained rather than left to interleave at
 * their awaits: check() returns its run for exactly this.
 */
const restoreReady = (async () => {
	await l10nReady;
	Zotero.MenuManager = { registerMenu() {}, unregisterMenu() {} };
	Zotero.getMainWindows = () => [];
	await require_('./lib/main.js').startup(CFG);
})();

const t1 = check('a graph tab is still in the strip when Zotero.Session reads it', async () => {
	await restoreReady;
	const graphTab = require_('./lib/graphTab.js');
	const main = require_('./lib/main.js');
	const { win } = fakeMainWindow();
	stubCollections();
	Zotero.Prefs = { get: () => null, set: () => {} };

	await graphTab.open(win, COLLECTION, CFG);
	if (!win.Zotero_Tabs._tabs.some(t => t.type === 'graph')) throw new Error('no graph tab was added');

	// Quitting Zotero. Session.save() reads the strip synchronously from the
	// quit-application-granted observer; the window unload runs around the same
	// point and used to close the tabs, so they could never be serialised.
	main.onMainWindowUnload(win);
	await main.shutdown(2);

	const saved = win.Zotero_Tabs.getState().find(t => t.type === 'graph');
	if (!saved) throw new Error('the graph tab never reached session.json');
	if (saved.data.collectionKey !== 'ABCD1234') throw new Error('no collection to restore from');
	if (win.Zotero_Tabs.closed.length) throw new Error('shutdown closed the tab: ' + win.Zotero_Tabs.closed);
});

const t2 = check('the plugin going away takes its tabs out of the session with it', async () => {
	await t1;
	const graphTab = require_('./lib/graphTab.js');
	const main = require_('./lib/main.js');
	const { win } = fakeMainWindow();
	stubCollections();
	Zotero.Prefs = { get: () => null, set: () => {} };
	Zotero.getMainWindows = () => [win];

	await graphTab.open(win, COLLECTION, CFG);
	// Anything but APP_SHUTDOWN: resource://zotero-graph/ stops resolving under
	// a live page, and a 'graph' entry left in session.json meets a Zotero with
	// no restoreState.graph hook -- the tabs.js:611 destructure that aborts
	// restore for every tab after it.
	await main.shutdown(7);
	if (win.Zotero_Tabs.getState().some(t => /^graph/.test(t.type))) {
		throw new Error('a graph tab survived the plugin being removed');
	}
});

const t3 = check('a restored graph tab comes back unloaded, in place, and builds on select', async () => {
	await t2;
	const main = require_('./lib/main.js');
	const { win } = fakeMainWindow();
	stubCollections();
	Zotero.Prefs = { get: () => null, set: () => {} };

	// Exactly what session.json holds, in the order tabs.js hands it over.
	const session = [
		{ type: 'library', title: 'My Library', data: { icon: 'collection' } },
		{ type: 'graph', title: 'Reading list — Citation Graph', selected: true,
			data: { collectionKey: 'ABCD1234', libraryID: 1, icon: 'zotero-graph',
				options: { recursive: true, includeExternal: true, enrich: false } } },
	];

	main.onMainWindowLoad(win);
	const hooks = win.Zotero_Tabs.tabHooks;
	if (!hooks.restoreState || !hooks.restoreState.graph) throw new Error('no restoreState hook');
	if (!hooks.load || !hooks.load.graph) throw new Error('no load hook');

	await win.Zotero_Tabs.restoreState(session);

	const back = win.Zotero_Tabs._tabs.filter(t => /^graph/.test(t.type));
	if (back.length !== 1) throw new Error('restored ' + back.length + ' graph tabs');
	if (win.Zotero_Tabs._tabs.indexOf(back[0]) !== 1) throw new Error('restored out of place');
	// Selected in the session, so add() ran select() inline and the load hook
	// promoted it off 'unloaded'.
	await win.Zotero_Tabs.loading;
	if (back[0].type !== 'graph') throw new Error('a selected tab was left at ' + back[0].type);
	// Named from the live collection, not from the saved title.
	if (back[0].title !== 'Reading list — Citation Graph') throw new Error('title: ' + back[0].title);
	// And it is a real tab, with the page mounted into its container.
	const container = win.Zotero_Tabs.getTabContent(back[0].id);
	if (!container.children.some(c => c.className === 'zg-split')) {
		throw new Error('the load hook did not mount the graph');
	}
});

check('a tab whose collection is gone drops without costing the tabs after it', async () => {
	await t3;
	const main = require_('./lib/main.js');
	const { win } = fakeMainWindow();
	// No collection answers to that key any more.
	stubCollections(null);
	Zotero.Prefs = { get: () => null, set: () => {} };

	main.onMainWindowLoad(win);
	let after = 0;
	win.Zotero_Tabs.tabHooks.restoreState.reader = async () => { after++; return { itemID: null }; };

	await win.Zotero_Tabs.restoreState([
		{ type: 'library', title: 'My Library', data: {} },
		{ type: 'graph', title: 'Graph: Gone', data: { collectionKey: 'DEAD0000', libraryID: 1 } },
		// A libraryID of 0 makes getIDFromLibraryAndKey throw rather than miss.
		{ type: 'graph', title: 'Graph: Broken', data: { collectionKey: 'ABCD1234', libraryID: 0 } },
		{ type: 'reader', title: 'A paper', data: { itemID: 5 } },
	]);

	if (win.Zotero_Tabs._tabs.some(t => /^graph/.test(t.type))) {
		throw new Error('a tab was restored for a collection that is gone');
	}
	// The whole point of not throwing: restoreState has no per-tab catch.
	if (after !== 1) throw new Error('the tab after the dropped ones never restored');
});

/**
 * A Zotero item just real enough for readerPane.readable(): the four things it
 * asks about a candidate attachment.
 */
function fakeItem({ title = 'A paper', att = undefined, readerType = 'pdf', file = '/tmp/a.pdf' } = {}) {
	const attachment = att === null ? null : {
		id: 42,
		attachmentReaderType: readerType,
		getFilePathAsync: async () => file,
		getDisplayTitle: () => title,
		isAttachment: () => true,
	};
	return {
		id: 7,
		isAttachment: () => false,
		getDisplayTitle: () => title,
		getBestAttachment: async () => attachment,
	};
}

check('readable() gates both PDF entries on the same three questions', async () => {
	// Its three refusals are strings now, so the bundle has to be in.
	await l10nReady;
	const { readable } = require_('./lib/readerPane.js');
	const said = [];
	const status = t => said.push(t);
	// The graph page cannot see attachments, so this gate is the only thing
	// standing between "Open PDF..." and a reader that throws on construction.
	const run = async (item) => {
		Zotero.Items = { getAsync: async () => item };
		said.length = 0;
		return readable(7, status);
	};

	if (await run(fakeItem({ att: null })) !== null) throw new Error('opened an item with no attachment');
	if (!/No attachment on "A paper"/.test(said[0])) throw new Error('unhelpful: ' + said[0]);

	if (await run(fakeItem({ readerType: null })) !== null) throw new Error('opened an unreadable type');
	if (!/no PDF, EPUB or snapshot/.test(said[0])) throw new Error('unhelpful: ' + said[0]);

	// The exact state an item added through the local API without its bytes is
	// left in -- see the note in the project's CLAUDE.md.
	if (await run(fakeItem({ file: false })) !== null) throw new Error('opened a file that is not there');
	if (!/missing on disk/.test(said[0])) throw new Error('unhelpful: ' + said[0]);

	const found = await run(fakeItem());
	if (!found || found.att.id !== 42) throw new Error('refused a perfectly good PDF');
	if (said.length) throw new Error('complained about a working attachment: ' + said[0]);
});

check('ZoteroAdapter implements the whole adapter contract', () => {
	const { ZoteroAdapter } = require_('./lib/zoteroAdapter.js');
	// The four methods every strategy is allowed to call. If one is renamed here
	// but not in localSqlite.js, the two hosts have silently diverged.
	for (const m of ['listItems', 'getAttachments', 'getAttachmentText', 'getPdfLinkUris']) {
		if (typeof ZoteroAdapter.prototype[m] !== 'function') throw new Error('missing ' + m);
	}
	const node = fs.readFileSync(path.join(addonDir, 'citation-graph/adapters/localSqlite.js'), 'utf8');
	for (const m of ['listItems', 'getAttachments', 'getAttachmentText', 'getPdfLinkUris']) {
		if (!node.includes('async ' + m + '(')) throw new Error('localSqlite lost ' + m);
	}
});

check('bytesToBinaryString maps every byte 1:1 across chunk boundaries', () => {
	const { bytesToBinaryString } = require_('./lib/zoteroAdapter.js');
	// 0x8000 is the chunk size, so this spans several chunks and lands a byte in
	// the 0x80-0x9F range -- exactly where TextDecoder('latin1') would corrupt it.
	const bytes = new Uint8Array(0x8000 * 2 + 7);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
	const s = bytesToBinaryString(bytes);
	if (s.length !== bytes.length) throw new Error('length ' + s.length + ' != ' + bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		if (s.charCodeAt(i) !== bytes[i]) {
			throw new Error('byte ' + i + ': ' + s.charCodeAt(i) + ' != ' + bytes[i]);
		}
	}
	// And the specific failure mode, stated outright.
	const ctrl = bytesToBinaryString(new Uint8Array([0x80, 0x9F]));
	if (ctrl.charCodeAt(0) !== 0x80 || ctrl.charCodeAt(1) !== 0x9F) {
		throw new Error('0x80-0x9F remapped to ' + ctrl.charCodeAt(0) + ',' + ctrl.charCodeAt(1)
			+ " -- windows-1252 would give 8364,376");
	}
});

check('scanUriAnnotations matches the Node adapter on the same bytes', () => {
	const { scanUriAnnotations, bytesToBinaryString } = require_('./lib/zoteroAdapter.js');
	const pdf = '%PDF-1.7\n'
		+ '5 0 obj<</Type/Annot/Subtype/Link/A<</URI(https://doi.org/10.1038/nature12373)>>>>endobj\n'
		+ '6 0 obj<</A<</URI(https://doi.org/10.1103/PhysRevX.5.041037)>>>>endobj\n'
		// An escaped paren inside the string, plus a high byte in the padding.
		+ '7 0 obj<</A<</URI(https://example.org/a\\(b\\))>>>>endobj\n'
		+ 'ÿ trailing binary padding\n';
	const bytes = Uint8Array.from([...pdf].map(c => c.charCodeAt(0) & 0xff));
	const got = scanUriAnnotations(bytes).sort();
	const want = [
		'https://doi.org/10.1038/nature12373',
		'https://doi.org/10.1103/PhysRevX.5.041037',
		'https://example.org/a(b)',
	].sort();
	if (JSON.stringify(got) !== JSON.stringify(want)) {
		throw new Error('got ' + JSON.stringify(got));
	}
	// The Node adapter's own regex, applied to the same string, must agree --
	// that equality is what makes the CLI a valid cross-check of the plugin.
	const nodeRe = /\/URI\s*\(((?:[^()\\]|\\[\s\S])*)\)/g;
	const viaNode = [];
	let m;
	const s = bytesToBinaryString(bytes);
	while ((m = nodeRe.exec(s))) viaNode.push(m[1].replace(/\\([()\\])/g, '$1'));
	if (JSON.stringify(viaNode.sort()) !== JSON.stringify(want)) {
		throw new Error('adapters disagree: ' + JSON.stringify(viaNode));
	}
});

check('mergeEdges keeps max confidence and the union of provenance', () => {
	const { mergeEdges } = require_('./lib/graphTab.js');
	const out = mergeEdges(
		[{ from: 'A', to: 'B', confidence: 0.4, via: ['title-match'], evidence: [{ via: 'title-match' }] }],
		[{ from: 'A', to: 'B', confidence: 0.95, via: ['pdf-links'], evidence: [{ via: 'pdf-links', doi: '10.1/x' }] },
			{ from: 'B', to: 'C', confidence: 0.95, via: ['pdf-links'], evidence: [] }]
	);
	if (out.length !== 2) throw new Error('expected 2 edges, got ' + out.length);
	const ab = out.find(e => e.from === 'A' && e.to === 'B');
	if (ab.confidence !== 0.95) throw new Error('confidence ' + ab.confidence);
	if (JSON.stringify(ab.via.sort()) !== JSON.stringify(['pdf-links', 'title-match'])) {
		throw new Error('via ' + JSON.stringify(ab.via));
	}
	if (ab.evidence.length !== 2) throw new Error('evidence dropped');
	// Direction must survive: A->B and B->A are different edges.
	const one = mergeEdges([{ from: 'A', to: 'B', confidence: 0.5, via: ['x'] }],
		[{ from: 'B', to: 'A', confidence: 0.5, via: ['x'] }]);
	if (one.length !== 2) throw new Error('direction collapsed');
});

// --- node links (content/nodeLinks.js) --------------------------------------

/** Same trick as loadScale(): evaluate the content-page script as a browser would. */
function loadLinks() {
	const src = fs.readFileSync(path.join(addonDir, 'content/nodeLinks.js'), 'utf8');
	const ctx = {};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'nodeLinks.js' });
	if (!ctx.ZGLinks) throw new Error('nodeLinks.js did not publish ZGLinks');
	return ctx.ZGLinks;
}

check('the content page and core agree on what a DOI is', () => {
	// nodeLinks.js copies normDoi() because the content page has no module
	// loader and cannot require the core one. This is the test that keeps the
	// copy honest -- without it the two would drift silently, and the graph
	// would offer to open a DOI the builder never made a node for.
	const L = loadLinks();
	const { normDoi } = require_('./citation-graph/core/normalize.js');
	const cases = [
		'10.1038/nature12373',
		'  10.1038/NATURE12373  ',
		'https://doi.org/10.1038/nature12373',
		'http://dx.doi.org/10.1038/nature12373',
		'doi: 10.1038/nature12373',
		'10.1038/nature12373.',
		'10.1038/nature12373)',
		'10.1/x',           // registrant too short
		'nature12373',      // not a DOI at all
		'', null, undefined,
	];
	for (const raw of cases) {
		if (L.normDoi(raw) !== normDoi(raw)) {
			throw new Error(JSON.stringify(raw) + ': ' + L.normDoi(raw) + ' vs ' + normDoi(raw));
		}
	}
});

check('a DOI URL survives the characters that would truncate it', () => {
	const L = loadLinks();
	// encodeURI leaves '#' and '?' alone, and both occur inside real DOIs --
	// unescaped, the first turns the rest of the DOI into a fragment and the
	// second into a query string, and doi.org resolves neither.
	if (L.doiUrl('10.1002/(sici)1099-1097#x') !== 'https://doi.org/10.1002/(sici)1099-1097%23x') {
		throw new Error(L.doiUrl('10.1002/(sici)1099-1097#x'));
	}
	if (L.doiUrl('10.1234/ab?cd') !== 'https://doi.org/10.1234/ab%3Fcd') {
		throw new Error(L.doiUrl('10.1234/ab?cd'));
	}
	// The slash separating prefix from suffix is structure, not a character to
	// escape: %2F would not resolve.
	if (L.doiUrl('10.1038/nature12373') !== 'https://doi.org/10.1038/nature12373') {
		throw new Error(L.doiUrl('10.1038/nature12373'));
	}
	if (L.doiUrl('not a doi') !== null) throw new Error('accepted a non-DOI');
});

check('only a web URL is ever handed to the browser launcher', () => {
	const L = loadLinks();
	// The url field is free text. A local path or a zotero:// link in it must
	// fall through to the DOI rather than reach Zotero.launchURL().
	if (L.itemUrl({ url: 'https://example.org/a', doi: '10.1038/nature12373' })
		!== 'https://example.org/a') {
		throw new Error('the url field should win when it is a web URL');
	}
	if (L.itemUrl({ url: 'file:///C:/papers/a.pdf', doi: '10.1038/nature12373' })
		!== 'https://doi.org/10.1038/nature12373') {
		throw new Error('a file: url was not rejected');
	}
	if (L.itemUrl({ url: 'javascript:alert(1)', doi: null }) !== null) {
		throw new Error('a javascript: url survived');
	}
	if (L.itemUrl({}) !== null) throw new Error('an item with neither should offer nothing');
});

check('an outside reference resolves through whichever namespace keyed it', () => {
	const L = loadLinks();
	const { EXTERNAL_NS } = require_('./citation-graph/core/types.js');
	if (L.externalUrl('doi', '10.1038/nature12373') !== 'https://doi.org/10.1038/nature12373') {
		throw new Error('doi');
	}
	if (L.externalUrl('arxiv', '1303.3629') !== 'https://arxiv.org/abs/1303.3629') {
		throw new Error('arxiv');
	}
	// Every namespace the builder can key an external node with must resolve to
	// something, or the menu would offer a dead entry for nodes that do exist.
	const sample = { doi: '10.1038/nature12373', arxiv: '1303.3629', openalex: 'W123' };
	for (const ns of EXTERNAL_NS) {
		if (!sample[ns]) throw new Error('new namespace ' + ns + ' has no sample id here');
		if (!L.externalUrl(ns, sample[ns])) throw new Error('no URL for namespace ' + ns);
	}
	if (L.externalUrl('pmid', '12345') !== null) throw new Error('invented a URL for an unknown ns');
});

// --- filter masks (content/nodeFilters.js) ----------------------------------

/** Same trick as loadScale(): evaluate the content-page script as a browser would. */
function loadFilters() {
	const src = fs.readFileSync(path.join(addonDir, 'content/nodeFilters.js'), 'utf8');
	const ctx = {};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'nodeFilters.js' });
	if (!ctx.ZGFilters) throw new Error('nodeFilters.js did not publish ZGFilters');
	return ctx.ZGFilters;
}

/** A small library with the shapes that actually break things: a second-position
 *  author, an item in two collections, and one with no venue at all. */
function library(F) {
	return [
		{
			creators: ['Kucsko', 'Maurer'], year: 2013, itemType: 'journalArticle',
			publication: 'Nature', collections: ['Quantum'], title: 'Nanometre-scale thermometry',
		},
		{
			creators: ['Maurer', 'Kucsko'], year: 2012, itemType: 'journalArticle',
			publication: 'Science', collections: ['Quantum', 'Sensing'], title: 'Room-temperature memory',
		},
		{
			creators: ['Socrates'], year: 1999, itemType: 'book',
			publication: null, collections: ['Philosophy'], title: 'Tales of the Republic',
		},
	].map(F.facets);
}

const hits = (F, lib, ...texts) => lib
	.map((f, i) => (F.matchesAll(texts.map(F.parse), f) ? i : -1))
	.filter((i) => i >= 0);

check('a filter matches every author, not just the one on the label', () => {
	const F = loadFilters();
	const lib = library(F);
	// The node label is "Kucsko2013" for one of these and "Maurer2012" for the
	// other. Matching only the first creator -- which is what the colour-by-author
	// mode does -- would make author:Kucsko miss the paper he is second on.
	const both = hits(F, lib, 'author:Kucsko');
	if (both.length !== 2) throw new Error('second-position author missed: ' + both);
	if (hits(F, lib, 'collection:Sensing').join() !== '1') throw new Error('second collection missed');
});

check('a tag is a facet like any other, and every tag on an item counts', () => {
	const F = loadFilters();
	// Its own fixture rather than library(): tags would change what the bare-term
	// and completion-ranking checks are looking at, and those are about something
	// else.
	const lib = [
		{ creators: ['Kucsko'], year: 2013, tags: ['magnetometry', 'to read'], title: 'A' },
		{ creators: ['Maurer'], year: 2012, tags: ['to read'], title: 'B' },
		{ creators: ['Socrates'], year: 1999, tags: [], title: 'C' },
	].map(F.facets);
	// An item's tags are a list, so a mask has to find the one whose SECOND tag
	// it is -- the same shape that makes author:Kucsko work on a second author.
	if (hits(F, lib, 'tag:"to read"').join() !== '0,1') throw new Error('second tag missed');
	if (hits(F, lib, 'tag:magnetometry').join() !== '0') throw new Error('scoped tag');
	// And a bare term reaches tags, which is what makes a tag findable by someone
	// who does not know it is a tag rather than a collection.
	if (hits(F, lib, 'magnetometry').join() !== '0') throw new Error('bare term missed tags');
	// An untagged item is simply not matched, not an error.
	if (hits(F, lib, 'tag:anything').length) throw new Error('untagged item matched');
	// Offered as completions, commonest first, like every other facet's values.
	const offered = F.suggest('tag:', lib, 12).filter(s => s.kind === 'value').map(s => s.label);
	if (offered.join() !== 'to read,magnetometry') throw new Error('tag completions: ' + offered);
});

check('stacking filters can only narrow, never widen', () => {
	const F = loadFilters();
	const lib = library(F);
	const one = hits(F, lib, 'author:Kucsko');
	const two = hits(F, lib, 'author:Kucsko', 'publication:Nature');
	const three = hits(F, lib, 'author:Kucsko', 'publication:Nature', 'year:2013');
	if (!two.every((i) => one.includes(i))) throw new Error('a second mask let something back in');
	if (!three.every((i) => two.includes(i))) throw new Error('a third mask let something back in');
	if (two.join() !== '0' || three.join() !== '0') throw new Error(two + ' / ' + three);
	// Masks that cannot both hold leave nothing, rather than falling back to OR.
	if (hits(F, lib, 'author:Socrates', 'publication:Nature').length) {
		throw new Error('contradictory masks behaved as a union');
	}
});

check('a bare term searches every facet at once', () => {
	const F = loadFilters();
	const lib = library(F);
	// The reason bare terms exist: nobody knows, or should have to know, which
	// field "Tales" or "Quantum" lives in.
	if (hits(F, lib, 'Tales').join() !== '2') throw new Error('title not searched');
	if (hits(F, lib, 'Quantum').join() !== '0,1') throw new Error('collection not searched');
	if (hits(F, lib, 'Socrates').join() !== '2') throw new Error('creator not searched');
	if (hits(F, lib, 'nature').join() !== '0') throw new Error('publication not searched, or case-sensitive');
});

check('year takes comparisons and ranges, and a prefix still means a decade', () => {
	const F = loadFilters();
	const lib = library(F); // 2013, 2012, 1999
	if (hits(F, lib, 'year:2013').join() !== '0') throw new Error('exact year');
	if (hits(F, lib, 'year:>2012').join() !== '0') throw new Error('> is exclusive');
	if (hits(F, lib, 'year:>=2012').join() !== '0,1') throw new Error('>= is inclusive');
	if (hits(F, lib, 'year:<2000').join() !== '2') throw new Error('< is exclusive');
	if (hits(F, lib, 'year:2012-2013').join() !== '0,1') throw new Error('range');
	if (hits(F, lib, 'year:2013-2012').join() !== '0,1') throw new Error('a backwards range should still be a range');
	// Three digits is not a year, so it falls through to a text match and
	// "year:201" keeps meaning the 2010s -- which is the useful reading.
	if (hits(F, lib, 'year:201').join() !== '0,1') throw new Error('prefix should mean a decade');
	if (F.parseYear('201') !== null) throw new Error('three digits parsed as a year');
});

check('an unknown prefix is a search term, not a syntax error', () => {
	const F = loadFilters();
	// DOIs, times and "Vol 3: something" all contain colons. Rejecting them, or
	// silently dropping the half before the colon, would both be wrong.
	const f = F.parse('10.1038:x');
	if (f.field !== null || f.terms[0].value !== '10.1038:x') throw new Error(JSON.stringify(f));
});

check('completions come from the survivors, so one can never empty the graph', () => {
	const F = loadFilters();
	const lib = library(F);
	// The narrowing tree: once Socrates is masked in, no completion may offer a
	// value that only his co-less papers have -- picking one would leave zero
	// nodes on screen, which is exactly the dead end the panel must not lead to.
	const survivors = lib.filter((f) => F.matches(F.parse('author:Socrates'), f));
	for (const s of F.suggest('', survivors)) {
		if (!s.term) continue;
		const picked = F.parse(F.spliceTerm('', s.field, s.term));
		const left = survivors.filter((f) => F.matches(picked, f));
		if (!left.length) throw new Error('offered a dead end: ' + s.label);
	}
	// And the counts have to be the survivors' counts, not the library's.
	const nature = F.suggest('Nature', lib).find((s) => s.kind === 'value');
	if (!nature || nature.count !== 1) throw new Error(JSON.stringify(nature));
});

check('completions rank by coverage and offer the fields before the values', () => {
	const F = loadFilters();
	const lib = library(F);
	const empty = F.suggest('', lib);
	if (empty[0].kind !== 'field' || empty[0].insert !== 'author: ') {
		throw new Error('an empty box should name the fields: ' + JSON.stringify(empty[0]));
	}
	// Within one field, the value covering the most items comes first.
	const authors = F.suggest('author:', lib).map((s) => s.label);
	if (authors[0] !== 'Kucsko' && authors[0] !== 'Maurer') throw new Error(authors.join());
	if (authors[authors.length - 1] !== 'Socrates') throw new Error(authors.join());
	// A half-typed field name is still a field name, not a value search.
	if (!F.suggest('pub', lib).some((s) => s.insert === 'publication: ')) {
		throw new Error('"pub" did not complete to publication:');
	}
});

check('a picked completion pins the value where typed text stays a substring', () => {
	const F = loadFilters();
	const lib = library(F);
	// Typing "soc" has to find Socrates -- nobody types surnames in full. But a
	// value picked off the list means that value and not merely something
	// containing it, or "type: book" would drag in every bookSection.
	if (hits(F, lib, 'author:soc').join() !== '2') throw new Error('typed text should be a substring');
	const pinned = F.exact('author', 'Socrate');
	if (lib.some((f) => F.matches(pinned, f))) throw new Error('a pinned value matched a prefix');
	if (F.key(F.exact('author', 'Socrates')) === F.key(F.parse('author:Socrates'))) {
		throw new Error('pinned and typed filters share an identity, so both cannot be held');
	}
	// Case is not part of the identity: adding the same mask twice, once shouted,
	// must not stack two chips that do the same thing.
	if (F.key(F.exact('author', 'Socrates')) !== F.key(F.exact('author', 'SOCRATES'))) {
		throw new Error('identity is case-sensitive');
	}
});

check('several values in one mask widen it, where a second mask narrows', () => {
	const F = loadFilters();
	const lib = library(F);
	// The grammar in one test. Terms inside a mask OR; masks AND. Getting these
	// the same way round would make "publication: Nature, Science" mean nothing
	// at all, since no paper appears in two journals at once.
	const or = F.parse('publication: "Nature", "Science"');
	const passed = lib.filter((f) => F.matches(or, f)).length;
	if (passed !== 2) throw new Error('terms did not OR: ' + passed);
	// ...and adding a mask over the top still only takes away.
	const narrowed = lib.filter((f) => F.matchesAll([or, F.parse('year:2013')], f)).length;
	if (narrowed !== 1) throw new Error('a second mask did not narrow: ' + narrowed);
	// Order carries no meaning, so two spellings of one mask are one mask.
	if (F.key(F.parse('author: A, B')) !== F.key(F.parse('author: B, A'))) {
		throw new Error('term order changed a mask identity');
	}
	// A repeat inside a mask is a no-op, not a second term.
	if (F.parse('author: "A", "A"').terms.length !== 1) throw new Error('duplicate term kept');
});

check('a comma inside a value survives, and years mix with ranges', () => {
	const F = loadFilters();
	const lib = library(F);
	// "Ann. Phys., Lpz." is one journal. Splitting a term list without honouring
	// quotes would turn it into two masks-worth of nonsense, neither matching.
	if (F.splitTerms('"Ann. Phys., Lpz.", Nature').length !== 2) throw new Error('quoted comma split');
	const f = F.parse('publication: "Ann. Phys., Lpz.", Nature');
	if (f.terms.length !== 2 || f.terms[0].value !== 'Ann. Phys., Lpz.') {
		throw new Error(JSON.stringify(f));
	}
	const awkward = F.facets({ publication: 'Ann. Phys., Lpz.' });
	if (!F.matches(f, awkward)) throw new Error('the quoted value did not match its own journal');
	// ...and the value after it is still a term of its own, not part of it.
	if (lib.filter((x) => F.matches(f, x)).length !== 1) throw new Error('the term after a quoted one was lost');
	// One mask can hold a plain year and a span side by side: 2013, or 1990-2000.
	const mixed = F.parse('year: 2013, 1990-2000');
	if (mixed.terms.length !== 2) throw new Error(JSON.stringify(mixed));
	if (lib.filter((x) => F.matches(mixed, x)).length !== 2) throw new Error('mixed year terms');
});

check('a chip round-trips through the box it is edited in', () => {
	const F = loadFilters();
	// Chips are clickable and go back into the box as text, so toInput() and
	// parse() have to be exact inverses -- otherwise editing a chip would
	// quietly change what it masks. The awkward cases are all here: a pinned
	// value, a substring, a comma, a quote, and a range.
	for (const text of [
		'publication: "Nature", "Science"',
		'publication: "Ann. Phys., Lpz.", ~rev',
		'author: soc',
		'year: 2013, 1990-2000, >=2020, <=1899',
		'title: "He said ""hi"""',
		'tales',
	]) {
		const f = F.parse(text);
		if (!f) throw new Error('did not parse: ' + text);
		const back = F.parse(F.toInput(f));
		if (!back || F.key(back) !== F.key(f)) {
			throw new Error(text + ' -> ' + F.toInput(f) + ' -> ' + JSON.stringify(back));
		}
	}
});

check('picking a value extends the mask being built rather than replacing it', () => {
	const F = loadFilters();
	const lib = library(F);
	// The panel commits the chip on the first pick and rewrites it on every one
	// after, so spliceTerm has to drop only the half-typed tail and leave a
	// trailing comma for the next value.
	let box = F.spliceTerm('publication:', 'publication', '"Nature"');
	box = F.spliceTerm(box, 'publication', '"Science"');
	if (box !== 'publication: "Nature", "Science", ') throw new Error(JSON.stringify(box));
	if (F.parse(box).terms.length !== 2) throw new Error('trailing comma became a term');
	// A half-typed tail is replaced, not kept alongside.
	if (F.spliceTerm('publication: "Nature", Sci', 'publication', '"Science"')
		!== 'publication: "Nature", "Science", ') {
		throw new Error(F.spliceTerm('publication: "Nature", Sci', 'publication', '"Science"'));
	}
	// Reaching for a value from another field rescopes the box: there is no way
	// to say "publication:X or author:Y" in one mask, and keeping the old field
	// would silently mask on the wrong one.
	if (F.spliceTerm('nat', 'author', '"Socrates"') !== 'author: "Socrates", ') {
		throw new Error(F.spliceTerm('nat', 'author', '"Socrates"'));
	}
	// Values already in the mask are not offered again -- a top row that does
	// nothing is worse than a shorter list.
	const after = F.suggest('publication: "Nature", ', lib).map((s) => s.label);
	if (after.includes('Nature')) throw new Error('offered a value already in the mask');
	if (!after.includes('Science')) throw new Error(after.join());
	// Past the first comma the field is settled, so field names stop being
	// offered -- "publication: Nature, author:" is not a thing that parses.
	if (F.suggest('publication: "Nature", a', lib).some((s) => s.insert)) {
		throw new Error('offered a field name mid-list');
	}
});

// --- coupling and communities (content/graphCluster.js) ---------------------

/** Same trick as loadScale(): evaluate the content-page script as a browser would. */
function loadCluster() {
	const src = fs.readFileSync(path.join(addonDir, 'content/graphCluster.js'), 'utf8');
	const ctx = {};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'graphCluster.js' });
	if (!ctx.ZGCluster) throw new Error('graphCluster.js did not publish ZGCluster');
	return ctx.ZGCluster;
}

/**
 * Two subfields that never cite each other, one paper bridging them by a single
 * citation, and one that shares nothing with anybody.
 *
 * The shape is the whole argument for coupling: within each group the only
 * evidence of kinship is agreement about works the library does NOT hold, which
 * is exactly what the citation graph cannot show and what an offline build
 * produces most of.
 */
function couplingLibrary() {
	const items = [
		{ key: 'AAAA0001', title: 'Nanoscale magnetometry with nitrogen vacancy centres' },
		{ key: 'AAAA0002', title: 'Nitrogen vacancy magnetometry in diamond' },
		{ key: 'AAAA0003', title: 'Diamond magnetometry at the nanoscale' },
		{ key: 'BBBB0001', title: 'Surface code quantum error correction' },
		{ key: 'BBBB0002', title: 'Quantum error correction with the surface code' },
		{ key: 'BBBB0003', title: 'Fault tolerant error correction thresholds' },
		{ key: 'CCCC0001', title: 'An unrelated treatise on beekeeping' },
	];
	const e = (from, to) => ({ from, to });
	const edges = [
		e('AAAA0001', 'doi:nv1'), e('AAAA0001', 'doi:nv2'),
		e('AAAA0002', 'doi:nv1'), e('AAAA0002', 'doi:nv2'),
		e('AAAA0003', 'doi:nv1'), e('AAAA0003', 'doi:nv3'),
		e('BBBB0001', 'doi:qec1'), e('BBBB0001', 'doi:qec2'),
		e('BBBB0002', 'doi:qec1'), e('BBBB0002', 'doi:qec2'),
		e('BBBB0003', 'doi:qec2'), e('BBBB0003', 'doi:qec3'),
		e('BBBB0003', 'BBBB0001'),
		e('CCCC0001', 'doi:bees'),
	];
	return { items, edges };
}

check('coupling reads the agreement the citation graph cannot show', () => {
	const C = loadCluster();
	const { items, edges } = couplingLibrary();
	const { pairs } = C.coupling(edges, items.map(i => i.key));
	const w = (a, b) => {
		const p = pairs.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
		return p ? p.w : 0;
	};
	// Not one citation edge runs between these two, and they are still the
	// strongest pair in the library: same two references, nothing else.
	if (!(w('AAAA0001', 'AAAA0002') > 0.99)) throw new Error('identical bibliographies: ' + w('AAAA0001', 'AAAA0002'));
	if (!(w('AAAA0001', 'AAAA0003') > 0)) throw new Error('one shared reference missed');
	// And nothing couples across the two subfields.
	if (w('AAAA0001', 'BBBB0001')) throw new Error('coupled two papers sharing no reference');
	// A ghost is a first-class coupling target, so a pair can exist entirely on
	// works the collection does not hold.
	if (!pairs.length) throw new Error('no pairs at all');
});

check('a long bibliography does not couple a paper to everything', () => {
	const C = loadCluster();
	const edges = [];
	for (let i = 0; i < 40; i++) edges.push({ from: 'LONG0001', to: 'doi:r' + i });
	for (const key of ['SHRT0001', 'SHRT0002']) {
		edges.push({ from: key, to: 'doi:r0' });
		edges.push({ from: key, to: 'doi:r1' });
	}
	const { pairs } = C.coupling(edges, ['LONG0001', 'SHRT0001', 'SHRT0002']);
	const w = (a, b) => pairs.find(x => x.a === a && x.b === b).w;
	// Both short papers share their whole bibliography with each other and the
	// same two entries with the long one. Un-normalised, the long paper would
	// look equally close to both -- which is how one review ends up the centre
	// of every cluster it appears in.
	if (!(w('SHRT0001', 'SHRT0002') > 3 * w('LONG0001', 'SHRT0001'))) {
		throw new Error('cosine did not discount the long bibliography');
	}
});

check('a reference everybody cites couples nobody', () => {
	const C = loadCluster();
	const held = [];
	const edges = [];
	for (let i = 0; i < 8; i++) {
		const key = 'HELD000' + i;
		held.push(key);
		edges.push({ from: key, to: 'doi:everyone' });
	}
	edges.push({ from: 'HELD0000', to: 'doi:rare' });
	edges.push({ from: 'HELD0001', to: 'doi:rare' });
	const { pairs } = C.coupling(edges, held);
	// The field's universal citation says only that these are all papers in the
	// field. Left in, it would pair all 28 combinations into one blob and bury
	// the one agreement that means something.
	if (pairs.length !== 1) throw new Error('background reference coupled ' + pairs.length + ' pairs');
	if (pairs[0].a !== 'HELD0000' || pairs[0].b !== 'HELD0001') throw new Error('wrong pair survived');
});

check('the partition recovers subfields that never cite each other', () => {
	const C = loadCluster();
	const { items, edges } = couplingLibrary();
	const r = C.cluster(edges, items);
	const of = r.of;
	if (r.count !== 2) throw new Error('expected two subfields, got ' + r.count);
	if (of.get('AAAA0001') !== of.get('AAAA0003')) throw new Error('split a subfield');
	if (of.get('BBBB0001') !== of.get('BBBB0003')) throw new Error('split a subfield');
	if (of.get('AAAA0001') === of.get('BBBB0001')) throw new Error('merged both subfields');
	// A paper sharing no reference with anything has no subfield. Assigning it
	// one would be the graph inventing a claim about it.
	if (of.has('CCCC0001')) throw new Error('placed an uncoupled paper');
	if (r.unassigned !== 1) throw new Error('unassigned: ' + r.unassigned);
	// Below ~0.3 a partition is mostly the algorithm's own doing; this one is
	// two genuinely separate groups and has to score well clear of that.
	if (!(r.modularity > 0.3)) throw new Error('modularity ' + r.modularity.toFixed(3));
});

check('the same library partitions the same way however it arrives', () => {
	const C = loadCluster();
	const { items, edges } = couplingLibrary();
	const a = C.cluster(edges, items);
	// Louvain is order-sensitive by nature. Here that would show as a graph
	// repainting itself in different colours on a rebuild that changed nothing,
	// so the module sorts its way out of it -- and this is what says so.
	const b = C.cluster(edges.slice().reverse(), items.slice().reverse());
	for (const [key, label] of a.of) {
		if (b.of.get(key) !== label) throw new Error(key + ': ' + label + ' vs ' + b.of.get(key));
	}
	if (a.of.size !== b.of.size) throw new Error('different populations placed');
});

check('a cluster is named after what its members share', () => {
	const C = loadCluster();
	const { items, edges } = couplingLibrary();
	const of = C.cluster(edges, items).of;
	const nv = of.get('AAAA0001');
	const qec = of.get('BBBB0001');
	// The name has to come from the terms the cluster agrees on, not from any
	// one title -- and a phrase beats its own words when both say the same
	// thing, because "error correction" names a field and "correction" does not.
	if (!/magnetometry/.test(nv)) throw new Error('NV cluster named ' + nv);
	if (!/error correction/.test(qec)) throw new Error('QEC cluster named ' + qec);
	if (nv === qec) throw new Error('both clusters got one name');
});

check('two clusters never end up under one name', () => {
	const C = loadCluster();
	// Same title word for word in both groups, coupled to different literatures.
	const items = [];
	const edges = [];
	for (const [group, ref] of [['DDDD', 'doi:d'], ['EEEE', 'doi:e']]) {
		for (let i = 0; i < 3; i++) {
			const key = group + '000' + i;
			items.push({ key, title: 'Quantum sensing protocols' });
			edges.push({ from: key, to: ref + '1' });
			edges.push({ from: key, to: ref + '2' });
		}
	}
	const r = C.cluster(edges, items);
	if (r.count !== 2) throw new Error('expected two clusters, got ' + r.count);
	// One name for two clusters would be one colour and one legend row: the
	// screen would say they are the same group, and the filter mask naming that
	// value would select both.
	if (r.sizes.size !== 2) throw new Error('two clusters share a name: ' + [...r.sizes.keys()]);
});

// --- the gap list (content/graphGaps.js) ------------------------------------

/** Same trick as loadScale(): evaluate the content-page script as a browser would. */
function loadGaps() {
	const src = fs.readFileSync(path.join(addonDir, 'content/graphGaps.js'), 'utf8');
	const ctx = {};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'graphGaps.js' });
	if (!ctx.ZGGaps) throw new Error('graphGaps.js did not publish ZGGaps');
	return ctx.ZGGaps;
}

check('a gap is ranked by how hard the library leans on it, not by fame', () => {
	const G = loadGaps();
	// The landmark everybody cites against the obscure thing four of your own
	// papers quietly depend on. Ranked on the local count alone the landmark
	// wins, and that is the one answer nobody needs: you know about it, and not
	// holding a famous paper is a decision rather than an oversight.
	const edges = [];
	for (let i = 0; i < 5; i++) edges.push({ from: 'HELD000' + i, to: 'doi:famous' });
	for (let i = 0; i < 4; i++) edges.push({ from: 'HELD000' + i, to: 'doi:obscure' });
	const externals = [
		{ key: 'doi:famous', ns: 'doi', id: '10.1/famous', citedByGlobal: 41000 },
		{ key: 'doi:obscure', ns: 'doi', id: '10.1/obscure', citedByGlobal: 90 },
	];
	const { rows } = G.rank(edges, externals);
	if (rows[0].key !== 'doi:obscure') throw new Error('fame won: ' + rows.map(r => r.key).join());
	// Discounted, never cancelled: enough local citers still beats any fame.
	for (let i = 5; i < 12; i++) edges.push({ from: 'HELD00' + i, to: 'doi:famous' });
	if (G.rank(edges, externals).rows[0].key !== 'doi:famous') {
		throw new Error('twelve citers should outrank four whatever the fame');
	}
});

check('with nothing looked up the ranking is plainly the local count', () => {
	const G = loadGaps();
	// No enrichment means no count to discount by, and the honest answer to the
	// question asked without one is "most cited here" -- not a silent reordering
	// by a number that is not there.
	const edges = [];
	for (let i = 0; i < 4; i++) edges.push({ from: 'HELD000' + i, to: 'doi:a' });
	for (let i = 0; i < 2; i++) edges.push({ from: 'HELD000' + i, to: 'doi:b' });
	const rows = G.rank(edges, [
		{ key: 'doi:b', ns: 'doi', id: '10.1/b' },
		{ key: 'doi:a', ns: 'doi', id: '10.1/a' },
	]).rows;
	if (rows.map(r => r.key).join() !== 'doi:a,doi:b') throw new Error(rows.map(r => r.key).join());
	// An unresolved count and a resolved zero are the same score by
	// construction; neither is allowed to read as the other's opposite.
	if (G.score(4, null) !== G.score(4, 0)) throw new Error('unresolved and zero diverged');
});

check('the citer count comes from the edges handed in, not the build total', () => {
	const G = loadGaps();
	// The build counted this over every strategy at full confidence. By the time
	// the list is drawn the user may have switched one off, and a row claiming
	// nine citers over a graph that now shows two is a row nobody can check.
	const edges = [
		{ from: 'HELD0001', to: 'doi:x' },
		{ from: 'HELD0002', to: 'doi:x' },
		// A duplicate pair must not count as a second citer.
		{ from: 'HELD0002', to: 'doi:x' },
	];
	const { rows } = G.rank(edges, [{ key: 'doi:x', ns: 'doi', id: '10.1/x', citedBy: 9 }]);
	if (rows[0].citedBy !== 2) throw new Error('citedBy ' + rows[0].citedBy);
	if (rows[0].citers.join() !== 'HELD0001,HELD0002') throw new Error(rows[0].citers.join());
});

check('single-citation noise stays out of the list', () => {
	const G = loadGaps();
	// 3,172 works are cited exactly once on the sample library, and a lone
	// harvested DOI is as likely to be a licence URL as a reference.
	const edges = [{ from: 'HELD0001', to: 'doi:once' }, { from: 'HELD0001', to: 'doi:twice' },
		{ from: 'HELD0002', to: 'doi:twice' }];
	const externals = [{ key: 'doi:once', ns: 'doi', id: '10.1/once' },
		{ key: 'doi:twice', ns: 'doi', id: '10.1/twice' }];
	const { rows, total } = G.rank(edges, externals);
	if (rows.length !== 1 || rows[0].key !== 'doi:twice') throw new Error('floor let noise through');
	if (total !== 1) throw new Error('total counts what the floor kept: ' + total);
	// And the floor is a choice, not a law -- the CLI and a future control can
	// ask for the tail.
	if (G.rank(edges, externals, { minCitedBy: 1 }).rows.length !== 2) throw new Error('floor not adjustable');
});

check('a gap says which subfield is leaning on it, or that several are', () => {
	const G = loadGaps();
	const clusterOf = new Map([
		['HELD0001', 'error correction'], ['HELD0002', 'error correction'],
		['HELD0003', 'magnetometry'],
	]);
	const edges = [
		{ from: 'HELD0001', to: 'doi:qec' }, { from: 'HELD0002', to: 'doi:qec' },
		{ from: 'HELD0001', to: 'doi:both' }, { from: 'HELD0003', to: 'doi:both' },
	];
	const externals = [{ key: 'doi:qec', ns: 'doi', id: '10.1/qec' },
		{ key: 'doi:both', ns: 'doi', id: '10.1/both' }];
	const by = new Map(G.rank(edges, externals, { clusterOf }).rows.map(r => [r.key, r.subfields]));
	// One subfield owning a gap is a hole in that subfield and can be named.
	if (by.get('doi:qec').top !== 'error correction') throw new Error(JSON.stringify(by.get('doi:qec')));
	// An even split is the collection's common ground, and claiming either half
	// owned it would be picking one at random.
	if (by.get('doi:both').top !== null) throw new Error('named an owner for a split gap');
	if (by.get('doi:both').spread !== 2) throw new Error('spread ' + by.get('doi:both').spread);
});

check('the list is capped but says what it is not showing', () => {
	const G = loadGaps();
	const edges = [];
	const externals = [];
	for (let i = 0; i < 40; i++) {
		const key = 'doi:g' + i;
		externals.push({ key, ns: 'doi', id: '10.1/g' + i });
		edges.push({ from: 'HELD0001', to: key }, { from: 'HELD0002', to: key });
	}
	const r = G.rank(edges, externals, { limit: 5 });
	if (r.rows.length !== 5) throw new Error('cap ignored');
	if (r.total !== 40) throw new Error('total should count every gap over the floor: ' + r.total);
	// Equal scores throughout, so only a stable tie-break keeps the same five at
	// the top between two renders of an unchanged library.
	const again = G.rank(edges.slice().reverse(), externals.slice().reverse(), { limit: 5 });
	if (r.rows.map(x => x.key).join() !== again.rows.map(x => x.key).join()) {
		throw new Error('order moved on reshuffled input');
	}
});

/**
 * A popover shown and hidden through the `hidden` attribute is defeated by its
 * own `display:` rule: an author rule beats the UA stylesheet's
 * `[hidden] { display: none }`, so the element is simply always on screen and
 * the code that "hides" it sets an attribute nothing reads. #group shipped that
 * way once -- visible from the moment the tab opened, with a Done button that
 * did nothing -- and every other floating element in the page had already hit
 * it and grown the same one-line rule. Cheap to assert, invisible until it
 * bites, and it bites in the one place a test cannot look: the screen.
 */
check('nothing hidden by attribute is left visible by its own display rule', () => {
	const html = fs.readFileSync(path.join(addonDir, 'content/graph.html'), 'utf8');
	const js = fs.readFileSync(path.join(addonDir, 'content/graph.js'), 'utf8');
	const css = fs.readFileSync(path.join(addonDir, 'content/graph.css'), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '');

	// Everything the page hides: markup that starts hidden, plus whatever
	// graph.js assigns .hidden on, through the `let elFoo = el('foo')` handles.
	const ids = new Set();
	for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden="hidden"/g)) ids.add(m[1]);
	for (const m of html.matchAll(/<[^>]*\bhidden="hidden"[^>]*\bid="([^"]+)"/g)) ids.add(m[1]);
	const byVar = new Map();
	for (const m of js.matchAll(/let (\w+) = el\('([^']+)'\)/g)) byVar.set(m[1], m[2]);
	for (const m of js.matchAll(/(\w+)\.hidden = /g)) {
		if (byVar.has(m[1])) ids.add(byVar.get(m[1]));
	}
	if (ids.size < 5) throw new Error('found only ' + ids.size + ' hidden elements; the scan is broken');

	// One pass over the sheet, collecting for each id whether some rule gives it
	// a display and whether some rule takes it away again while hidden.
	const displayed = new Set();
	const guarded = new Set();
	for (const rule of css.split('}')) {
		const [selectors, body] = rule.split('{');
		if (!body) continue;
		const sels = selectors.split(',').map(s => s.trim());
		for (const s of sels) {
			if (/(^|[^-\w])display\s*:/.test(body) && ids.has(s.slice(1))) displayed.add(s.slice(1));
			const m = s.match(/^#([\w-]+)\[hidden\]$/);
			if (m) guarded.add(m[1]);
		}
	}

	const bad = [...displayed].filter(id => !guarded.has(id));
	if (bad.length) {
		throw new Error('#' + bad.join(', #') + ': has a display rule but no #id[hidden] rule, '
			+ 'so the hidden attribute will not hide it');
	}
});

/**
 * Zotero's --material-* border variables hold a whole shorthand -- panedivider
 * is "1px solid var(--color-panedivider)", not a colour -- so wrapping one in
 * another shorthand produces "1px solid 1px solid #dadada", which the parser
 * throws away. The rule then does nothing, silently, and a missing hairline is
 * exactly the kind of thing you stop seeing after the third look at a
 * screenshot. Both mistakes below shipped.
 */
check('a Zotero border variable is used as the shorthand it is', () => {
	for (const name of ['splitPane.js', 'readerPane.js', 'itemPane.js']) {
		const src = fs.readFileSync(path.join(addonDir, 'lib', name), 'utf8')
			// Comments talk about the wrong version on purpose.
			.replace(/\/\*[\s\S]*?\*\//g, '');
		for (const m of src.matchAll(/([\w-]+)\s*:\s*([^;\n]*var\(--material-(?:panedivider|border-[\w-]+)\)[^;\n]*)/g)) {
			const [, prop, value] = m;
			if (/\d|solid|dashed|none/.test(value.replace(/var\([^)]*\)/g, ''))) {
				throw new Error(name + ': ' + prop + ' nests a border shorthand -- ' + value.trim());
			}
			if (!/^border(-(top|right|bottom|left))?$/.test(prop)) {
				throw new Error(name + ': ' + prop + ' is not a border, and the variable is one');
			}
		}
	}
});

/**
 * A flag has to take its press before the two layers underneath it do: d3-zoom
 * reads a left drag on the canvas as a pan, and force-graph raises a background
 * click on the way up that gives the whole graph back. Registered in the bubble
 * phase, or swallowing with anything short of stopImmediatePropagation -- which
 * is what it takes, force-graph's own listeners being on the container itself
 * and registered later -- the gesture is lost to the layer beneath and a flag
 * simply cannot be picked up. Nothing about that is visible in the source.
 */
check('a flag takes the press before the canvas does', () => {
	const js = fs.readFileSync(path.join(addonDir, 'content/graph.js'), 'utf8');
	const after = (needle, n) => {
		const i = js.indexOf(needle);
		return i < 0 ? '' : js.slice(i, i + n);
	};
	for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
		if (!after("elGraph.addEventListener('" + type + "', ", 60).includes(', true)')) {
			throw new Error(type + ' is not taken on the container in the capture phase');
		}
	}
	// The compatibility mouse events are the same press arriving twice, and
	// d3-zoom listens for the second of them rather than the first.
	if (!after("['mousedown', 'mousemove', 'mouseup']", 140).includes('addEventListener(type, flagGuard, true)')) {
		throw new Error('the mouse events are not guarded while a flag is being dragged');
	}
	if (!after('function swallow(e) {', 140).includes('stopImmediatePropagation()')) {
		throw new Error('a swallowed press still reaches the listeners beside it');
	}
});

/**
 * Right-clicking a node mid-drag ends the drag and opens the menu, but the left
 * button is still down: the press that began the drag outlives the gesture it
 * started. force-graph raises its clicks from its own pointerup handler, gated
 * on a drag flag it dropped the moment the right button ended the gesture -- so
 * that release arrives as an ordinary click on whatever is under the pointer,
 * which dismisses the menu, isolates the node, and drops the hold keeping it
 * where the user put it. Moving onto the menu first was the only thing that
 * avoided it, by taking the release off the canvas, and no user should have to
 * know that.
 *
 * Nothing about the sequence is visible in the source, so what is asserted here
 * is that both clicks ask first, and that the flag they read has two ways out.
 */
check('the release that ends a right-clicked drag is not a click', () => {
	const js = fs.readFileSync(path.join(addonDir, 'content/graph.js'), 'utf8');
	const after = (needle, n) => {
		const i = js.indexOf(needle);
		return i < 0 ? '' : js.slice(i, i + n);
	};
	for (const handler of ['fg.onNodeClick(', 'fg.onBackgroundClick(']) {
		if (!after(handler, 120).includes('if (spentPress()) return;')) {
			throw new Error(handler + ') acts on the click that ends a right-clicked drag');
		}
	}
	// Marked where the menu opens, and only while the left button is still down.
	if (!after('menuPress = ', 40).includes('event.buttons & 1')) {
		throw new Error('the press is marked without checking that it is still held');
	}
	// A release that lands on the menu raises no click at all, so the flag needs
	// a second way out or it eats the next real one.
	if (!/pointerdown', \(\) => \{\s*menuPress = false;/.test(js)) {
		throw new Error('a spent press with no click of its own is never cleared');
	}
});

// --- localisation -----------------------------------------------------------

const Ftl = require(path.join(addonDir, 'content/ftl.js'));
const localeDir = path.join(addonDir, 'locale');
const FTL_NAME = 'zotero-graph.ftl';
const PREFIX = 'zotero-graph-';

function readLocale(code) {
	return fs.readFileSync(path.join(localeDir, code, FTL_NAME), 'utf8');
}

check('ftl.js reads values, attributes and continuation lines', () => {
	const m = Ftl.parse([
		'# a comment',
		'thing = plain',
		'',
		'other =',
		'    .label = An attribute',
		'wrapped = this one was too long',
		'    for a single line',
	].join('\n'));
	if (m.thing !== 'plain') throw new Error('value: ' + JSON.stringify(m.thing));
	if (m['other.label'] !== 'An attribute') throw new Error('attribute: ' + JSON.stringify(m['other.label']));
	// A message that carries only attributes has no value of its own.
	if ('other' in m) throw new Error('stored an empty value for an attribute-only message');
	if (m.wrapped !== 'this one was too long for a single line') {
		throw new Error('continuation: ' + JSON.stringify(m.wrapped));
	}
});

check('ftl.js substitutes variables and leaves what it cannot read', () => {
	if (Ftl.format('cited by { $count } here', { count: 3 }) !== 'cited by 3 here') {
		throw new Error('substitution');
	}
	// A missing variable is a hole, not a crash.
	if (Ftl.format('a { $missing }b', {}) !== 'a b') throw new Error('missing variable');
	// Quoted literals are how a pattern keeps its edge whitespace.
	if (Ftl.format('{ ", or " }', {}) !== ', or ') throw new Error('quoted literal');
	// Anything else survives verbatim, so a broken string is visible.
	if (Ftl.format('{ SOMEFUNC() }', {}) !== '{ SOMEFUNC() }') throw new Error('unknown placeable');
});

check('ftl.js picks plural variants by CLDR category', () => {
	const p = '{ $n -> [one] { $n } edge *[other] { $n } edges }';
	if (Ftl.format(p, { n: 1 }, 'en-US') !== '1 edge') throw new Error('one');
	if (Ftl.format(p, { n: 4 }, 'en-US') !== '4 edges') throw new Error('other');
	// An exact key beats the category it would otherwise fall into.
	const z = '{ $n -> [0] none *[other] { $n } of them }';
	if (Ftl.format(z, { n: 0 }, 'en-US') !== 'none') throw new Error('exact key');
	if (Ftl.format(z, { n: 2 }, 'en-US') !== '2 of them') throw new Error('default variant');
	// Polish has a third form; the selector must be able to reach it.
	const pl = '{ $n -> [one] jedna *[few] kilka *[other] wiele }';
	if (Ftl.format(pl, { n: 1 }, 'pl') !== 'jedna') throw new Error('pl one');
});

check('every shipped locale is declared in lib/l10n.js and vice versa', () => {
	const onDisk = fs.readdirSync(localeDir)
		.filter(d => fs.existsSync(path.join(localeDir, d, FTL_NAME)))
		.sort();
	const src = fs.readFileSync(path.join(addonDir, 'lib/l10n.js'), 'utf8');
	const m = src.match(/const LOCALES = \[([^\]]*)\]/);
	if (!m) throw new Error('could not find LOCALES in lib/l10n.js');
	const declared = m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1)).sort();
	if (JSON.stringify(onDisk) !== JSON.stringify(declared)) {
		throw new Error('on disk ' + JSON.stringify(onDisk) + ' vs declared ' + JSON.stringify(declared));
	}
});

check('every locale carries the same message list as en-US', () => {
	const base = Object.keys(Ftl.parse(readLocale('en-US'))).sort();
	const others = fs.readdirSync(localeDir).filter(d => d !== 'en-US');
	for (const code of others) {
		const got = Object.keys(Ftl.parse(readLocale(code))).sort();
		const missing = base.filter(id => !got.includes(id));
		const extra = got.filter(id => !base.includes(id));
		if (missing.length || extra.length) {
			throw new Error(code + ': missing ' + JSON.stringify(missing)
				+ ', extra ' + JSON.stringify(extra));
		}
	}
});

check('every locale fills the same variables as en-US', () => {
	const vars = (pattern) => {
		const out = new Set();
		for (const m of pattern.matchAll(/\$([A-Za-z][\w-]*)/g)) out.add(m[1]);
		return [...out].sort().join(',');
	};
	const base = Ftl.parse(readLocale('en-US'));
	for (const code of fs.readdirSync(localeDir).filter(d => d !== 'en-US')) {
		const got = Ftl.parse(readLocale(code));
		for (const id of Object.keys(base)) {
			// A translation that drops a variable loses the number it was there
			// to show; one that invents a variable renders an empty hole.
			if (got[id] != null && vars(got[id]) !== vars(base[id])) {
				throw new Error(code + '/' + id + ': ' + JSON.stringify(vars(got[id]))
					+ ' vs ' + JSON.stringify(vars(base[id])));
			}
		}
	}
});

/**
 * Ids the source asks for by hand, and the families it builds at runtime.
 *
 * The families are the two places an id is assembled from a value rather than
 * written out -- the colour modes and the filter facets -- so they cannot be
 * found by reading the source and are listed here instead. The facet list is
 * FIELDS in nodeFilters.js, and the check below keeps the two in step.
 */
function referencedIds() {
	const ids = new Set();
	const files = [
		'content/graph.js', 'content/nodeFilters.js',
		'lib/graphTab.js', 'lib/readerPane.js', 'lib/itemPane.js', 'lib/splitPane.js',
		'lib/addDialog.js',
		'lib/main.js',
	].map(f => fs.readFileSync(path.join(addonDir, f), 'utf8'));

	const idLike = /'([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'/g;
	for (const src of files) {
		for (const call of src.matchAll(/\b(?:t|tr|attr)\(([^)]*)\)/g)) {
			for (const s of call[1].matchAll(idLike)) ids.add(s[1]);
		}
	}
	const html = fs.readFileSync(path.join(addonDir, 'content/graph.html'), 'utf8');
	for (const m of html.matchAll(/data-zg-(?:str|title|placeholder|aria-label)="([^"]+)"/g)) {
		ids.add(m[1]);
	}
	for (const mode of ['year', 'collection', 'cluster', 'author', 'publication', 'type']) {
		ids.add('color-by-' + mode);
	}
	// Two per facet: the label on the chip, and the keyword the box parses.
	for (const f of ['author', 'year', 'tag', 'type', 'publication', 'collection', 'cluster', 'title']) {
		ids.add('field-' + f);
		ids.add('fieldkey-' + f);
	}
	return ids;
}

check('every id the source asks for exists in en-US', () => {
	const have = Object.keys(Ftl.parse(readLocale('en-US')));
	// Either as a message or as one carrying attributes: attr() asks for the
	// message by name and names the attribute separately.
	const known = new Set(have.concat(have.map(id => id.replace(/\.[\w-]+$/, ''))));
	const missing = [...referencedIds()].filter(id => !known.has(PREFIX + id)).sort();
	if (missing.length) throw new Error('not in the .ftl: ' + missing.join(', '));
});

check('en-US carries no message nothing asks for', () => {
	const have = Object.keys(Ftl.parse(readLocale('en-US')))
		// Attributes are addressed as "id.attribute"; the reference scan sees
		// only the message half, which attr() passes separately.
		.map(id => id.slice(PREFIX.length).replace(/\.[\w-]+$/, ''));
	const asked = referencedIds();
	const dead = [...new Set(have)].filter(id => !asked.has(id)).sort();
	if (dead.length) throw new Error('unreferenced: ' + dead.join(', '));
});

check('lib/l10n.js resolves a locale, formats, and hands the page its source', async () => {
	const l10n = require_('./lib/l10n.js');
	await l10nReady;
	if (l10n.t('rebuild') !== 'Rebuild') throw new Error('plain: ' + l10n.t('rebuild'));
	if (l10n.t('stats-edges', { count: 1 }) !== '1 edge') throw new Error('plural');
	if (l10n.attr('view-citation-graph', 'label') !== 'View Citation Graph') {
		throw new Error('attribute: ' + l10n.attr('view-citation-graph', 'label'));
	}
	// A missing id comes back as the id, so a typo is visible rather than blank.
	if (l10n.t('no-such-string') !== 'no-such-string') throw new Error('missing id');
	const forPage = l10n.contentBundle();
	if (forPage.locale !== 'en-US') throw new Error('locale: ' + forPage.locale);
	if (!forPage.source.includes('zotero-graph-rebuild')) throw new Error('empty source');
});

check('the page loads its string modules before anything that draws', () => {
	const html = fs.readFileSync(path.join(addonDir, 'content/graph.html'), 'utf8');
	const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
	for (const [before, after] of [['ftl.js', 'l10n.js'], ['l10n.js', 'graph.js'],
		['l10n.js', 'nodeFilters.js']]) {
		if (order.indexOf(before) < 0 || order.indexOf(after) < 0) {
			throw new Error('missing script: ' + before + ' or ' + after);
		}
		if (order.indexOf(before) > order.indexOf(after)) {
			throw new Error(before + ' must be loaded before ' + after);
		}
	}
});

check('icons.js is loaded before the menu that draws from it', () => {
	const html = fs.readFileSync(path.join(addonDir, 'content/graph.html'), 'utf8');
	const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
	if (order.indexOf('icons.js') < 0) throw new Error('icons.js is not loaded at all');
	if (order.indexOf('icons.js') > order.indexOf('graph.js')) {
		throw new Error('icons.js must be loaded before graph.js');
	}
});

/** Same trick as loadFilters(), with just enough of a document for svg() to
 *  build into: FakeElement already keeps attributes and children. */
function loadIcons() {
	const src = fs.readFileSync(path.join(addonDir, 'content/icons.js'), 'utf8');
	const made = [];
	const ctx = {
		window: {
			document: { createElementNS: (ns, name) => new FakeElement(name, made) },
		},
	};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'icons.js' });
	if (!ctx.window.ZGIcons) throw new Error('icons.js did not publish ZGIcons');
	return ctx.window.ZGIcons;
}

/**
 * Every menu entry names an icon, and every name it gives resolves.
 *
 * A missing icon is deliberately not a visible failure -- svg() draws an empty
 * box of the right width, so that one renamed icon cannot leave a column of
 * labels half-indented -- which means it would ship as a blank space beside one
 * entry and nothing would say so. Hence reading the entries out of the source:
 * they are object literals built in six separate places, and the one thing they
 * all have is an icon directly above a label.
 */
check('every menu entry names an icon that icons.js can draw', () => {
	const src = fs.readFileSync(path.join(addonDir, 'content/graph.js'), 'utf8');
	const icons = loadIcons();
	const entries = [...src.matchAll(/\n\t+(?:icon: (.*?),\r?\n\t+)?label: t\(/g)];
	if (entries.length < 12) {
		throw new Error('found only ' + entries.length + ' entries; the scan is broken');
	}
	const bad = [];
	for (const [, icon] of entries) {
		if (icon == null) {
			bad.push('(an entry with no icon at all)');
			continue;
		}
		// A plain name, or a ternary between two of them.
		const names = [...icon.matchAll(/'([^']+)'/g)].map(m => m[1]);
		if (!names.length) throw new Error('could not read an icon name out of: ' + icon);
		for (const n of names) if (!icons.has(n)) bad.push(n);
	}
	if (bad.length) throw new Error('no such icon: ' + bad.join(', '));
});

/**
 * The icons are Zotero's own files, copied in rather than referenced, because
 * chrome:// is out of reach from a content docshell. What goes wrong in copying
 * is a path that lost a character on the way -- which draws a subtly wrong
 * shape rather than nothing at all -- and a fill that was left as Zotero wrote
 * it: `context-fill` means something to a chrome image loader and nothing
 * whatsoever here, so an icon carrying it would render invisible.
 */
check('every icon is a drawable path that paints in the menu colour', () => {
	// Comments stripped first: both names below appear in them, to say why the
	// thing they name is gone.
	const src = fs.readFileSync(path.join(addonDir, 'content/icons.js'), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	if (/context-fill/.test(src)) {
		throw new Error('context-fill does not resolve in a content page; use currentColor');
	}
	// Zotero wraps several of these in a clipPath whose id would be the same in
	// every copy, and two of them inlined into one document is one clip too many.
	if (/clip-path|clipPath/.test(src)) throw new Error('a clipPath id would collide');

	const icons = loadIcons();
	if (icons.names().length < 10) throw new Error('only ' + icons.names().length + ' icons');
	for (const name of icons.names()) {
		const svg = icons.svg(name);
		if (!/^0 0 (16|20) (16|20)$/.test(svg.getAttribute('viewBox'))) {
			throw new Error(name + ': viewBox ' + svg.getAttribute('viewBox'));
		}
		if (svg.getAttribute('fill') !== 'currentColor') {
			throw new Error(name + ': fill is ' + svg.getAttribute('fill'));
		}
		const paths = svg.children.filter(c => c.localName === 'path');
		if (!paths.length) throw new Error(name + ': no paths');
		for (const p of paths) {
			const d = p.getAttribute('d');
			if (!/^M/.test(d)) throw new Error(name + ': a path does not start with a moveto');
			if (!/Z$/.test(d)) throw new Error(name + ': a path is left open');
			// Commands, coordinates and separators. eE and + are in there because
			// a couple of these carry a coordinate in scientific notation, which
			// is a number SVG accepts and Figma evidently exports.
			if (/[^MmLlHhVvCcSsQqTtAaZzeE0-9.+\-, ]/.test(d)) {
				throw new Error(name + ': path data holds something that is not path data');
			}
		}
	}
	// An unknown name is a box of the right size and nothing in it, which is
	// what keeps a renamed icon from shifting the labels around it.
	const blank = icons.svg('no-such-icon');
	if (blank.getAttribute('viewBox') !== '0 0 16 16') throw new Error('blank has no box');
	if (blank.children.length) throw new Error('blank drew something');
});

// --- localised filter keywords ----------------------------------------------

/** ZGFilters with a locale's real .ftl behind its translator, which is the
 *  arrangement on the page: chrome hands over the source, graph.js installs t(). */
function filtersIn(code) {
	const F = loadFilters();
	const bundle = Ftl.bundle(readLocale(code), code, PREFIX);
	F.setTranslator((id, args) => bundle.t(id, args));
	return F;
}

const FACETS = ['author', 'year', 'tag', 'type', 'publication', 'collection', 'cluster', 'title'];

check('the facet list the .ftl is checked against is the one in the source', () => {
	// referencedIds() writes the facets out by hand, because they are assembled
	// from values at runtime and cannot be found by reading the source. That
	// list going stale would quietly drop a whole facet's two messages out of
	// the check that they exist at all.
	const src = fs.readFileSync(path.join(addonDir, 'content/nodeFilters.js'), 'utf8');
	const table = src.match(/var FIELDS = \[([\s\S]*?)\];/);
	if (!table) throw new Error('could not find FIELDS in nodeFilters.js');
	const real = [...table[1].matchAll(/name: '([^']+)'/g)].map(m => m[1]).sort();
	const scanned = [...referencedIds()]
		.filter(id => id.startsWith('fieldkey-'))
		.map(id => id.slice('fieldkey-'.length))
		.sort();
	if (JSON.stringify(real) !== JSON.stringify(scanned)) {
		throw new Error('FIELDS ' + JSON.stringify(real) + ' vs scanned ' + JSON.stringify(scanned));
	}
	if (JSON.stringify(real) !== JSON.stringify([...FACETS].sort())) {
		throw new Error('FIELDS ' + JSON.stringify(real) + ' vs this file ' + JSON.stringify(FACETS));
	}
});

check('a keyword is one parseable word, and no two facets claim the same one', () => {
	for (const code of fs.readdirSync(localeDir)) {
		if (!fs.existsSync(path.join(localeDir, code, FTL_NAME))) continue;
		const bundle = Ftl.bundle(readLocale(code), code, PREFIX);
		const seen = new Map();
		for (const f of FACETS) {
			const key = bundle.t('fieldkey-' + f);
			// Everything up to the first colon is the field name, so a keyword
			// with a space or a colon in it authors a mask nothing can read back.
			if (!/^[^\s:]+$/.test(key)) throw new Error(code + '/' + f + ': ' + JSON.stringify(key));
			// Case is the locale's to choose -- German capitalises its nouns --
			// so every comparison from here down folds it, exactly as the box
			// does when it reads what was typed.
			const fold = key.toLowerCase();
			if (seen.has(fold)) {
				throw new Error(code + ': ' + key + ' is both ' + seen.get(fold) + ' and ' + f);
			}
			seen.set(fold, f);
			// A keyword that is some other facet's own name would be unreachable:
			// the names stay accepted in every locale, and they are matched first.
			if (fold !== f && FACETS.includes(fold)) {
				throw new Error(code + '/' + f + ": " + key + " is another facet's own name");
			}
		}
	}
});

check('a translated keyword scopes the box, and the English one still does', () => {
	const F = filtersIn('de-DE');
	// The German panel says "Autor" on the chip and offers "autor:" in the
	// completion list, so "autor:" is what a German user types. It used to parse
	// as a bare substring search for the literal text "autor: Kucsko", which
	// matched nothing and said nothing about why.
	const de = F.parse('autor: Kucsko');
	if (!de || de.field !== 'author') throw new Error('autor: -> ' + JSON.stringify(de));
	// Resolved to the facet's own name and not the German word: facets() keys on
	// that name, so no locale may reach past here.
	if (F.parse('teilgebiet: x').field !== 'cluster') throw new Error('teilgebiet:');
	if (F.parse('art: book').field !== 'type') throw new Error('art:');
	if (F.parse('schlagwort: x').field !== 'tag') throw new Error('schlagwort:');
	// And the English keywords keep working, so a mask written under one
	// language still opens under another.
	if (F.parse('author: Kucsko').field !== 'author') throw new Error('author: stopped working');
	// A prefix that is neither is still a search term, not a syntax error.
	if (F.parse('10.1038:x').field !== null) throw new Error('invented a field for a DOI');
});

check('a chip round-trips through the box in the language it is shown in', () => {
	const F = filtersIn('de-DE');
	// Chips go back into the box as text, so toInput() writing the keyword the
	// user was offered and parse() reading it back have to be exact inverses --
	// otherwise clicking a chip to edit it would unscope the mask on the way in.
	for (const text of ['autor: soc', 'jahr: 2013, 1990-2000', 'art: "book"', 'sammlung: "Quantum"']) {
		const f = F.parse(text);
		if (!f) throw new Error('did not parse: ' + text);
		const back = F.parse(F.toInput(f));
		if (!back || F.key(back) !== F.key(f)) {
			throw new Error(text + ' -> ' + F.toInput(f) + ' -> ' + JSON.stringify(back));
		}
	}
	// An English mask is normalised to the keyword the panel shows, rather than
	// being handed back in a vocabulary this panel does not use anywhere else --
	// capitalised the way German capitalises a noun, which is the way the
	// completion list offered it.
	if (F.toInput(F.parse('author: soc')) !== 'Autor: soc') {
		throw new Error(F.toInput(F.parse('author: soc')));
	}
	// And a keyword typed in any case at all still comes back the one way.
	for (const typed of ['Autor: soc', 'autor: soc', 'AUTOR: soc']) {
		if (F.toInput(F.parse(typed)) !== 'Autor: soc') throw new Error(typed + ' -> ' + F.toInput(F.parse(typed)));
	}
	// Picking a value writes the keyword too, and what it leaves in the box parses.
	const box = F.spliceTerm('publikation:', 'publication', '"Nature"');
	if (box !== 'Publikation: "Nature", ') throw new Error(JSON.stringify(box));
	if (F.parse(box).field !== 'publication') throw new Error('the spliced box does not parse back');
});

check('the completion list offers the keyword it will insert', () => {
	const F = filtersIn('de-DE');
	const lib = library(F);
	const fields = F.suggest('', lib).filter(s => s.kind === 'field');
	if (fields.length !== FACETS.length) throw new Error('offered ' + fields.length + ' field rows');
	for (const row of fields) {
		if (row.label !== row.insert.trim()) throw new Error(row.label + ' inserts ' + row.insert);
		// A row has to leave the box scoped to something, or taking it would
		// turn the next thing typed into a bare substring search.
		const after = F.parse(row.insert + 'x');
		if (!after || after.field === null) throw new Error(row.label + ' does not scope the box');
	}
	// Capitalised, because German capitalises its nouns and this row is the one
	// place the keyword is ever shown.
	if (!fields.some(r => r.label === 'Autor:')) {
		throw new Error('offered ' + fields.map(r => r.label).join(' ') + ', not Autor:');
	}
	// Typing towards a row narrows to it: the text is matched against the
	// keyword on the row, not against a facet name that is nowhere on screen --
	// and case-folded, since nobody reaches for shift to find a filter.
	for (const typed of ['jah', 'Jah', 'JAH']) {
		const got = F.suggest(typed, lib).filter(s => s.kind === 'field').map(r => r.label);
		if (got.join() !== 'Jahr:') throw new Error('typing "' + typed + '" offered ' + JSON.stringify(got));
	}
	if (F.suggest('year', lib).some(s => s.kind === 'field' && s.label === 'jahr:')) {
		throw new Error('an English name still narrows the German list');
	}
});

check('with no translator a keyword is the facet name, so the rest of these hold', () => {
	// nodeFilters.js is pure and runs under Node with no bundle behind it. Every
	// other filter check in this file leans on that giving the English
	// vocabulary back unchanged.
	const F = loadFilters();
	for (const f of FACETS) {
		if (F.fieldKey(f) !== f) throw new Error(f + ' -> ' + F.fieldKey(f));
		if (F.fieldFor(f) !== f) throw new Error('fieldFor(' + f + ') -> ' + F.fieldFor(f));
	}
	if (F.fieldFor('nonsense') !== null) throw new Error('invented a field');
	if (F.toInput(F.parse('author: soc')) !== 'author: soc') throw new Error('the English round trip moved');
});

Promise.all(pending).then(() => {
	console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
	process.exit(failures ? 1 : 0);
});
