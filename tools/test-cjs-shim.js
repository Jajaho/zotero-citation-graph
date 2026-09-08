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
	if (typeof r.open !== 'function' || typeof r.close !== 'function') {
		throw new Error('readerPane must expose open()/close()');
	}
	const i = require_('./lib/itemPane.js');
	if (typeof i.show !== 'function' || typeof i.close !== 'function') {
		throw new Error('itemPane must expose show()/close()');
	}
});

/**
 * A XUL document just real enough for itemPane.ensurePane(): the element is
 * built and wired the way core's contextPane builds its own, and the stub
 * records what it was handed.
 */
function fakeXulDoc(onRender) {
	const made = [];
	const element = (localName) => {
		const el = {
			localName,
			children: [],
			attrs: {},
			className: '',
			setAttribute: (k, v) => {
				el.attrs[k] = v;
			},
			appendChild: (c) => {
				el.children.push(c);
				return c;
			},
			insertBefore: (c) => {
				el.children.push(c);
				return c;
			},
			addEventListener: () => {},
			remove: () => {
				el.removed = true;
			},
			getBoundingClientRect: () => ({ width: 400 }),
		};
		if (localName === 'item-details') el.render = () => onRender(el);
		made.push(el);
		return el;
	};
	return {
		made,
		document: { createElement: element, createXULElement: element },
	};
}

check('the item pane is handed what <item-details> needs, and nothing more', async () => {
	const itemPane = require_('./lib/itemPane.js');
	const doc = fakeXulDoc(async () => {});
	const entry = { win: { document: doc.document }, split: doc.document.createXULElement('hbox'), tabID: 'tab-7' };
	// Set immediately before the call: show() reads Zotero.Items synchronously,
	// and the checks in this file share one Zotero stub.
	Zotero.Items = { getAsync: async id => ({ id, libraryID: 1, parentItem: false, deleted: false }) };
	Zotero.Libraries = { get: () => ({ editable: true }) };
	Zotero.Prefs = { get: () => 400, set: () => {} };
	await itemPane.show(entry, 11);

	const details = doc.made.find(el => el.localName === 'item-details');
	const sidenav = doc.made.find(el => el.localName === 'item-pane-sidenav');
	if (!details || !sidenav) throw new Error('no item pane was built');
	// The three properties contextPane.js sets on its own item-details. Without
	// tabID the pane renders in a tab nobody is looking at; without a sidenav
	// ItemDetails throws the first time it updates one; and tabType decides
	// which of core's library-only branches are taken.
	if (details.tabID !== 'tab-7') throw new Error('tabID: ' + details.tabID);
	if (details.tabType !== 'graph') throw new Error('tabType: ' + details.tabType);
	if (details.sidenav !== sidenav) throw new Error('the sidenav was not attached');
	if (details.item.id !== 11) throw new Error('the item never arrived');
	if (details.editable !== true) throw new Error('an editable library came out read-only');

	itemPane.close(entry);
	if (entry.itemPane) throw new Error('close() left the pane on the tab');
	if (!details.removed && !doc.made.some(el => el.className === 'zg-item-pane' && el.removed)) {
		throw new Error('close() left the pane in the DOM');
	}
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
	const doc = fakeXulDoc(async (el) => {
		drawn.push(el.item.id);
		await held;
	});
	const entry = { win: { document: doc.document }, split: doc.document.createXULElement('hbox'), tabID: 'tab-8' };
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
 * found by reading the source and are listed here instead.
 */
function referencedIds() {
	const ids = new Set();
	const files = [
		'content/graph.js', 'content/nodeFilters.js',
		'lib/graphTab.js', 'lib/readerPane.js', 'lib/itemPane.js', 'lib/main.js',
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
	for (const mode of ['year', 'collection', 'author', 'publication', 'type']) {
		ids.add('color-by-' + mode);
	}
	for (const f of ['author', 'year', 'tag', 'type', 'publication', 'collection', 'title']) {
		ids.add('field-' + f);
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

Promise.all(pending).then(() => {
	console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
	process.exit(failures ? 1 : 0);
});
