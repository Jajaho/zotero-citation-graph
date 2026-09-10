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

/**
 * chrome://zotero/content/elements/utils/collapsiblePane.mjs, transcribed.
 *
 * splitPane.js does not implement collapsing -- it calls core's helpers, which
 * write the `collapsed` attribute on the pane and `state`/`substate` on the
 * splitter before it. Stubbing them out would leave nothing to check, so this
 * is core's implementation, and what the checks below assert is that the
 * attributes it wrote are the ones core's stylesheet is written against.
 */
const collapsiblePane = {
	isPaneCollapsed(pane) {
		let parent = pane.closest('splitter:not([hidden="true"]) + *');
		if (!parent) return false;
		return parent.getAttribute('collapsed') === 'true';
	},
	setPaneCollapsed(pane, collapsed) {
		let parent = pane.closest('splitter:not([hidden="true"]) + *');
		if (!parent) return;
		let splitter = parent.previousElementSibling;
		if (collapsed) {
			parent.setAttribute('collapsed', 'true');
			parent.removeAttribute('width');
			parent.removeAttribute('height');
			splitter.setAttribute('state', 'collapsed');
			splitter.setAttribute('substate', 'after');
		}
		else {
			parent.removeAttribute('collapsed');
			splitter.setAttribute('state', '');
			splitter.setAttribute('substate', 'after');
		}
	},
};

const ChromeUtils = {
	importESModule(url) {
		if (url === 'chrome://zotero/content/elements/utils/collapsiblePane.mjs') {
			return collapsiblePane;
		}
		throw new Error('no such module: ' + url);
	},
};

// Every line lib/trace.js has put on disk, in order. Empty is the answer a
// profile nobody is debugging should be getting.
const traceWrites = [];

const require_ = shim.makeRequire(rootURI, {
	Services, URL, console,
	Zotero, ChromeUtils,
	IOUtils: {
		exists: async () => false,
		read: async () => new Uint8Array(),
		stat: async () => ({ size: 0, lastModified: 0 }),
		readJSON: async () => { throw new Error('no cache'); },
		writeJSON: async () => {},
		makeDirectory: async () => {},
		// lib/trace.js's own file, which is the one thing here that is written
		// for its own sake. Recorded rather than written, so a check can ask
		// what the trail actually cost.
		readUTF8: async () => { throw new Error('no log yet'); },
		writeUTF8: async (p, text) => {
			traceWrites.push(text);
		},
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

// --- label placement (content/labelLayout.js) -------------------------------

/** Evaluate the content-page script the same way the browser does. */
function loadLabels() {
	const src = fs.readFileSync(path.join(addonDir, 'content/labelLayout.js'), 'utf8');
	// Empty for the reason loadScale()'s is: the file falls back to globalThis
	// when `window` is absent, and inside a vm context that IS the context.
	const ctx = {};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'labelLayout.js' });
	if (!ctx.ZGLabels) throw new Error('labelLayout.js did not publish ZGLabels');
	return ctx.ZGLabels;
}

/** A pass over boxes centred on points, offered in the given order. Returns the
 *  labels that got their room, which is the whole observable behaviour. */
function place(L, items, opts) {
	opts = opts || {};
	const p = L.pass();
	p.begin(opts.cell || 40, opts.cap || 1000, 0, 0);
	const shown = [];
	for (const it of items) {
		const hw = it.w / 2, hh = it.h / 2;
		if (p.offer(it.x - hw, it.y - hh, it.x + hw, it.y + hh)) shown.push(it.id);
	}
	return shown;
}

check('the most important name always gets its room', () => {
	const L = loadLabels();
	// Ten labels stacked on one point: only the first offered can possibly fit,
	// and which one that is must be the ranking's answer, not the geometry's.
	const at = [];
	for (let i = 0; i < 10; i++) at.push({ id: i, x: 100, y: 100, w: 60, h: 16 });
	const shown = place(L, at);
	if (shown.length !== 1 || shown[0] !== 0) throw new Error('kept ' + JSON.stringify(shown));
});

check('a low-ranked node alone in empty space keeps its name', () => {
	const L = loadLabels();
	// The property that makes this readable rather than merely sparse: crowding
	// is local, so a lone node is not punished for the pile-up across the page.
	const at = [
		{ id: 'big', x: 0, y: 0, w: 60, h: 16 },
		{ id: 'crowd', x: 4, y: 0, w: 60, h: 16 },
		{ id: 'lonely', x: 900, y: 700, w: 60, h: 16 },
	];
	const shown = place(L, at);
	if (shown.indexOf('crowd') !== -1) throw new Error('an overlapping name was kept');
	if (shown.indexOf('lonely') === -1) throw new Error('an isolated name was dropped');
});

check('the ranking is total, so two renders of one graph agree', () => {
	const L = loadLabels();
	// Ties broken by input order rather than left to the sort. Without that,
	// a graph where many nodes share a radius reshuffles which names show
	// between renders -- a flicker with no cause the user can see.
	const nodes = [];
	for (let i = 0; i < 50; i++) nodes.push({ id: i, r: 5, deg: 1 });
	const keys = n => [n.r, n.deg];
	const a = L.order(nodes, keys).map(n => n.id);
	const b = L.order(nodes, keys).map(n => n.id);
	if (a.join() !== b.join()) throw new Error('same input ranked two ways');
	if (a.join() !== nodes.map(n => n.id).join()) throw new Error('ties did not hold input order');

	// And the keys are compared in turn, descending, rather than summed.
	const mixed = [
		{ id: 'small-hub', r: 1, deg: 99 },
		{ id: 'landmark', r: 9, deg: 0 },
		{ id: 'both', r: 9, deg: 3 },
	];
	const got = L.order(mixed, keys).map(n => n.id);
	if (got.join() !== 'both,landmark,small-hub') throw new Error(got.join());
});

check('names go to what this collection cites, not to what the world cites', () => {
	const L = loadLabels();
	// graph.js ranks by [inDeg, radius]. With the panel sizing by global
	// citations, radius says how often the LITERATURE cites a paper -- so
	// ranking by size would hand the names to famous papers nobody here cites,
	// over the ones this library is actually built around.
	const key = n => [n.inDeg || 0, n.r];
	const nodes = [
		{ id: 'famous-elsewhere', inDeg: 1, r: 28 },   // 41k citations, cited here once
		{ id: 'local-backbone', inDeg: 12, r: 5 },     // barely cited outside, central here
		{ id: 'local-second', inDeg: 12, r: 3 },       // as central, drawn smaller
	];
	const got = L.order(nodes, key).map(n => n.id);
	if (got[0] !== 'local-backbone') throw new Error('the collection lost to the literature: ' + got.join());
	// Size still breaks a tie between two equally-cited papers.
	if (got[1] !== 'local-second') throw new Error(got.join());
});

check('pulling back thins the names instead of reshuffling them', () => {
	const L = loadLabels();
	// The reason the order must not depend on position or zoom: pulling back
	// has to THIN the names, from the bottom of the ranking upward, rather than
	// trade one for another. A position-dependent ranking churns the whole set
	// on every zoom step, which is the failure this design exists to avoid.
	//
	// Not a strict subset at every step, and deliberately not asserted as one:
	// greedy placement is not monotone under zoom-out. A name CAN come back
	// when whatever was blocking it is itself dropped -- below, 3 is blocked by
	// 2 until 2 loses to 0, and then 3 fits. That is why drawLabel fades rather
	// than switches; arriving gently is what makes it read as the picture
	// breathing rather than as a flash. What must hold is that the set only
	// gets smaller, and that the top of the ranking never loses.
	const spread = [];
	for (let i = 0; i < 40; i++) spread.push({ id: i, x: i * 30, y: (i % 5) * 30 });
	let last = Infinity;
	for (const zoom of [1, 0.8, 0.6, 0.45, 0.3, 0.2]) {
		const at = spread.map(n => ({ id: n.id, x: n.x * zoom, y: n.y * zoom, w: 50, h: 14 }));
		const shown = place(L, at, { cell: 50 * zoom });
		if (shown.length > last) {
			throw new Error('zoom ' + zoom + ' showed MORE names: ' + last + ' -> ' + shown.length);
		}
		// The one name the whole feature promises to keep.
		if (shown[0] !== 0) throw new Error('zoom ' + zoom + ' dropped the top-ranked name');
		last = shown.length;
	}
	if (last >= 40) throw new Error('the fixture never actually crowded');
});

check('a box too big to grid is still tested against everything', () => {
	const L = loadLabels();
	// The MAX_CELLS escape hatch is a performance shortcut on a correctness
	// path: a node circle at a deep zoom spans hundreds of cells and goes on a
	// linear list instead. If that list is ever skipped, the biggest node on
	// screen silently stops blocking anything.
	const p = L.pass();
	p.begin(1, 1000, 0, 0);
	if (!p.offer(0, 0, 500, 500)) throw new Error('the first box was refused');
	if (p.offer(250, 250, 260, 260)) throw new Error('a box inside the huge one was let through');
	if (!p.offer(600, 600, 610, 610)) throw new Error('a box clear of it was refused');
});

check('a pass reuses its buckets without leaking the last frame', () => {
	const L = loadLabels();
	// The generation stamp, which is what lets a frame allocate nothing. A
	// bucket left over from the previous frame must read as empty, or every
	// name would be blocked by where a name was one frame ago.
	const p = L.pass();
	p.begin(40, 1000, 0, 0);
	if (!p.offer(0, 0, 30, 12)) throw new Error('first frame refused');
	p.begin(40, 1000, 0, 0);
	if (!p.offer(0, 0, 30, 12)) throw new Error('last frame is still holding the space');
	if (p.count !== 1) throw new Error('the count carried over: ' + p.count);
});

check('the capacity ceiling never rations names on a readable graph', () => {
	const L = loadLabels();
	// It exists to stop a fifty-thousand-node graph testing candidates that
	// cannot change the answer -- not to cap what a person sees. A typical pane
	// must have room for far more names than any layout will actually pack.
	const cap = L.capacity(1200, 800, 26, 16);
	if (cap < 1000) throw new Error('a full-screen pane is capped at ' + cap + ' names');
});

check('label sizing shrinks to the node but never below the floor', () => {
	const L = loadLabels();
	const o = { min: 13, max: 28, perRadius: 0.85, fit: 1.9 };
	// Wide type on a big node: follows the radius, up to the ceiling.
	const big = L.size(100, 0.5, o);
	if (big.px !== o.max) throw new Error('a landmark was not clamped: ' + big.px);
	// A long name on a small node is shrunk toward its circle...
	const long = L.size(6, 4, o);
	if (long.px > 13.0001) throw new Error('a long name was not shrunk: ' + long.px);
	// ...but never past the floor, where it simply overhangs instead.
	if (long.px < o.min) throw new Error('shrank below the floor: ' + long.px);
	// The width the pass reserves is the width the draw will paint.
	if (Math.abs(long.w - long.px * 4) > 1e-9) throw new Error('width disagrees with size');
});

check('the benchmark fixture is a payload the renderer can actually read', () => {
	// The benchmark drives the real graph page through the real zgSetData
	// bridge, so a fixture in the wrong shape does not fail loudly -- it draws
	// an empty graph and reports excellent frame times for rendering nothing.
	// These are the fields render() reads off a payload; see content/graph.js.
	const src = fs.readFileSync(path.join(addonDir, 'content/bench/fixture.js'), 'utf8');
	const ctx = {};
	vm.createContext(ctx);
	vm.runInContext(src, ctx, { filename: 'fixture.js' });
	if (!ctx.ZGFixture) throw new Error('fixture.js did not publish ZGFixture');

	const g = ctx.ZGFixture.collection({ n: 300, seed: 3 });
	if (g.items.length !== 300) throw new Error('asked for 300 items, got ' + g.items.length);
	// Counted per population, not in total: edges to outside refs are edges
	// too, and a fixture that had lost every item-to-item citation would still
	// pass a bare length check while laying out a graph with no structure.
	const held = new Set(g.items.map(i => i.key));
	const internal = g.edges.filter(e => held.has(e.from) && held.has(e.to));
	const outward = g.edges.filter(e => !held.has(e.to));
	if (internal.length < g.items.length / 2) {
		throw new Error('only ' + internal.length + ' citations among held items');
	}
	if (!outward.length) throw new Error('no edges to outside refs — the ghost path never runs');
	if (!g.external.length) throw new Error('no outside refs — the ghost path would never run');

	const keys = new Set(g.items.map(i => i.key));
	if (keys.size !== g.items.length) throw new Error('duplicate item keys');
	for (const it of g.items) {
		for (const field of ['key', 'itemType', 'title', 'creators', 'date']) {
			if (it[field] == null) throw new Error('item is missing ' + field);
		}
		// year() parses this with a regex and shortLabel() builds the citekey
		// from it; a date it cannot read gives every node the label "?" and
		// quietly makes the label pass trivial.
		if (!/(1[89][0-9][0-9]|20[0-9][0-9])/.test(String(it.date))) {
			throw new Error('date ' + it.date + ' is not one year() can read');
		}
	}
	const ext = new Set(g.external.map(x => x.id));
	for (const e of g.edges) {
		if (!keys.has(e.from)) throw new Error('edge from an item that is not here: ' + e.from);
		if (!keys.has(e.to) && !ext.has(e.to)) throw new Error('edge to nothing: ' + e.to);
		if (!(e.confidence > 0 && e.confidence <= 1)) throw new Error('confidence ' + e.confidence);
		if (!Array.isArray(e.via) || !e.via.length) throw new Error('edge with no strategy');
	}

	// Heavy-tailed, not uniform: a few hubs is the shape the layout, the
	// collision force and the label ranking are all tuned against, and a flat
	// distribution would make every one of them look easier than it is.
	const deg = new Map();
	for (const e of g.edges) deg.set(e.to, (deg.get(e.to) || 0) + 1);
	const counts = [...deg.values()].sort((a, b) => b - a);
	if (counts[0] < counts[Math.floor(counts.length / 2)] * 4) {
		throw new Error('degrees are too flat to be a realistic collection');
	}

	// grow() is what the add-papers scenario feeds in.
	const bigger = ctx.ZGFixture.grow(g, 30, 5);
	if (bigger.items.length !== 330) throw new Error('grow() lost items');
	if (bigger.edges.length <= g.edges.length) throw new Error('grow() added no edges');
	const grown = new Set(bigger.items.map(i => i.key));
	if (grown.size !== bigger.items.length) throw new Error('grow() collided with an existing key');
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
	const i = require_('./lib/itemPane.js');
	// Closing the panel is the item pane's: it is the only thing that goes in it.
	for (const fn of ['show', 'close']) {
		if (typeof i[fn] !== 'function') throw new Error('itemPane must expose ' + fn + '()');
	}
	const s = require_('./lib/splitPane.js');
	// The whole surface, not a sample: the module's stylesheet is a template
	// literal, and one stray backtick in a CSS comment ends the string, turns the
	// rest of the file into whatever it happens to parse as, and leaves exports
	// silently missing rather than throwing.
	for (const fn of ['panel', 'collapsed', 'setCollapsed', 'close']) {
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
 * A window just real enough for splitPane.js and the item pane that builds into
 * it: elements that can be appended, detached and asked for their first child.
 */
class FakeElement {
	constructor(localName, made, onRender, doc = () => null) {
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
		// Where a XUL popup is in its life: 'closed', 'open' or 'hiding'. The
		// third is the one worth modelling -- see hidePopup().
		this.state = 'closed';
		// data-* attributes, which is how nodeMenu.js marks the rows it added
		// with the id the page will want back.
		this.dataset = {};
		if (localName === 'item-details') {
			this.render = () => onRender(this);
			// The head of the pane, which core fills through a callback handed
			// a document and an append. Batch editing is the only thing that
			// puts anything there; recorded so a check can read it back.
			this.head = [];
			this.renderCustomHead = (cb) => {
				this.head = [];
				if (cb) cb({ doc: doc(), append: (...els) => this.head.push(...els) });
			};
		}
		// Core's message pane, whose whole API is render({ l10nId, l10nArgs }).
		if (localName === 'item-message-pane') {
			this.render = (content) => {
				this.rendered = content;
			};
		}
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

	get previousElementSibling() {
		if (!this.parent) return null;
		const i = this.parent.children.indexOf(this);
		return i > 0 ? this.parent.children[i - 1] : null;
	}

	/** Only the one selector core's collapse helpers use: an element sitting
	 *  immediately after a splitter that is not hidden. */
	closest(sel) {
		if (sel !== 'splitter:not([hidden="true"]) + *') {
			throw new Error('unsupported selector: ' + sel);
		}
		for (let el = this; el; el = el.parent) {
			const prev = el.previousElementSibling;
			if (prev && prev.localName === 'splitter' && prev.getAttribute('hidden') !== 'true') {
				return el;
			}
		}
		return null;
	}

	/** Enough of one for add(), remove() and the toggle the gap list marks its
	 *  rows with. */
	get classList() {
		const names = () => String(this.className).split(/\s+/).filter(Boolean);
		const set = list => {
			this.className = list.join(' ');
		};
		const list = {
			add: (...add) => {
				const have = names();
				for (const n of add) if (!have.includes(n)) have.push(n);
				set(have);
			},
			remove: (...drop) => set(names().filter(n => !drop.includes(n))),
			contains: n => names().includes(n),
			toggle: (n, on) => {
				if (on === undefined ? list.contains(n) : !on) list.remove(n);
				else list.add(n);
			},
		};
		return list;
	}

	/**
	 * The DOM's own rule, because the gap list leans on it: assigning text
	 * replaces every child, which is how a redraw empties the list before
	 * building it again. A fake that only stored the string would leave the old
	 * rows in the tree and let a check find a row that is no longer on screen.
	 */
	get textContent() {
		return this._text || '';
	}

	set textContent(v) {
		this._text = String(v);
		for (const c of [...this.children]) c.remove();
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

	insertBefore(c, before) {
		if (c.parent) c.remove();
		c.parent = this;
		let i = this.children.indexOf(before);
		if (i < 0) this.children.push(c);
		else this.children.splice(i, 0, c);
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

	/** Enough of a selector engine for the shapes asked of it: [attr="..."],
	 *  which is how addDialog.js finds the collection the menu ticked and how
	 *  itemPane.js finds the sidenav's toggle; the same with a tag in front of
	 *  it, which is how itemPane.js reaches core's info section to pin it open
	 *  for batch editing; and a bare .class, which is how graphTab.load() asks
	 *  whether a container it is about to mount into already holds a graph. */
	querySelector(sel) {
		let match;
		const attr = /^([\w-]*)\[([\w-]+)="(.*)"\]$/.exec(sel);
		const cls = /^\.([\w-]+)$/.exec(sel);
		if (attr) {
			match = c => (!attr[1] || c.localName === attr[1])
				&& c.getAttribute(attr[2]) === attr[3];
		}
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

	/** The class half of querySelector(), for every match rather than the first.
	 *  nodeMenu.js sweeps its own rows off a popup with it. */
	querySelectorAll(sel) {
		const cls = /^\.([\w-]+)$/.exec(sel);
		if (!cls) throw new Error('unsupported selector: ' + sel);
		const out = [];
		const walk = (el) => {
			for (const c of el.children) {
				if (String(c.className).split(/\s+/).includes(cls[1])) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}

	focus() {}

	select() {}

	/** Recorded rather than acted on: what matters is that the row the pick
	 *  just marked was the one brought into view. */
	scrollIntoView(opts) {
		this.scrolledIntoView = opts || true;
	}

	// A XUL popup announces both edges of its life, and addDialog.js hangs the
	// focus on one and the answer on the other.
	openPopup() {
		this.state = 'open';
		this.fire('popupshown', { target: this });
	}

	hidePopup() {
		this.openedAt = null;
		this.state = 'hiding';
		// Gecko raises popuphidden from a runnable of its own, later than the
		// turn the hide was asked for, and what a menu's listeners do in the
		// meantime is the whole question in nodeMenu.js. `deferHide` is a check
		// saying so: the event waits to be fired by hand.
		if (this.deferHide) return;
		this.state = 'closed';
		this.fire('popuphidden', { target: this });
	}

	// Where a context menu is asked to appear, in screen coordinates. Recorded
	// rather than acted on: what matters is that it is the pointer's own spot.
	openPopupAtScreen(x, y, isContextMenu) {
		this.state = 'open';
		this.openedAt = { x, y, isContextMenu };
	}

	addEventListener(type, fn) {
		(this.listeners[type] = this.listeners[type] || []).push(fn);
	}

	removeEventListener(type, fn) {
		this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn);
	}

	/** Press whatever the panel wired up. */
	fire(type, event) {
		for (const fn of this.listeners[type] || []) fn(event);
	}

	getBoundingClientRect() {
		// Nothing once collapsed: the panel goes out of the layout entirely,
		// sidenav and all, the way the reader's context pane does. Under
		// MIN_WIDTH, which is what stops a collapse from being remembered as a
		// width.
		return { width: this.getAttribute('collapsed') === 'true' ? 0 : 400 };
	}
}

function fakeWindow(onRender = async () => {}) {
	const made = [];
	let doc;
	const element = localName => new FakeElement(localName, made, onRender, () => doc);
	doc = {
		createElement: element,
		createXULElement: element,
		// A dialog is appended to the window itself and looked up by id,
		// which is how a second one displaces the first.
		documentElement: element('window'),
		getElementById: id => made.find(el => el.id === id && !el.removed) || null,
		// Core's strings, which is how every count in the pane is worded --
		// the message, the batch-editing prompt and its head. Recorded rather
		// than formatted: what matters is which string and which count.
		l10n: {
			setAttributes(el, id, args) {
				el.l10nID = id;
				el.l10nArgs = args || null;
			},
		},
	};
	const win = {
		document: doc,
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
	return { win, split: element('hbox'), tabID, pane: null, itemPane: null };
}

check('the side panel is built once and closes with the tab', () => {
	const splitPane = require_('./lib/splitPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-9');
	Zotero.Prefs = { get: () => 420, set: () => {} };

	const box = splitPane.panel(entry);
	box.appendChild(element('hbox'));
	// Asking again is not a reason to rebuild: the item pane asks on every
	// click, and a rebuilt panel would throw away the pane inside it.
	if (splitPane.panel(entry) !== box) throw new Error('the panel was rebuilt');
	if (box.children.length !== 1) throw new Error('a second ask emptied the panel');

	const splitter = made.find(el => el.className === 'zg-pane-splitter');
	if (!splitter) throw new Error('the panel has no divider');
	if (splitter.parent !== entry.split) throw new Error('the divider is not beside the panel');
	// Every one of core's divider rules is keyed on [collapse=...] or
	// [substate=...]. A <splitter> carrying neither matches only
	// "splitter:not([orient=vertical]) { min-width: var(--draggable-size) }",
	// which is 5-8px of transparent layout width and no line at all -- a strip
	// of window between the graph and the panel, which is what shipped until a
	// chevron sitting on top of it was removed and uncovered it.
	if (splitter.getAttribute('substate') !== 'after') {
		throw new Error('the divider matches none of the rules core styles dividers with: '
			+ 'it draws no line and takes real width. substate=' + splitter.getAttribute('substate'));
	}
	// Not 'collapse': that is what nsSplitterFrame keys its own drag-to-collapse
	// off, and it writes collapsed="true" onto the panel without going through
	// this module -- a second collapse the sidenav's toggle knows nothing about.
	if (splitter.getAttribute('collapse')) {
		throw new Error('collapse= gives the splitter a collapse of its own, behind _collapsed');
	}

	splitPane.close(entry);
	if (entry.pane) throw new Error('close() left the panel on the tab');
	if (!box.removed) throw new Error('close() left the panel in the DOM');
	if (!splitter.removed) throw new Error('close() left the divider behind');
});

check('collapsing takes the whole panel away, and remembers the width', () => {
	const splitPane = require_('./lib/splitPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-11');
	Zotero.Prefs = { get: () => 400, set: () => {} };

	const box = splitPane.panel(entry);
	const splitter = made.find(el => el.className === 'zg-pane-splitter');
	const inside = box.appendChild(element('hbox'));

	splitPane.setCollapsed(entry, true);
	if (!splitPane.collapsed(entry)) throw new Error('the panel did not collapse');
	// The collapse is core's, so the state is written where core's stylesheet
	// looks for it -- not on a data- attribute of our own, which is what this
	// shipped with and what left the rules below unmatched.
	if (box.getAttribute('collapsed') !== 'true') throw new Error('the panel kept its width');
	// The one that matters for how it LOOKS: with the panel out of the layout
	// there is nothing for the splitter to sit beside, and core's own
	// [state=collapsed] rules would leave a hairline and a strip of splitter
	// down the right of a tab that is otherwise all graph. PANE_CSS overrides
	// them, and it can only do so once core's helper has written the state.
	if (splitter.getAttribute('state') !== 'collapsed') {
		throw new Error('the divider keeps drawing an edge for a panel that is no longer '
			+ 'there: state=' + splitter.getAttribute('state'));
	}
	if (splitter.getAttribute('substate') !== 'after') throw new Error('the divider lost its side');

	// This tab is the READER's shape, not the library's, and the difference is
	// exactly here. The library keeps 37px of sidenav on screen and overrides
	// XUL's visibility: collapse to do it (item-pane[collapsed=true]); the
	// reader's context pane has no such override, so the pane and the sidenav
	// inside it both go and the toolbar takes the width back. That override was
	// copied into this plugin once, and what shipped was a column of icons
	// beside a graph with no way to read it as a pane that had been put away.
	const css = fs.readFileSync(path.join(addonDir, 'lib', 'splitPane.js'), 'utf8');
	if (css.includes('.zg-pane[collapsed')) {
		throw new Error('a rule overrides the collapse for .zg-pane, which is what the '
			+ 'library does: 37px of sidenav stays behind instead of the panel going');
	}

	// Collapsed, not emptied and not hidden: collapsed is the attribute core's
	// helper writes and core's stylesheet reads, and the pane inside has to keep
	// its scroll position for the way back.
	if (box.getAttribute('hidden')) throw new Error('hidden is not the attribute core writes');
	if (inside.parent !== box) throw new Error('collapsing emptied the panel');
	// Neither an inline width nor a XUL width attribute may be left behind to
	// argue with the collapsed rule. Core's helper clears the attribute; the
	// inline width mirrored from it is ours to clear.
	if (box.style.width) throw new Error('an inline width outranks the collapsed rule: ' + box.style.width);
	if (box.getAttribute('width')) throw new Error('a width attribute survived the collapse');

	splitPane.setCollapsed(entry, false);
	if (splitPane.collapsed(entry)) throw new Error('the panel did not come back');
	// Core's helper takes the collapse off but restores no width -- an
	// <item-pane> gets its own back from handleResize() and zotero-persist,
	// neither of which a plain box has. That part is this module's.
	if (box.style.width !== '400px') throw new Error('came back at ' + box.style.width);
	if (splitter.getAttribute('state')) throw new Error('the divider stayed in its collapsed shape');
});

/**
 * The bar's item pane toggle is drawn from what chrome pushes back, and chrome
 * pushes it from one notifier rather than from each of the four gestures that
 * move the panel -- a click on a node, "what is missing", core's own Toggle Item
 * Pane in the sidenav, and the button itself. A gesture that stopped going
 * through splitPane would leave the button lit over a collapsed pane, and
 * nothing about it would throw.
 *
 * Reported on change and only on change: the item pane asks for the panel on
 * every single click, and a message per click is a message per click.
 */
check('every gesture that moves the panel reports it', () => {
	const splitPane = require_('./lib/splitPane.js');
	const { win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-12');
	Zotero.Prefs = { get: () => 400, set: () => {} };

	const seen = [];
	// Borrowed and given back: graphTab registers the real one at require time,
	// and the checks after this one would otherwise run without it.
	const was = splitPane.watch(
		e => seen.push(!e.pane ? 'gone' : (splitPane.showing(e) ? 'open' : 'shut')));
	try {
		splitPane.panel(entry);
		// The item pane asks on every click. Only the first ask opens anything.
		splitPane.panel(entry);
		splitPane.setCollapsed(entry, true);
		splitPane.setCollapsed(entry, true);
		splitPane.setCollapsed(entry, false);
		splitPane.close(entry);
	}
	finally {
		splitPane.watch(was);
	}

	if (seen.join(',') !== 'open,shut,open,gone') {
		throw new Error('the button in the top bar would be left saying something the '
			+ 'panel is not doing: ' + (seen.join(',') || 'nothing was reported at all'));
	}
});
check('the item pane is handed what <item-details> needs, and nothing more', async () => {
	const itemPane = require_('./lib/itemPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-7');
	// Set immediately before the call: show() reads Zotero.Items synchronously,
	// and the checks in this file share one Zotero stub.
	const fakeItems = {
		11: { id: 11, libraryID: 1, parentItem: false, deleted: false, isNote: () => false },
		12: { id: 12, libraryID: 1, parentItem: { id: 11 }, deleted: false, isNote: () => true },
	};
	Zotero.Items = { getAsync: async id => fakeItems[id] };
	Zotero.Libraries = { get: () => ({ editable: true }) };
	Zotero.Prefs = { get: () => 400, set: () => {} };
	await itemPane.show(entry, [11]);

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

	// The sidenav's first button is one line on top of _collapsed, and so is the
	// expand a section icon does on the way past. ItemPaneContainerBase resolves
	// that property through an enclosing <item-pane>, which there is none of
	// here, so the pane must carry its own -- an own property, shadowing core's.
	const own = Object.getOwnPropertyDescriptor(details, '_collapsed');
	if (!own || typeof own.set !== 'function') {
		throw new Error("core's toggle has nothing to drive: _collapsed is still the base class's");
	}

	details._collapsed = true;
	if (!entry.pane.box.getAttribute('collapsed')) throw new Error('the toggle did not collapse the panel');
	if (details._collapsed !== true) throw new Error('the toggle cannot read back what it wrote');

	// A click on a node while the pane is collapsed must NOT put it back --
	// collapsing it was a decision -- and must not spend a render nobody can
	// see either. It is recorded, and drawn on the way back out.
	Zotero.Items = { getAsync: async id => ({ id, libraryID: 1, parentItem: false, deleted: false, isNote: () => false }) };
	await itemPane.show(entry, [13]);
	if (!entry.pane.box.getAttribute('collapsed')) throw new Error('a click reopened a collapsed pane');
	if (details.item.id !== 11) throw new Error('a collapsed pane rendered anyway');

	details._collapsed = false;
	if (entry.pane.box.getAttribute('collapsed')) throw new Error('the toggle did not bring it back');
	// The redraw is not awaited by the setter -- core's button is not async --
	// so let it land.
	await new Promise(r => setTimeout(r, 0));
	if (details.item.id !== 13) throw new Error('coming back did not land on the paper last clicked');

	// A note is not a paper with sections: core answers a selected note with its
	// own editor, and so does this. The paper it hangs off is NOT put in front
	// of it -- that substitution is for attachments, and a note is the thing
	// being opened.
	Zotero.Items = { getAsync: async id => fakeItems[id] };
	Zotero.Libraries = { get: () => ({ editable: true }) };
	await itemPane.show(entry, [12], { expand: true });
	const note = made.find(el => el.localName === 'note-editor');
	const deck = made.find(el => el.localName === 'deck');
	if (!note) throw new Error('a note did not open an editor');
	if (note.item !== fakeItems[12]) throw new Error('the editor was handed something else');
	if (note.mode !== 'edit') throw new Error('an editable note came out read-only');
	// A deck page, not a hidden element. display: none would take the item
	// pane's box away, its sections would stop intersecting, and the observer
	// that watches them would strip every button off the sidenav -- for good,
	// because nothing puts them back until the sections render again.
	if (note.parent !== deck) throw new Error('the editor was not put in the deck');
	if (deck.selectedPanel !== note) throw new Error('the deck is not showing the note');
	if (note.hidden || details.hidden) throw new Error('a deck page was hidden as well');
	// EditorInstance closes the tab a note belongs to when the note is deleted.
	// The tab this one sits in is the graph.
	if (note.tabID !== undefined) throw new Error('a deleted note would close the graph tab');
	// Section buttons mean nothing beside an editor -- core's own rule.
	if (sidenav.defaultStatus !== true) throw new Error('the sidenav still offers sections');

	// And back to a paper, which puts the pane in front again.
	await itemPane.show(entry, [11], { expand: true });
	if (deck.selectedPanel !== details) throw new Error('the paper did not come back');
	if (sidenav.defaultStatus !== false) throw new Error('the sidenav was left greyed out');

	// An explicit request to look at something -- unlike a click on a node --
	// opens the pane that was put away, and draws what it was asked for.
	details._collapsed = true;
	await itemPane.show(entry, [12], { expand: true });
	if (entry.pane.box.getAttribute('collapsed')) throw new Error('select did not reopen the pane');
	if (note.item !== fakeItems[12]) throw new Error('the pane came back on the wrong thing');

	const box = entry.pane.box;
	const row = made.find(el => el.className === 'zg-item-row');
	itemPane.close(entry);
	if (entry.itemPane) throw new Error('close() left the pane on the tab');
	if (entry.pane) throw new Error('close() left the panel on the tab');
	// Taking the panel out of the document is the whole of the item pane's
	// cleanup: ItemDetails, the sidenav and the note editor all unregister their
	// observers from disconnectedCallback, so all three have to still be inside
	// the panel when the panel goes.
	if (details.parent !== deck) throw new Error('the pane was taken out of its deck');
	if (note.parent !== deck) throw new Error('the editor was taken out of its deck');
	if (deck.parent !== row) throw new Error('the deck was not left inside the row it was built in');
	if (row.parent !== box) throw new Error('the row was taken out of the panel before it was closed');
	if (!box.removed) throw new Error('close() left the panel in the DOM');
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
	const items = { getAsync: async id => ({ id, libraryID: 1, parentItem: false, deleted: false, isNote: () => false }) };
	Zotero.Libraries = { get: () => ({ editable: true }) };
	Zotero.Prefs = { get: () => 400, set: () => {} };

	Zotero.Items = items;
	const first = itemPane.show(entry, [1]);
	Zotero.Items = items;
	const second = itemPane.show(entry, [2]);
	Zotero.Items = items;
	const third = itemPane.show(entry, [3]);
	// Let all three past their item lookups before the held render lets go.
	await new Promise(r => setTimeout(r, 0));
	release();
	await Promise.all([first, second, third]);

	// 2 was passed over while 1 was still drawing, and drawing it would have
	// cost a full render of a pane nobody was going to look at.
	if (drawn.join(',') !== '1,3') throw new Error('drew ' + drawn.join(','));
});

/**
 * The three answers core's item pane gives a selection, given to the same three
 * selections here -- ItemPane.render(), and the strings are core's own.
 *
 * The counting one is the reason the pane is never blank: a graph with nothing
 * picked is a collection with no row selected, and the library says how many
 * rows there are rather than nothing at all.
 */
check('the pane answers a selection of none, one and several the way the library does', async () => {
	const itemPane = require_('./lib/itemPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-13');
	const paper = id => ({
		id, libraryID: 1, parentItem: false, deleted: false,
		isNote: () => false, isRegularItem: () => true,
	});
	// Every check in this file shares one Zotero stub and they run
	// interleaved, so the stubs are put back immediately before each call --
	// show() reads Zotero.Items on its first line and Zotero.Libraries on the
	// far side of an await.
	const show = (ids, inView) => {
		Zotero.Items = { getAsync: async id => paper(id) };
		Zotero.Libraries = { get: () => ({ editable: true }) };
		Zotero.Prefs = { get: () => 400, set: () => {} };
		return itemPane.show(entry, ids, { inView });
	};

	// Nothing picked, and twenty-seven nodes on screen.
	await show([], 27);
	const message = made.find(el => el.localName === 'item-message-pane');
	const deck = made.find(el => el.localName === 'deck');
	const details = made.find(el => el.localName === 'item-details');
	const sidenav = made.find(el => el.localName === 'item-pane-sidenav');
	if (!message) throw new Error('an empty selection left the pane blank');
	if (deck.selectedPanel !== message) throw new Error('the deck is not showing the message');
	if (message.rendered.l10nId !== 'item-pane-message-unselected'
		|| message.rendered.l10nArgs.count !== 27) {
		throw new Error('wrong message: ' + JSON.stringify(message.rendered));
	}
	// Section buttons mean nothing beside a count -- core's own rule, the same
	// one that greys them beside a note.
	if (sidenav.defaultStatus !== true) throw new Error('the sidenav still offers sections');
	// A filter that takes nodes off screen restates the count. Nothing else
	// about the pane has changed, so nothing else may be redrawn for it -- and
	// in particular the deck must stay where it is. The gap list is a page of
	// this same deck, and the count moves with every pixel of a slider drag, so
	// a count that took the deck would close that list and go on closing it.
	deck.selectedPanel = details;
	await show([], 4);
	if (message.rendered.l10nArgs.count !== 4) throw new Error('the count went stale under a filter');
	if (deck.selectedPanel !== details) throw new Error('a restated count took the deck');
	// But a real change of selection back to nothing does take it -- clicking
	// the canvas is how the whole graph is given back, and the pane has to say
	// so.
	await show([11], 27);
	await show([], 27);
	if (deck.selectedPanel !== message) throw new Error('clearing the selection left the paper up');

	// One picked: the paper's own sections, as it always was.
	await show([11], 27);
	if (deck.selectedPanel !== details) throw new Error('one paper did not open the item pane');
	if (details.item.id !== 11) throw new Error('the item never arrived');
	if (details.extraItems.length) throw new Error('one paper was drawn as several');
	if (details.head.length) throw new Error('a single paper was given a batch-editing head');

	// Several: the count, and the offer -- never the multi-item box unasked.
	// Editing every selected paper at once is not something to walk into by
	// clicking a second node.
	await show([11, 12, 13], 27);
	const prompt = made.find(el => String(el.className).includes('zg-batch-prompt'));
	if (!prompt) throw new Error('several papers did not raise the batch-editing offer');
	if (deck.selectedPanel !== prompt) throw new Error('the deck is not showing the offer');
	const promptMessage = prompt.querySelector('.zg-batch-prompt-message');
	if (promptMessage.l10nID !== 'item-pane-message-items-selected'
		|| promptMessage.l10nArgs.count !== 3) {
		throw new Error('the offer does not say what is selected');
	}
	if (details.extraItems.length) throw new Error('the multi-item box was filled unasked');

	// Taking the offer up: core's own multi-item pane, and a head that says so
	// with a way back out of it.
	prompt.children.find(c => c.localName === 'button').fire('command', {});
	await new Promise(r => setTimeout(r, 0));
	if (deck.selectedPanel !== details) throw new Error('the offer did not open the pane');
	if (details.item.id !== 11) throw new Error('the first paper is not the one described');
	if (details.extraItems.map(i => i.id).join(',') !== '12,13') {
		throw new Error('the rest were not handed over as extraItems');
	}
	const head = details.head.find(el => el.l10nID === 'item-pane-batch-editing-header');
	if (!head || head.l10nArgs.count !== 3) throw new Error('the head does not say what is being edited');

	// Done: back to the offer, with the same three still selected.
	details.head.find(el => el.l10nID === 'item-pane-batch-editing-done').fire('command', {});
	await new Promise(r => setTimeout(r, 0));
	if (deck.selectedPanel !== prompt) throw new Error('Done did not put the offer back');

	// And a different selection asks again rather than carrying the opt-in over
	// -- core drops it on every change of selection, for the same reason it is
	// an opt-in at all.
	prompt.children.find(c => c.localName === 'button').fire('command', {});
	await new Promise(r => setTimeout(r, 0));
	await show([11, 12], 27);
	if (deck.selectedPanel !== prompt) throw new Error('a new selection inherited the last one\'s opt-in');
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
	if (data.icon !== 'zotero-citation-graph') throw new Error('icon: ' + data.icon);
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

const CFG = { resRoot: 'zotero-citation-graph', pluginID: 'zotero-citation-graph@jajaho.dev', rootURI };
const COLLECTION = { key: 'ABCD1234', libraryID: 1, id: 7, name: 'Reading list' };

/** Zotero.Collections as restore() asks about it. */
function stubCollections(found = COLLECTION) {
	// Both forms, as Zotero.Collections has them: the sync one answers whenever
	// the library is loaded, which is the path restore actually takes.
	const lookup = (libraryID, key) => {
		if (!libraryID) throw new Error('Library ID not provided');
		return (found && found.libraryID === libraryID && found.key === key) ? found : false;
	};
	Zotero.Collections = {
		getByLibraryAndKey: lookup,
		getByLibraryAndKeyAsync: async (...a) => lookup(...a),
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
	// Anything but APP_SHUTDOWN: resource://zotero-citation-graph/ stops resolving under
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
			data: { collectionKey: 'ABCD1234', libraryID: 1, icon: 'zotero-citation-graph',
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

const t4 = check('a restore that ran before the plugin loaded is picked up at window load', async () => {
	await t3;
	const main = require_('./lib/main.js');
	const graphTab = require_('./lib/graphTab.js');
	const { win } = fakeMainWindow();
	stubCollections();
	Zotero.Prefs = { get: () => null, set: () => {} };

	// Zotero.Session's own objects, and the very ones restoreState() is handed:
	// that shared identity is what lets the hook and the late pass agree about
	// which entries are already spoken for.
	const entries = [
		{ type: 'library', title: 'My Library', data: {} },
		{ type: 'reader', title: 'A paper', data: { itemID: 5 } },
		{ type: 'graph', title: 'Reading list — Citation Graph',
			data: { collectionKey: 'ABCD1234', libraryID: 1, icon: 'zotero-citation-graph' } },
	];
	Zotero.Session = { state: { windows: [{ type: 'pane', tabs: entries }] } };
	win.Zotero_Tabs.tabHooks.restoreState.reader = async () => ({ itemID: null });

	// What the lifecycle log actually recorded: Zotero restores before the
	// plugin is loaded, so there is no graph hook, tabs.js:611 destructures the
	// default hook's undefined, and zoteroPane.js catches it around the loop.
	let threw = false;
	try {
		await win.Zotero_Tabs.restoreState(entries);
	}
	catch (e) {
		threw = true;
	}
	if (!threw) throw new Error('a missing hook is supposed to throw -- that is the bug');
	if (win.Zotero_Tabs._tabs.some(t => /^graph/.test(t.type))) {
		throw new Error('a graph tab appeared with no hook registered');
	}

	// Then the plugin loads. Only onMainWindowLoad is called -- waiting on the
	// pass IT started, rather than starting one here, is what makes this a check
	// of the wiring and not just of restoreMissing().
	main.onMainWindowLoad(win);
	await graphTab.restoreSettled();

	const back = win.Zotero_Tabs._tabs.filter(t => /^graph/.test(t.type));
	if (back.length !== 1) throw new Error('restored ' + back.length + ' graph tabs');
	if (back[0].data.collectionKey !== 'ABCD1234') throw new Error('restored the wrong collection');

	// And the hook firing late for an entry already claimed must not add a second.
	win.Zotero_Tabs.tabHooks.restoreState.graph = (tab, i) => graphTab.restore(win, tab, i);
	await win.Zotero_Tabs.restoreState(entries);
	if (win.Zotero_Tabs._tabs.filter(t => /^graph/.test(t.type)).length !== 1) {
		throw new Error('the two restore paths each added a tab');
	}
});

check('a tab whose collection is gone drops without costing the tabs after it', async () => {
	await t4;
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

check('a row of the gap list carries the canvas\'s four gestures', async () => {
	const gapsPane = require_('./lib/gapsPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-21');
	Zotero.Prefs = { get: () => 400, set: () => {} };

	let told = null;
	gapsPane.open(entry, on => {
		told = on;
	});
	const deck = made.find(el => el.localName === 'deck');
	const box = entry.itemPane.gaps.box;
	if (deck.selectedPanel !== box) throw new Error('opening did not show the list');
	if (told !== true) throw new Error('the page was never told the list was up');

	const sent = [];
	gapsPane.rows(entry, {
		rows: [
			{ key: 'doi:a', ns: 'doi', id: '10.1/a', citedBy: 3, citers: ['HELD1', 'HELD2', 'HELD3'] },
			{ key: 'doi:b', ns: 'doi', id: '10.1/b', citedBy: 2, citers: ['HELD1', 'HELD4'] },
		],
		total: 2,
	}, msg => sent.push(msg));
	const rows = box.querySelectorAll('.zg-gap-row');
	if (rows.length !== 2) throw new Error('rows drawn: ' + rows.length);

	// One click lights the row's ghost, two isolate it, and Ctrl (Cmd) on
	// either adds to what is lit rather than starting again -- the canvas's own
	// four, over the one node the row stands for. What each MEANS is the
	// page's; this end says which was made and which row made it, and nothing
	// else: the citers are the ghost's own neighbours and lighting them is what
	// isolating already does.
	rows[0].fire('click', {});
	rows[0].fire('dblclick', { ctrlKey: true });
	rows[1].fire('keydown', { key: 'Enter', preventDefault: () => {} });
	if (sent.length !== 3) throw new Error('messages: ' + JSON.stringify(sent));
	const [one, two, three] = sent;
	if (one.type !== 'gaps-focus' || one.key !== 'doi:a' || one.isolate || one.add) {
		throw new Error('a plain click: ' + JSON.stringify(one));
	}
	if ('citers' in one) throw new Error('a row is one node, not a set of them');
	if (!two.isolate || !two.add) throw new Error('Ctrl-double-click: ' + JSON.stringify(two));
	if (three.key !== 'doi:b' || three.isolate || three.add) {
		throw new Error('Enter is the click: ' + JSON.stringify(three));
	}

	// Which rows are lit is the page's answer, not this side's: it holds the
	// pick, and a ghost picked on the canvas lights its row from that end with
	// no click made in the list at all.
	gapsPane.marks(entry, { keys: ['doi:b'] });
	if (rows[0].classList.contains('lit')) throw new Error('an unlit row was marked');
	if (!rows[1].classList.contains('lit')) throw new Error('a lit row was not marked');
	// And a mark that has just appeared is scrolled to, since the row it lands
	// on can be below the fold of a list of twenty-five.
	if (!rows[1].scrolledIntoView) throw new Error('a newly marked row was left off screen');
	// A mark that was already there is not: nothing moved for the reader.
	rows[1].scrolledIntoView = null;
	gapsPane.marks(entry, { keys: ['doi:b'] });
	if (rows[1].scrolledIntoView) throw new Error('a standing mark scrolled the list again');
	// And the marks land again on the rows a redraw brings back.
	gapsPane.rows(entry, {
		rows: [{ key: 'doi:b', ns: 'doi', id: '10.1/b', citedBy: 2, citers: ['HELD1'] }],
		total: 1,
	}, () => {});
	const redrawn = box.querySelectorAll('.zg-gap-row');
	if (redrawn.length !== 1) throw new Error('a redraw left the old rows behind');
	if (!redrawn[0].classList.contains('lit')) throw new Error('the marks went out under a redraw');
});

check('nothing a selection does takes the deck out from under the gap list', async () => {
	const itemPane = require_('./lib/itemPane.js');
	const gapsPane = require_('./lib/gapsPane.js');
	const { made, win, element } = fakeWindow();
	const entry = fakeEntry(win, element, 'tab-22');
	const paper = id => ({
		id, libraryID: 1, parentItem: false, deleted: false,
		isNote: () => false, isRegularItem: () => true,
	});
	const show = (ids, opts) => {
		Zotero.Items = { getAsync: async id => paper(id) };
		Zotero.Libraries = { get: () => ({ editable: true }) };
		Zotero.Prefs = { get: () => 400, set: () => {} };
		return itemPane.show(entry, ids, opts);
	};

	Zotero.Prefs = { get: () => 400, set: () => {} };
	gapsPane.open(entry, () => {});
	const deck = made.find(el => el.localName === 'deck');
	const box = entry.itemPane.gaps.box;

	// Every gesture made while this list is up moves the selection -- a row
	// picks its ghost, the same ghost clicked on the canvas picks it from the
	// other end, empty canvas clears the pick, a rebuild restates the count --
	// and unpinned, each of them would close the list. So none of them may.
	await show([11], {});
	const details = made.find(el => el.localName === 'item-details');
	if (deck.selectedPanel !== box) throw new Error('a selected paper closed the list');
	if (details.item.id !== 11) throw new Error('the paper was not drawn behind the list');

	// Including the empty selection a click on the canvas makes, which is the
	// one that closed the list every time the graph was given back.
	await show([], 27);
	const message = made.find(el => el.localName === 'item-message-pane');
	if (deck.selectedPanel !== box) throw new Error('clearing the selection closed the list');

	// Closing the list is what the pin was holding out for, and what comes up
	// is whatever the selection last became underneath it.
	gapsPane.close(entry);
	if (deck.selectedPanel !== message) throw new Error('closing did not hand back the selection');

	// Unpinned, the deck is core's again: a selection takes it as it always did.
	await show([12], {});
	if (deck.selectedPanel !== details) throw new Error('a closed list still holds the deck');
	if (details.item.id !== 12) throw new Error('the second paper never arrived');
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
	// content/graph.css is on this list because the graph page carries copies
	// of these variables now: they are declared there rather than inherited,
	// which does not make the shorthand any less of a shorthand.
	for (const name of ['lib/splitPane.js', 'lib/itemPane.js', 'lib/gapsPane.js',
		'content/graph.css']) {
		const src = fs.readFileSync(path.join(addonDir, name), 'utf8')
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
 * A forced colour scheme has to win in BOTH directions.
 *
 * The page follows the OS through a media query, but Zotero's own
 * View > Color Scheme override is not something a content document can see --
 * chrome resolves it and pushes the answer, and the page stamps
 * data-color-scheme. That only works if every media query is guarded with
 * :not([data-color-scheme]): without the guard an OS set to dark beats a window
 * explicitly told to be light, and forcing a scheme works one way only.
 *
 * The failure is silent -- the graph simply keeps the OS's colours -- which is
 * why it is worth a test rather than a look.
 */
check('a forced colour scheme outranks the OS, in both directions', () => {
	const css = fs.readFileSync(path.join(addonDir, 'content/graph.css'), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '');

	const queries = [...css.matchAll(
		/@media\s*\(prefers-color-scheme:\s*(\w+)\)\s*\{\s*([^{]*)\{/g)];
	if (!queries.length) throw new Error('no prefers-color-scheme query at all');
	for (const [, scheme, selector] of queries) {
		if (!selector.includes(':not([data-color-scheme])')) {
			throw new Error('the ' + scheme + ' media query selects "' + selector.trim()
				+ '", which a forced scheme cannot outrank');
		}
	}

	// And every scheme the media queries define has to be reachable by name,
	// or forcing it selects nothing and the page stays light.
	for (const [, scheme] of queries) {
		if (!css.includes(':root[data-color-scheme="' + scheme + '"]')) {
			throw new Error('no :root[data-color-scheme="' + scheme + '"] rule to force ' + scheme);
		}
	}
});

/**
 * The icon table in THIRD-PARTY-NOTICES.md is a licence document, not a
 * comment: it is what says which file each shape came from, which is the whole
 * of how this plugin discharges the AGPL's attribution. It has drifted before
 * -- an icon retired from icons.js left its row behind, and the count in the
 * prose above disagreed with both.
 */
check('the icon notices name exactly the icons that ship', () => {
	const icons = new Set(loadIcons().names());
	const md = fs.readFileSync(path.join(addonDir, 'THIRD-PARTY-NOTICES.md'), 'utf8');

	const listed = new Set();
	for (const m of md.matchAll(/^\| `([\w-]+)` \| `(\d+\/universal\/[\w-]+\.svg)` \|$/gm)) {
		listed.add(m[1]);
	}

	const missing = [...icons].filter(n => !listed.has(n)).sort();
	if (missing.length) throw new Error('shipped but not attributed: ' + missing.join(', '));
	const stale = [...listed].filter(n => !icons.has(n)).sort();
	if (stale.length) throw new Error('attributed but not shipped: ' + stale.join(', '));

	// The prose says how many there are, in words, and that has to be the
	// number of rows under it.
	const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
		'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
		'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
	const said = md.match(/path data of (\w+) icons/);
	if (!said) throw new Error('the notices no longer say how many icons there are');
	if (WORDS[icons.size] !== said[1]) {
		throw new Error('the notices say ' + said[1] + ' icons; ' + icons.size + ' ship');
	}
});

/**
 * The edge of a collapsed pane is one hairline, and there are two elements that
 * could draw it: the splitter, and the sidenav's border-inline-start -- which is
 * buried between the pane content and the sidenav until that content goes
 * visibility: collapse, and is then the panel's outer edge.
 *
 * Both ways of getting this wrong have shipped. Letting both draw gave a
 * doubled, visibly darker edge than the library's. Taking core's answer to that
 * -- its [state=collapsed] rules, which park the splitter's line at the far side
 * of 8-10px of splitter -- gave a strip of nothing beside the icons, because
 * core can afford that width only as the grab handle its collapse="after"
 * markup makes it, and this splitter is deliberately not one.
 *
 * So the sidenav draws it and the splitter gets out of the way: no border, and
 * margins that cancel --draggable-size off the same variable core uses, so the
 * density bump on a collapsed splitter cancels itself too.
 */
/**
 * CSS specificity, as the cascade counts it: [ids, classes+attributes+pseudos,
 * types]. `:not(X)` contributes X's own specificity rather than any of its own,
 * which is exactly the part that was miscounted here -- so it is expanded in
 * place before counting.
 */
function specificity(sel) {
	let flat = sel;
	// :not(...) / :is(...) contribute their argument's specificity.
	while (/:(?:not|is)\(/.test(flat)) {
		flat = flat.replace(/:(?:not|is)\(([^()]*)\)/g, '$1');
	}
	const ids = (flat.match(/#[\w-]+/g) || []).length;
	const classes = (flat.match(/\.[\w-]+/g) || []).length
		+ (flat.match(/\[[^\]]*\]/g) || []).length
		+ (flat.match(/:[\w-]+/g) || []).length;
	// Type selectors: bare identifiers not preceded by . # : [ or -
	const types = (flat.replace(/\[[^\]]*\]/g, ' ').match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
	return [ids, classes, types];
}

function outranks(mine, theirs) {
	for (let i = 0; i < 3; i++) {
		if (mine[i] !== theirs[i]) return mine[i] > theirs[i];
	}
	return false;
}

/**
 * The collapse control is one control that changes documents.
 *
 * Open, it is the first .btn of core's <item-pane-sidenav>, drawn in chrome at
 * the top right of the tab. Away, the sidenav has gone with the pane and the
 * last button of the graph page's top bar stands in the same place, drawn in
 * content. Two stylesheets, no shared value, and a mismatch reads as the button
 * jumping sideways as you press it -- which is exactly what shipped, 4px left,
 * from writing the bar's padding as 8px on both ends.
 *
 * Core makes the two agree at 18px from the right-hand edge, and does it the
 * same way twice: 4px of padding plus half of a 28px button.
 *
 *   reader.css   .toolbar { padding-inline: 8px 4px }  .toolbar-button { width: 28px }
 *   zotero.css   item-pane-sidenav { padding: 6px 4px 0 }  .btn { width: 28px }
 *
 * And at 6px from the top, which is the sidenav's padding-top outright and the
 * toolbar's by arithmetic: a 28px button centred in 41px LESS ITS BORDER, which
 * is 40px, starts at 6. That subtraction is the whole of what box-sizing does
 * here -- reader.css declares border-box globally and this file does not, so a
 * 41px copied over without it is 42px tall and starts the button at 6.5, which
 * rounds down to a bar a pixel deep and an icon a pixel low. Both shipped.
 *
 * Nothing in this repository holds the second column of that table, so the
 * numbers are stated here as well as read.
 *
 * The start is core's too and is NOT the same number. Pulling it in to 4px, so
 * that the sidebar's toggle sat the same 18px from its edge as the item pane's
 * sits from the other, was tried and taken out again: a toolbar's left-hand end
 * reads as the start of a row, not as the mirror of its far end, and 8px is
 * where the rest of the application starts one.
 */
check('the collapse button does not move when it changes documents', () => {
	const css = fs.readFileSync(path.join(addonDir, 'content/graph.css'), 'utf8');

	// The declaration block of a rule, by its selector, comments stripped.
	const rule = (sel) => {
		const at = css.indexOf(sel + ' {');
		if (at < 0) throw new Error('content/graph.css no longer has a ' + sel + ' rule');
		return css.slice(at + sel.length, css.indexOf('}', at));
	};
	// The nth px number after a property name in a block.
	const px = (block, prop, nth) => {
		const at = block.indexOf(prop + ':');
		if (at < 0) throw new Error('no ' + prop + ' in ' + block.trim());
		const nums = block.slice(at + prop.length + 1, block.indexOf(';', at))
			.split(' ').filter(Boolean).map(v => parseFloat(v));
		// One value in a padding shorthand is both ends.
		const n = nth < nums.length ? nums[nth] : nums[0];
		if (!Number.isFinite(n)) throw new Error(prop + ' is not px numbers: ' + block.trim());
		return n;
	};

	// 4px + 28/2. Core's sidenav arrives at the same 18 from the same two parts.
	const SIDENAV_INSET = 4 + 28 / 2;
	const end = px(rule('#bar'), 'padding-inline', 1);
	const button = px(rule('#bar > button'), 'width', 0);
	const inset = end + button / 2;
	if (inset !== SIDENAV_INSET) {
		throw new Error('the button jumps ' + (inset - SIDENAV_INSET) + 'px sideways as the pane '
			+ 'opens: the bar puts its centre ' + inset + 'px from the edge and the sidenav it '
			+ 'hands over to puts its own at ' + SIDENAV_INSET + 'px');
	}

	// The start is core's too, and is NOT the same number -- see reader.css.
	if (px(rule('#bar'), 'padding-inline', 0) !== 8) {
		throw new Error('the sidebar toggle no longer starts where a toolbar starts');
	}

	// Vertically. 41px is core's number, but only border-box turns it into the
	// 40px of content that puts the button at the sidenav's 6px.
	const SIDENAV_TOP = 6;
	const bar = rule('#bar');
	if (!bar.includes('box-sizing: border-box')) {
		throw new Error('the bar is a pixel taller than the toolbar it was copied from: '
			+ 'reader.css declares box-sizing border-box for every element and this file '
			+ 'does not, so its 41px excludes the border-bottom instead of containing it');
	}
	const content = px(bar, 'height', 0) - 1;
	const top = (content - button) / 2;
	if (top !== SIDENAV_TOP) {
		throw new Error('the button drops ' + (top - SIDENAV_TOP) + 'px as the pane closes: '
			+ 'the bar starts it ' + top + 'px down and the sidenav it takes over from '
			+ 'starts its own at ' + SIDENAV_TOP + 'px');
	}
});
check('a collapsed panel leaves no edge and no strip', () => {
	const src = fs.readFileSync(path.join(addonDir, 'lib', 'splitPane.js'), 'utf8');
	const rule = /\n\t([^\n{]*\[state="collapsed"\][^\n{]*)\{([^}]*)\}/.exec(src);
	if (!rule) throw new Error('nothing styles the splitter of a collapsed pane');
	const selector = rule[1].trim();
	const body = rule[2].replace(/\/\*[\s\S]*?\*\//g, '');

	// The rule this one exists to beat, verbatim from Zotero's stylesheet. It
	// sets border-left and drops the negative margins, which is a hairline and
	// a protruding strip respectively -- both right for the library, where a
	// collapsed item pane leaves a sidenav for them to belong to, and both
	// wrong here, where the panel is gone and the graph runs to the edge.
	const CORE = 'splitter:not([orient=vertical])[substate=after][state=collapsed]';
	const mine = specificity(selector);
	const theirs = specificity(CORE);
	if (!outranks(mine, theirs)) {
		throw new Error('core\'s rule outranks this one, so every declaration in it is dead: '
			+ selector + ' is ' + mine.join(',') + ' against ' + theirs.join(',')
			+ '. The :not() argument counts toward the middle column, which is what was missed.');
	}

	// Core's [state=collapsed] rule sets border-left; there is no panel on the
	// far side of it any more, so the splitter must draw nothing.
	if (!/\bborder\s*:\s*0\b/.test(body)) {
		throw new Error('the splitter still draws an edge for a panel that is not there: ' + body.trim());
	}
	// And core drops the negative margins there, which is what turns
	// --draggable-size into real width. Both have to come back, and off the
	// variable rather than a number, or the density bump reopens the gap.
	for (const side of ['margin-left', 'margin-right']) {
		if (!new RegExp(side + '\\s*:').test(body)) {
			throw new Error('a collapsed splitter takes real width again: no ' + side);
		}
	}
	if (!/margin-left\s*:\s*calc\(1px - var\(--draggable-size\)\)/.test(body)) {
		throw new Error('the width is cancelled by a number, not by --draggable-size, '
			+ 'so a density change reopens the gap: ' + body.trim());
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
const FTL_NAME = 'zotero-citation-graph.ftl';
const PREFIX = 'zotero-citation-graph-';

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
		'lib/graphTab.js', 'lib/itemPane.js', 'lib/splitPane.js',
		'lib/gapsPane.js',
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
	if (!forPage.source.includes('zotero-citation-graph-rebuild')) throw new Error('empty source');
});

/**
 * The item pane's toggle is on the bar before anything has been clicked.
 *
 * It shipped hidden until the panel existed, on the reasoning that the pane
 * describes the node you clicked -- which left a freshly opened graph tab with
 * no way to ask for the pane at all, where the library tab has its item pane
 * beside the list from the start. The pane has an answer for an empty pick
 * (core's "N items in this view"), so the press means the same thing before the
 * first click as after it, and it carries the pick so that chrome can build the
 * panel from it. Three parts, and the button is useless without any one of them.
 */
check('the bar offers the item pane before a node has been clicked', () => {
	const html = fs.readFileSync(path.join(addonDir, 'content/graph.html'), 'utf8');
	const js = fs.readFileSync(path.join(addonDir, 'content/graph.js'), 'utf8');
	const chrome = fs.readFileSync(path.join(addonDir, 'lib/graphTab.js'), 'utf8');

	const button = html.match(/<button id="pane-toggle"[^>]*>/);
	if (!button) throw new Error('#pane-toggle is not in the bar at all');
	if (button[0].includes('hidden')) throw new Error('#pane-toggle starts hidden again');

	// Hidden by exactly one fact -- the panel being on screen. Whether the panel
	// had ever been built used to be the other half of it.
	const setter = js.match(/function setPaneOpen\([^)]*\) \{([^}]*)\}/);
	if (!setter) throw new Error('setPaneOpen has been renamed; this check is stale');
	if (!/elPaneToggle\.hidden = on;/.test(setter[1])) {
		throw new Error('the toggle is hidden by something other than the pane being open');
	}

	// The press carries the pick, because it may be what builds the pane.
	if (!/type: 'item-pane-toggle', itemIDs:/.test(js)) {
		throw new Error('the press does not carry the selection to build the pane from');
	}
	// And chrome builds one when there is none, rather than dropping the press.
	const handler = chrome.match(/case 'item-pane-toggle': \{[\s\S]*?\n\t\t\}/);
	if (!handler) throw new Error('no item-pane-toggle case; this check is stale');
	if (!/itemPane\.show\(/.test(handler[0])) {
		throw new Error('a press with no panel yet has nothing to build one');
	}
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
 * they are object literals built in five separate places, and the one thing
 * they all have is an icon directly above a label.
 *
 * The entries a held node gets are Zotero's own menu now, so only the outside
 * reference's two, the canvas's three, a flag's two and the three shared by
 * both node menus are built here. The last four cross to chrome as data rather
 * than being drawn on the page -- see lib/nodeMenu.js -- but they still name an
 * icon, and a name nothing can draw is as blank there as it is here.
 */
check('every menu entry names an icon that icons.js can draw', () => {
	const src = fs.readFileSync(path.join(addonDir, 'content/graph.js'), 'utf8');
	const icons = loadIcons();
	const entries = [...src.matchAll(/\n\t+(?:icon: (.*?),\r?\n\t+)?label: t\(/g)];
	if (entries.length < 10) {
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

check('a graph tab answers ZoteroPane what a tab of core’s own would', async () => {
	const tabContext = require_('./lib/tabContext.js');
	const graphTab = require_('./lib/graphTab.js');

	// Core's own answer, and the one every call outside a graph tab must keep
	// getting back untouched.
	const inLibrary = [{ id: 1, parentItem: false }];
	// The collection tree's own selection: the trash, in a library nothing may
	// be written to. Every one of the four below reads it, and none of them is
	// an answer about the graph.
	const libraryRows = [{ isTrash: () => true, editable: false, filesEditable: false }];
	let sawArgs = null;
	const pane = {
		collectionsView: { id: 'the tree' },
		getSelectedItems(asIDs, options) {
			sawArgs = { asIDs, options, self: this };
			return asIDs ? inLibrary.map(i => i.id) : inLibrary;
		},
		getCollectionTreeRows: () => libraryRows,
		getSelectedLibraryIDs: () => [99],
		getSelectedCollections: asID => (asID ? [55] : [{ id: 55 }]),
		selectItems: async (ids, options) => {
			switched.push({ ids, options });
			return true;
		},
		canEdit: () => libraryRows[0].editable,
		canEditFiles: () => libraryRows[0].filesEditable,
	};
	const original = pane.getSelectedItems;
	const coreRows = pane.getCollectionTreeRows;

	// Core's own row, with the two getters the item menu turns on.
	Zotero.CollectionTreeRow = function (view, type, ref) {
		this.view = view;
		this.type = type;
		this.ref = ref;
		this.editable = !!ref.editable;
		this.filesEditable = !!ref.filesEditable;
	};
	const collection = { id: 3, libraryID: 7, editable: true, filesEditable: true };

	// The sidenav hands buildLocateMenu a locateMode worked out from the
	// tab type. 'tab' is what a graph tab produces, and it is the value that
	// costs the menu its 'View in Tab' entry.
	let sawMode;
	const locateMenu = {
		async buildLocateMenu(menu, options) {
			sawMode = 'locateMode' in options ? options.locateMode : '(absent)';
			return menu;
		},
	};
	const coreBuild = locateMenu.buildLocateMenu;
	const win = {
		ZoteroPane: pane,
		Zotero_LocateMenu: locateMenu,
		Zotero_Tabs: { selectedType: 'library', selectedID: 'tab-1' },
	};

	const items = {
		7: { id: 7, parentItem: false },
		8: { id: 8, parentItem: { id: 9, parentItem: false } },
	};
	Zotero.Items = { get: id => items[id] || false };

	let asked = [];
	let switched = [];
	let shown = [];
	let graphSelection = [7];
	let graphCollection = collection;
	tabContext.install(win, {
		select: async (tabID, ids) => {
			shown.push({ tabID, ids });
			return true;
		},
		itemIDs: (tabID) => {
			asked.push(tabID);
			return graphSelection;
		},
		collection: () => graphCollection,
	});

	// A library tab is core's business start to finish -- same items, and the
	// arguments arrive as they were passed rather than reconstructed.
	if (pane.getSelectedItems(false, { libraryTabOnly: false }) !== inLibrary) {
		throw new Error('a library tab stopped getting its own selection');
	}
	if (sawArgs.self !== pane) throw new Error('the wrapper lost `this`');
	if (asked.length) throw new Error('a library tab asked the graph');
	locateMenu.buildLocateMenu({}, { locateMode: 'library' });
	if (sawMode !== 'library') throw new Error('a library tab lost its locateMode');
	if (pane.getCollectionTreeRows() !== libraryRows) throw new Error('a library tab lost its own rows');
	if (pane.getSelectedLibraryIDs()[0] !== 99) throw new Error('a library tab lost its own library');
	if (pane.getSelectedCollections()[0].id !== 55) throw new Error('a library tab lost its own collection');
	await pane.selectItems([1]);
	if (switched.length !== 1 || shown.length) throw new Error('a library tab stopped selecting its own rows');
	if (pane.canEdit() || pane.canEditFiles()) throw new Error('a read-only trash became editable');

	// The tab type core has no case for, which is the whole point.
	win.Zotero_Tabs.selectedType = 'graph';
	const got = pane.getSelectedItems();
	if (got.length !== 1 || got[0].id !== 7) throw new Error('the graph tab answered ' + JSON.stringify(got));
	if (asked[0] !== 'tab-1') throw new Error('asked about ' + asked[0] + ', not the selected tab');
	if (JSON.stringify(pane.getSelectedItems(true)) !== '[7]') throw new Error('asIDs was not honoured');

	// The other three questions core asks about a selected tab, and the reason
	// they matter: taken from the tree, the item menu is built for the trash,
	// files a new note in library 99, and answers "you cannot make changes to
	// the currently selected collection" to everything that writes.
	const rows = pane.getCollectionTreeRows();
	if (rows.length !== 1 || rows[0].ref !== collection || rows[0].type !== 'collection') {
		throw new Error('the graph tab answered with something other than its collection');
	}
	if (rows[0].view !== pane.collectionsView) throw new Error('the row was built without its tree');
	if (pane.getSelectedLibraryIDs()[0] !== 7) throw new Error('a note would be filed in the wrong library');
	// What "Add to Collection -> New Collection" hangs the new one under. As an
	// id or as the collection itself, the way core asks for it in both places.
	if (pane.getSelectedCollections()[0] !== collection) throw new Error('a new collection would go elsewhere');
	if (pane.getSelectedCollections(true)[0] !== 3) throw new Error('asID was not honoured');
	if (!pane.canEdit()) throw new Error('an editable collection could not be written to');
	if (!pane.canEditFiles()) throw new Error('an attachment could not be added to it');

	// "Select this item" is core showing the user something -- a note it has
	// just written, a row clicked in the pane. A graph tab has its own pane to
	// put it in, so nothing switches tabs.
	switched.length = 0;
	if (await pane.selectItems([31]) !== true) throw new Error('the graph tab refused to select');
	if (switched.length) throw new Error('the graph tab was left behind for the library');
	if (shown.length !== 1 || shown[0].ids[0] !== 31) throw new Error('the pane was not shown ' + JSON.stringify(shown));
	if (shown[0].tabID !== 'tab-1') throw new Error('shown in ' + shown[0].tabID);

	// Except "Show in Library", whose whole point is to leave the tab you are
	// in. It is the one caller that passes inLibraryRoot, and core still takes
	// it as a bare boolean.
	shown.length = 0;
	await pane.selectItems([31], true);
	if (shown.length) throw new Error('Show in Library stayed in the graph');
	if (switched.length !== 1) throw new Error('Show in Library did not reach core');
	if (switched[0].options !== true) throw new Error('core saw ' + JSON.stringify(switched[0].options));
	await pane.selectItems([31], { inLibraryRoot: true });
	if (switched.length !== 2) throw new Error('the object form was not honoured');

	// A read-only group is read-only in the graph too -- the answer is the
	// collection's, not a blanket yes.
	graphCollection = { id: 4, libraryID: 8, editable: false, filesEditable: false };
	if (pane.canEdit() || pane.canEditFiles()) throw new Error('a read-only collection said yes');
	graphCollection = collection;

	// A graph tab is not the tab already showing this PDF, so the entry that
	// opens it in one is not redundant and must not be dropped. The mode is
	// removed rather than replaced: core's own default is no mode at all, and
	// claiming to be a library tab would assert something untrue.
	locateMenu.buildLocateMenu({}, { locateMode: 'tab' });
	if (sawMode !== '(absent)') throw new Error('the graph tab was still a ' + sawMode + ' context');

	// libraryTabOnly exists so a caller can ask what the LIBRARY holds while
	// another tab is on screen. Core checks it ahead of the tab type; so must this.
	if (pane.getSelectedItems(false, { libraryTabOnly: true }) !== inLibrary) {
		throw new Error('libraryTabOnly was answered by the graph');
	}

	// Locate is about the paper, not the file -- core's reader case does the
	// same substitution.
	graphSelection = [8];
	if (pane.getSelectedItems()[0].id !== 9) throw new Error('an attachment was put in front of Locate');

	// An item deleted out from under a graph that is still on screen. Dropping
	// it gives the honest "0 items selected"; passing the id on would throw
	// inside core's menu builder.
	graphSelection = [404];
	if (pane.getSelectedItems().length) throw new Error('a stale id survived');

	// A tab id with no graph behind it -- closed, or restored and never
	// selected -- is not an error, it is an empty selection and core's own
	// answer to everything else.
	if (graphTab.selectedItemIDs('tab-nothing').length) throw new Error('an unknown tab claimed a selection');
	if (graphTab.selectedCollection('tab-nothing')) throw new Error('an unknown tab claimed a collection');
	graphCollection = null;
	if (pane.getCollectionTreeRows() !== libraryRows) throw new Error('a graph with no collection invented one');
	if (pane.canEdit()) throw new Error('a graph with no collection answered for the trash');
	graphCollection = collection;

	tabContext.uninstall(win);
	if (pane.getSelectedItems !== original) throw new Error('uninstall did not give the window its own back');
	if (pane.getCollectionTreeRows !== coreRows) throw new Error('uninstall left the rows wrapped');
	if (locateMenu.buildLocateMenu !== coreBuild) throw new Error('uninstall left the menu wrapped');

	// Someone else wrapping on top owns the property now. Writing core's
	// function back over their wrapper would silently uninstall it, so ours
	// stays where it is and goes inert instead.
	tabContext.install(win, {
		itemIDs: () => [7],
		collection: () => collection,
		select: async () => true,
	});
	const ours = pane.getSelectedItems;
	let outerCalls = 0;
	pane.getSelectedItems = function (...args) {
		outerCalls++;
		return ours.apply(this, args);
	};
	tabContext.uninstall(win);
	if (pane.getSelectedItems === original) throw new Error("uninstall clobbered another plugin's wrapper");
	const after = pane.getSelectedItems();
	if (!outerCalls) throw new Error('the outer wrapper stopped being called');
	if (after !== inLibrary) throw new Error('an uninstalled wrapper still answered for the graph');
});

/**
 * A popup standing in for #zotero-itemmenu, carrying the four core entries this
 * test has anything to say about. Core builds them once into zoteroPane.xhtml
 * and addresses them by index from the front, which is why nodeMenu.js only
 * ever appends.
 */
function fakeItemMenu(element) {
	const popup = element('menupopup');
	popup.id = 'zotero-itemmenu';
	for (const cls of ['zotero-menuitem-show-in-library', 'zotero-menuitem-remove-items',
		'zotero-menuitem-move-to-trash', 'zotero-menuitem-delete-from-lib']) {
		const el = element('menuitem');
		el.className = 'menuitem-iconic ' + cls;
		popup.appendChild(el);
	}
	return popup;
}

check("a node menu is Zotero's own, with the graph's entries under it", async () => {
	const nodeMenu = require_('./lib/nodeMenu.js');
	const { win, element } = fakeWindow();
	const popup = fakeItemMenu(element);

	let built = 0;
	const pane = {
		itemsView: {},
		async buildItemContextMenu() {
			built++;
		},
	};
	win.ZoteroPane = pane;

	const collection = { id: 3, key: 'ABCD1234' };
	const said = [];
	const reply = (fn, value) => said.push(fn + (value === undefined ? '' : ':' + value));

	await nodeMenu.open({ win, collection }, {
		itemID: 7,
		x: 640,
		y: 480,
		entries: [
			{ id: 'e0', icon: 'isolate', label: 'Isolate', hint: 'dim everything but this node' },
			{ id: 'e1', icon: 'pin', label: 'Pin node here', hint: null },
		],
	}, reply);

	// Core's own builder, asked once and told nothing: which paper, which
	// collection and which library it builds for are all questions it puts to
	// ZoteroPane, and lib/tabContext.js has already answered them.
	if (built !== 1) throw new Error('core built the menu ' + built + ' times');

	// The three that end at itemsView.deleteSelection() -- the library tree's
	// selection, which a graph tab has no part in. "Move to Trash" over a node
	// must not trash whatever the library was showing.
	for (const cls of ['zotero-menuitem-remove-items', 'zotero-menuitem-move-to-trash',
		'zotero-menuitem-delete-from-lib']) {
		if (popup.querySelector('.' + cls).getAttribute('hidden') !== 'true') {
			throw new Error(cls + ' was left able to act on the library tab');
		}
	}
	if (popup.querySelector('.zotero-menuitem-show-in-library').getAttribute('hidden')) {
		throw new Error('an entry that reads the selection was taken off too');
	}

	// The graph's own entries, under a rule, at the bottom.
	const mine = popup.children.filter(c => c.classList.contains('zg-node-menuitem'));
	if (mine.length !== 3) throw new Error('added ' + mine.length + ' things, not a rule and two rows');
	if (mine[0].localName !== 'menuseparator') throw new Error('the graph entries run straight on');
	if (popup.children.slice(-3).some((c, i) => c !== mine[i])) {
		throw new Error('the graph entries are not at the bottom');
	}
	if (mine[1].getAttribute('label') !== 'Isolate') throw new Error('lost the label the page wrote');
	if (mine[1].getAttribute('tooltiptext') !== 'dim everything but this node') throw new Error('lost the hint');
	if (mine[2].getAttribute('tooltiptext')) throw new Error('invented a hint the page did not send');
	// Zotero's own file, and the two properties without which it paints as a
	// black shape in a menu that is not always light.
	if (mine[2].getAttribute('image') !== 'chrome://zotero/skin/16/universal/pin.svg') {
		throw new Error('pin drew ' + mine[2].getAttribute('image'));
	}
	if (mine[2].style.props.fill !== 'var(--fill-secondary)') throw new Error('the icon has no fill');

	if (popup.openedAt.x !== 640 || popup.openedAt.y !== 480 || !popup.openedAt.isContextMenu) {
		throw new Error('the menu did not open at the pointer as a context menu');
	}
	if (said.length) throw new Error('the page was told something while the menu was still up: ' + said);

	// Picking a row, in the order Gecko actually uses: nsXULMenuCommandEvent
	// rolls the menu chain up and dispatches the picked row's command
	// afterwards -- later than the turn the hide happened in. So the close is
	// answered at once and does not wait for a pick that may never come...
	popup.hidePopup();
	if (said.join(' ') !== 'zgMenuClosed') throw new Error('a hidden menu said ' + said.join(' '));
	// ...and by then the rows are back off Zotero's own menu, which is where a
	// listener on the POPUP loses the pick: the command bubbles into nothing.
	if (popup.querySelectorAll('.zg-node-menuitem').length) {
		throw new Error("the graph's entries were left on the library's own menu");
	}
	// The row is detached, exactly as it is when the command finally lands, and
	// it still has to be heard -- so the listener is on the row.
	mine[2].fire('command', { target: mine[2], currentTarget: mine[2] });
	if (said.join(' ') !== 'zgMenuClosed zgMenuPicked:e1') throw new Error('the page heard ' + said.join(' '));

	// The other order, which is what a platform that dispatches the command
	// before it takes the popup down would give: the pick still says the menu
	// is gone first, and the hide behind it adds nothing.
	said.length = 0;
	await nodeMenu.open({ win, collection }, {
		itemID: 7, x: 1, y: 2, entries: [{ id: 'e0', icon: 'pin', label: 'Pin node here' }],
	}, reply);
	const row = popup.children.filter(c => c.classList.contains('zg-node-menuitem')).pop();
	row.fire('command', { target: row, currentTarget: row });
	popup.hidePopup();
	if (said.join(' ') !== 'zgMenuClosed zgMenuPicked:e0') throw new Error('a pick before the hide said ' + said.join(' '));

	// Dismissed without picking anything: the hold still has to come off.
	said.length = 0;
	await nodeMenu.open({ win, collection }, { itemID: 7, x: 1, y: 2, entries: [] }, reply);
	popup.hidePopup();
	if (said.join(' ') !== 'zgMenuClosed') throw new Error('a dismissal said ' + said.join(' '));

	// No item tree, no menu -- and the page is still holding the node it
	// right-clicked, so it has to be told that nothing is coming.
	said.length = 0;
	pane.itemsView = null;
	await nodeMenu.open({ win, collection }, { itemID: 7, x: 1, y: 2, entries: [] }, reply);
	if (said.join(' ') !== 'zgMenuClosed') throw new Error('a menu that never opened said ' + said.join(' '));
	if (built !== 3) throw new Error('core was asked to build a menu with no item tree');
});

check('a menu replaced by the next one says nothing about the node it left behind', async () => {
	const nodeMenu = require_('./lib/nodeMenu.js');
	const { win, element } = fakeWindow();
	const popup = fakeItemMenu(element);
	win.ZoteroPane = { itemsView: {}, async buildItemContextMenu() {} };

	const said = [];
	const reply = (fn, value) => said.push(fn + (value === undefined ? '' : ':' + value));
	const entry = { win, collection: { id: 3, key: 'ABCD1234' } };
	const rows = [{ id: 'e0', icon: 'pin', label: 'Pin node here' }];

	// The menu over one node...
	await nodeMenu.open(entry, { itemID: 7, x: 1, y: 2, entries: rows }, reply);

	// ...and a right click on the next one while it is still up. The page has
	// asked for the first to close and the second to open, in that order, and
	// is already holding the second node against the menu it is expecting.
	popup.deferHide = true;
	const opening = nodeMenu.open(entry, { itemID: 8, x: 3, y: 4, entries: rows }, reply);
	if (popup.openedAt) throw new Error('a menu went up over a popup that was still hiding');
	if (said.length) throw new Error('the page was told something before either menu was settled: ' + said.join(' '));

	// The first menu's popuphidden, arriving the turn after it was asked for,
	// which is the only way Gecko sends one. It is the FIRST menu's news and
	// that menu is gone -- and the page hearing 'closed' now would let go of
	// the node the second one is being opened over, leaving "Pin node here" to
	// pin it wherever the layout had since carried it.
	popup.deferHide = false;
	popup.state = 'closed';
	popup.fire('popuphidden', { target: popup });
	await opening;
	if (said.length) throw new Error('a replaced menu spoke for the one that replaced it: ' + said.join(' '));

	// The menu that is actually on screen is the one the page hears about.
	if (!popup.openedAt || popup.openedAt.x !== 3) throw new Error('the replacing menu never opened');
	popup.hidePopup();
	if (said.join(' ') !== 'zgMenuClosed') throw new Error('the menu on screen said ' + said.join(' '));
	if (popup.querySelectorAll('.zg-node-menuitem').length) {
		throw new Error("the graph's entries were left on the library's own menu");
	}
});

check('the lifecycle trail costs nothing until it is switched on', async () => {
	const trace = require_('./lib/trace.js');

	// Both lines inside one synchronous run, so nothing else can put its own
	// Zotero.Prefs in between: log() asks the pref at the moment it is called,
	// and the answer to that question is meant to be the whole difference
	// between a line on disk and no line at all.
	const prefs = Zotero.Prefs;
	Zotero.Prefs = { get: () => undefined, set: () => {} };
	trace.log('trail-off-marker');
	Zotero.Prefs = { get: name => name === 'zoteroCitationGraph.trace', set: () => {} };
	trace.log('trail-on-marker');
	Zotero.Prefs = prefs;

	await trace.flush();
	if (traceWrites.some(t => t.includes('trail-off-marker'))) {
		throw new Error('a trail nobody switched on read and rewrote its file anyway');
	}
	if (!traceWrites.some(t => t.includes('trail-on-marker'))) {
		throw new Error('a trail that was switched on wrote nothing');
	}
});

Promise.all(pending).then(() => {
	console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
	process.exit(failures ? 1 : 0);
});
