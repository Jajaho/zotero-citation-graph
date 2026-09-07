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
const require_ = shim.makeRequire(rootURI, {
	Services, URL, console,
	Zotero: {
		debug: () => {},
		logError: () => {},
		Promise: { delay: ms => new Promise(r => setTimeout(r, ms)) },
		DataDirectory: { dir: addonDir },
	},
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

Promise.all(pending).then(() => {
	console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
	process.exit(failures ? 1 : 0);
});
