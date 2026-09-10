/**
 * Synthetic collections for the benchmark, in the exact wire shape chrome
 * sends -- see zgSetData() in ../graph.js.
 *
 * A generated collection rather than a captured one, for two reasons. A real
 * library is somebody's, and a benchmark that only runs where that library is
 * installed is a benchmark nobody runs. And a generated one can be asked for
 * five hundred items or fifty thousand on the same distribution, which is what
 * turns "is this slow" into "where does it stop being fast".
 *
 * The shape matters more than the size. Citation counts are heavy-tailed and
 * edges are preferentially attached, so a few papers are large, central and
 * named early, and most are specks on the rim -- which is the shape every part
 * of the renderer is tuned against. Uniform random degrees would make the
 * layout, the label pass and the collision force all look easier than they are.
 *
 * Published as a global; loaded by bench.html as a plain <script>, and by
 * tools/test-cjs-shim.js through a vm context, so it must not touch the DOM.
 */
(function (global) {
	'use strict';

	/* Mulberry32. Small, and good enough for positions and degrees nobody is
	 * doing statistics on -- what is required is that the same seed gives the
	 * same collection, so an A/B compares two builds and not two dice rolls. */
	function rng(seed) {
		var a = seed >>> 0;
		return function () {
			a = (a + 0x6D2B79F5) >>> 0;
			var t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	var SURNAMES = ['Smith', 'Kucsko', 'Nakamura', 'Ivanov', 'Okafor', 'Dubois',
		'vanDerBerg', 'Schmidt', 'Rossi', 'Tanaka', 'Lindqvist', 'Ferreira',
		'OConnell', 'Bhattacharya', 'Weiss', 'Almeida', 'Novak', 'Haddad',
		'Yilmaz', 'Kowalski', 'Andersen', 'Mwangi', 'Petrov', 'Silva'];

	var WORDS = ['coherence', 'spin', 'lattice', 'diamond', 'nitrogen', 'vacancy',
		'quantum', 'sensing', 'magnetometry', 'nanoscale', 'thermometry',
		'relaxation', 'ensemble', 'readout', 'photonic', 'defect', 'centre',
		'microscopy', 'imaging', 'protocol', 'limit', 'noise'];

	var VIA = ['pdf-links', 'text-doi', 'ref-section', 'title-match'];
	var TYPES = ['journalArticle', 'preprint', 'conferencePaper', 'bookSection'];

	/** An 8-character Zotero-style key, stable for a given index. */
	function keyFor(i) {
		var s = '';
		var n = i + 1;
		for (var j = 0; j < 8; j++) {
			s += 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789'[(n * (j + 7) * 2654435761) % 33];
			n = Math.floor(n / 3) + 17;
		}
		return s;
	}

	function pick(r, list) { return list[Math.floor(r() * list.length)]; }

	function title(r) {
		var n = 4 + Math.floor(r() * 6);
		var out = [];
		for (var i = 0; i < n; i++) out.push(pick(r, WORDS));
		return out.join(' ').replace(/^./, function (c) { return c.toUpperCase(); });
	}

	/**
	 * A collection of `n` items with `edgeRatio` edges per item.
	 *
	 * Edges attach preferentially: a paper already cited is likelier to be
	 * cited again, which is what produces the handful of hubs the layout has to
	 * arrange around and the label pass has to rank. `external` adds works the
	 * collection cites but does not hold -- the ghosts -- as a fraction of n.
	 *
	 * @param {object} o  {n, seed, edgeRatio, external, enriched}
	 */
	function collection(o) {
		o = o || {};
		var n = o.n || 2000;
		var r = rng(o.seed == null ? 7 : o.seed);
		var edgeRatio = o.edgeRatio == null ? 1.4 : o.edgeRatio;
		var externalFrac = o.external == null ? 0.12 : o.external;
		var enriched = o.enriched !== false;

		var items = [];
		for (var i = 0; i < n; i++) {
			var y = 1975 + Math.floor(Math.pow(r(), 0.6) * 50);
			items.push({
				key: keyFor(i),
				itemID: i + 1,
				itemType: pick(r, TYPES),
				title: title(r),
				creators: [pick(r, SURNAMES)],
				date: String(y),
				doi: r() < 0.8 ? '10.' + (1000 + (i % 9000)) + '/x' + i : null,
				url: null,
				publication: pick(r, WORDS) + ' letters',
				collections: [],
				// Heavy-tailed, and only present when "query node metadata" would have
				// filled it in -- an un-enriched graph has no global counts at
				// all, and the size-by-global path must be measurable both ways.
				citedByGlobal: enriched
					? Math.floor(Math.pow(r(), 5) * 40000)
					: undefined,
			});
		}

		// Preferential attachment over a running tally of who has been cited.
		var pop = [];
		for (var s = 0; s < n; s++) pop.push(s);
		var edges = [];
		var seen = Object.create(null);
		var want = Math.round(n * edgeRatio);
		for (var e = 0; e < want; e++) {
			var from = Math.floor(r() * n);
			var to = pop[Math.floor(r() * pop.length)];
			if (to === from) continue;
			var id = from + '>' + to;
			if (seen[id]) continue;
			seen[id] = 1;
			pop.push(to);
			var via = [pick(r, VIA)];
			if (r() < 0.25) {
				var second = pick(r, VIA);
				if (second !== via[0]) via.push(second);
			}
			edges.push({
				from: items[from].key,
				to: items[to].key,
				// Bimodal: a DOI the typesetter embedded, or a title match that
				// was inferred. The renderer prices and colours the two
				// differently, and a single confidence would skip that path.
				confidence: r() < 0.55 ? 0.9 + r() * 0.1 : 0.4 + r() * 0.4,
				via: via,
				evidence: [],
				doi: r() < 0.5 ? items[to].doi : null,
			});
		}

		var external = [];
		var extCount = Math.round(n * externalFrac);
		for (var x = 0; x < extCount; x++) {
			var xid = 'doi:10.' + (5000 + x) + '/out' + x;
			var cites = 1 + Math.floor(Math.pow(r(), 3) * 12);
			external.push({
				id: xid,
				title: enriched && r() < 0.6 ? title(r) : null,
				creators: enriched && r() < 0.6 ? [pick(r, SURNAMES)] : [],
				year: enriched ? 1975 + Math.floor(r() * 50) : null,
				citedByGlobal: enriched ? Math.floor(Math.pow(r(), 4) * 20000) : null,
				citedBy: cites,
			});
			for (var c = 0; c < cites; c++) {
				edges.push({
					from: items[Math.floor(r() * n)].key,
					to: xid,
					confidence: r() < 0.7 ? 0.95 : 0.5,
					via: [pick(r, VIA)],
					evidence: [],
					doi: null,
				});
			}
		}

		return {
			items: items,
			edges: edges,
			external: external,
			meta: { phase: 'done' },
			options: { recursive: false, includeExternal: true, enrich: enriched },
		};
	}

	/**
	 * `base` with `count` more items grafted on, each citing something already
	 * there -- what a build phase landing or an "add to Zotero" produces.
	 *
	 * The existing items are reused by reference: the point of the scenario is
	 * what the renderer does with a changed payload, and rebuilding the
	 * unchanged nine-tenths of it would time the fixture instead.
	 */
	function grow(base, count, seed) {
		var r = rng(seed == null ? 99 : seed);
		var items = base.items.slice();
		var edges = base.edges.slice();
		var start = base.items.length;
		for (var i = 0; i < count; i++) {
			var y = 1975 + Math.floor(r() * 50);
			var key = keyFor(start + i);
			items.push({
				key: key, itemID: start + i + 1, itemType: pick(r, TYPES),
				title: title(r), creators: [pick(r, SURNAMES)], date: String(y),
				doi: '10.' + (1000 + start + i) + '/new' + i, url: null,
				publication: pick(r, WORDS) + ' letters', collections: [],
				citedByGlobal: Math.floor(Math.pow(r(), 5) * 40000),
			});
			var links = 1 + Math.floor(r() * 3);
			for (var e = 0; e < links; e++) {
				edges.push({
					from: key,
					to: base.items[Math.floor(r() * base.items.length)].key,
					confidence: 0.9 + r() * 0.1,
					via: [pick(r, VIA)], evidence: [], doi: null,
				});
			}
		}
		return {
			items: items, edges: edges, external: base.external,
			meta: { phase: 'done' }, options: base.options,
		};
	}

	global.ZGFixture = { collection: collection, grow: grow, rng: rng };
}(typeof window !== 'undefined' ? window : globalThis));
