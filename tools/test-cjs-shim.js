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
	const ids = cg.listStrategies().map(s => s.id).sort();
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

// --- chrome-side modules ---------------------------------------------------

check('lib/ modules load through the shim', () => {
	const za = require_('./lib/zoteroAdapter.js');
	if (typeof za.ZoteroAdapter !== 'function') throw new Error('no ZoteroAdapter');
	const c = require_('./lib/pdfLinkCache.js');
	if (typeof c.PdfLinkCache !== 'function') throw new Error('no PdfLinkCache');
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

Promise.all(pending).then(() => {
	console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
	process.exit(failures ? 1 : 0);
});
