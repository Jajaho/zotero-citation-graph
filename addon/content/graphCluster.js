/**
 * Bibliographic coupling, and the communities it induces.
 *
 * The graph's edges say who cites whom. That is not the same question as which
 * papers belong together: in a library assembled from local PDFs most items
 * cite each other rarely or not at all, so a partition taken from the citation
 * edges alone would mostly report which items happened to have a readable
 * reference list. Coupling asks the other question -- how much of the
 * literature two papers point at in common -- and it works precisely where the
 * citation graph is thin, because a shared reference counts whether or not the
 * work referenced is one we hold. Outside references are the useful half of it:
 * two papers that both lean on the same three classics we do not own are doing
 * the same kind of work, and nothing in the citation graph proper says so.
 *
 * What comes out is a subfield map of the collection, derived from what the
 * papers cite rather than from how they were filed.
 *
 * Loaded as a plain <script> and published as a global; the content page has no
 * module loader. tools/test-cjs-shim.js evaluates this same file, which is the
 * point of keeping it pure -- a partition is tedious to judge by looking at a
 * coloured graph and easy to assert on a fixture whose answer is known.
 */
(function (global) {
	'use strict';

	/**
	 * A direct citation, added on top of whatever coupling the pair already has.
	 *
	 * Coupling is blind to it: A citing B does not make A and B share a
	 * reference, so on its own the measure would separate a paper from the very
	 * work it builds on. Half a unit puts a citation somewhere between "shares
	 * most of its bibliography" (cosine near 1) and "unrelated", which is about
	 * what one citation is worth as evidence.
	 */
	var DIRECT_WEIGHT = 0.5;

	/**
	 * A reference this much of the collection cites is background, not a link.
	 *
	 * Every field has a handful of works everyone cites; pairing up their citers
	 * would couple the whole library into one blob and drown the specific
	 * agreements that actually mark a subfield. The floor of 3 keeps the rule
	 * from eating a small collection alive, where half of six citing papers is
	 * an ordinary agreement rather than a universal one.
	 */
	var MAX_SHARE = 0.5;
	var MIN_CAP = 3;

	/** Louvain's resolution: higher splits finer. 1 is standard modularity. */
	var RESOLUTION = 1;

	var MAX_PASSES = 20;
	var MAX_ROUNDS = 40;
	var EPS = 1e-12;

	/** How many keywords a cluster's name is allowed to carry. */
	var LABEL_TERMS = 2;

	/** What joins them. Not a space: two keywords are two keywords, and
	 *  "quantum memory nitrogen vacancy" would read as a phrase nobody wrote. */
	var LABEL_SEP = ' / ';

	// --- coupling ---------------------------------------------------------

	/**
	 * Pairwise coupling strength over the held items, plus direct citations.
	 *
	 * @param {{from: string, to: string}[]} edges  citation edges; `to` may be a
	 *   held item or an outside reference, and both kinds count as shared.
	 * @param {Set<string>|string[]} held  keys of the items being clustered.
	 *   Only these are ever an endpoint of a returned pair -- an outside
	 *   reference is something papers agree ABOUT, not something to be placed.
	 * @param {Object} [opts] direct, maxShare
	 * @returns {{pairs: {a: string, b: string, w: number}[], refs: Map<string, Set<string>>}}
	 */
	function coupling(edges, held, opts) {
		opts = opts || {};
		var direct = opts.direct == null ? DIRECT_WEIGHT : opts.direct;
		var maxShare = opts.maxShare == null ? MAX_SHARE : opts.maxShare;
		var inSet = held instanceof Set ? held : new Set(held || []);

		var refs = new Map();    // citer -> the works it cites
		var citers = new Map();  // work -> the held items citing it
		var cites = [];          // held -> held edges, for the direct term
		for (var i = 0; i < (edges || []).length; i++) {
			var e = edges[i];
			if (!e || !e.from || !e.to || e.from === e.to) continue;
			if (!inSet.has(e.from)) continue;
			var mine = refs.get(e.from);
			if (!mine) refs.set(e.from, mine = new Set());
			// Upstream merges edges per ordered pair, but a duplicate here would
			// weight one reference twice, so the set decides rather than trusts.
			if (mine.has(e.to)) continue;
			mine.add(e.to);
			var c = citers.get(e.to);
			if (!c) citers.set(e.to, c = []);
			c.push(e.from);
			if (inSet.has(e.to)) cites.push(e);
		}

		// Relative to the papers that CAN cite: an item whose PDF never parsed
		// has no reference list, and counting it in the population would make
		// every reference look rarer than it is.
		var cap = Math.max(MIN_CAP, Math.floor(maxShare * refs.size));

		var shared = new Map();
		var works = [...citers.keys()].sort();
		for (var t = 0; t < works.length; t++) {
			var group = citers.get(works[t]);
			if (group.length < 2 || group.length > cap) continue;
			group = group.slice().sort();
			for (var x = 0; x < group.length; x++) {
				for (var y = x + 1; y < group.length; y++) {
					var k = group[x] + ' ' + group[y];
					shared.set(k, (shared.get(k) || 0) + 1);
				}
			}
		}

		var pairs = new Map();
		shared.forEach(function (count, k) {
			var ab = k.split(' ');
			// Salton cosine. Without it a paper with a 60-entry bibliography
			// would couple to everything simply for being long-winded.
			var w = count / Math.sqrt(refs.get(ab[0]).size * refs.get(ab[1]).size);
			pairs.set(k, { a: ab[0], b: ab[1], w: w });
		});
		if (direct > 0) {
			for (var j = 0; j < cites.length; j++) {
				var from = cites[j].from;
				var to = cites[j].to;
				var lo = from < to ? from : to;
				var hi = from < to ? to : from;
				var pk = lo + ' ' + hi;
				var p = pairs.get(pk);
				if (!p) pairs.set(pk, p = { a: lo, b: hi, w: 0 });
				// A cites B and B cites A is one relation seen twice, not two.
				if (!p.direct) { p.w += direct; p.direct = true; }
			}
		}

		var out = [...pairs.values()];
		out.sort(function (p, q) {
			return p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : 0;
		});
		return { pairs: out, refs: refs };
	}

	// --- communities ------------------------------------------------------

	function emptyGraph(n) {
		var adj = new Array(n);
		for (var i = 0; i < n; i++) adj[i] = [];
		return { n: n, adj: adj, self: new Float64Array(n) };
	}

	/** Degrees and 2m, with a self loop counted at both its ends as convention
	 *  demands -- get this wrong and every gain below is scaled wrongly. */
	function degrees(g) {
		var k = new Float64Array(g.n);
		var m2 = 0;
		for (var i = 0; i < g.n; i++) {
			var s = 2 * g.self[i];
			for (var j = 0; j < g.adj[i].length; j++) s += g.adj[i][j].w;
			k[i] = s;
			m2 += s;
		}
		return { k: k, m2: m2 };
	}

	/**
	 * One Louvain pass: move each node to the neighbouring community that gains
	 * the most modularity, until nothing moves.
	 *
	 * Deterministic throughout, which matters more here than it looks. A cluster
	 * is drawn as a colour and named by its own contents; if the partition
	 * wobbled between two runs over identical data the graph would repaint
	 * itself in different colours for no reason the user did anything to cause.
	 * So: nodes in index order (the caller sorts the ids), candidate communities
	 * in ascending order, and a move only on a strict improvement -- an
	 * equal-gain move buys nothing and can oscillate forever.
	 */
	function localMoving(g, resolution) {
		var d = degrees(g);
		var comm = new Int32Array(g.n);
		var tot = new Float64Array(g.n);
		for (var i = 0; i < g.n; i++) { comm[i] = i; tot[i] = d.k[i]; }
		if (d.m2 <= 0) return { moved: false, comm: comm, count: g.n };

		var wTo = new Float64Array(g.n);
		var moved = false;
		for (var round = 0; round < MAX_ROUNDS; round++) {
			var any = false;
			for (var v = 0; v < g.n; v++) {
				var touched = [];
				var nb = g.adj[v];
				for (var e = 0; e < nb.length; e++) {
					if (nb[e].to === v) continue;
					var c = comm[nb[e].to];
					if (wTo[c] === 0) touched.push(c);
					wTo[c] += nb[e].w;
				}
				touched.sort(function (a, b) { return a - b; });

				var old = comm[v];
				tot[old] -= d.k[v];
				var best = old;
				var bestGain = wTo[old] - resolution * tot[old] * d.k[v] / d.m2;
				for (var q = 0; q < touched.length; q++) {
					var cand = touched[q];
					if (cand === old) continue;
					var gain = wTo[cand] - resolution * tot[cand] * d.k[v] / d.m2;
					if (gain > bestGain + EPS) { best = cand; bestGain = gain; }
				}
				comm[v] = best;
				tot[best] += d.k[v];
				if (best !== old) { moved = true; any = true; }

				for (var z = 0; z < touched.length; z++) wTo[touched[z]] = 0;
				wTo[old] = 0;
			}
			if (!any) break;
		}
		var dense = renumber(comm);
		return { moved: moved, comm: dense.comm, count: dense.count };
	}

	/** Communities as 0..k-1, numbered by first appearance so the numbering is
	 *  a function of the node order and nothing else. */
	function renumber(comm) {
		var seen = new Map();
		var out = new Int32Array(comm.length);
		for (var i = 0; i < comm.length; i++) {
			var c = comm[i];
			if (!seen.has(c)) seen.set(c, seen.size);
			out[i] = seen.get(c);
		}
		return { comm: out, count: seen.size };
	}

	/** Collapse each community to a node, its internal weight to a self loop. */
	function aggregate(g, comm, count) {
		var out = emptyGraph(count);
		var between = new Map();
		for (var i = 0; i < g.n; i++) {
			out.self[comm[i]] += g.self[i];
			var nb = g.adj[i];
			for (var e = 0; e < nb.length; e++) {
				// Each undirected edge sits in both adjacency lists; take it once.
				if (nb[e].to <= i) continue;
				var a = comm[i];
				var b = comm[nb[e].to];
				if (a === b) { out.self[a] += nb[e].w; continue; }
				var k = (a < b ? a : b) + ' ' + (a < b ? b : a);
				between.set(k, (between.get(k) || 0) + nb[e].w);
			}
		}
		between.forEach(function (w, k) {
			var ab = k.split(' ');
			var a = Number(ab[0]);
			var b = Number(ab[1]);
			out.adj[a].push({ to: b, w: w });
			out.adj[b].push({ to: a, w: w });
		});
		return out;
	}

	/**
	 * Louvain on a weighted undirected graph.
	 *
	 * @param {string[]} nodes  ids, in the order they should be visited
	 * @param {{a: string, b: string, w: number}[]} pairs
	 * @returns {{of: Map<string, number>, count: number, modularity: number}}
	 */
	function louvain(nodes, pairs, opts) {
		opts = opts || {};
		var resolution = opts.resolution == null ? RESOLUTION : opts.resolution;
		var idx = new Map();
		for (var i = 0; i < nodes.length; i++) idx.set(nodes[i], i);

		var g = emptyGraph(nodes.length);
		for (var p = 0; p < pairs.length; p++) {
			var a = idx.get(pairs[p].a);
			var b = idx.get(pairs[p].b);
			if (a == null || b == null || a === b) continue;
			g.adj[a].push({ to: b, w: pairs[p].w });
			g.adj[b].push({ to: a, w: pairs[p].w });
		}

		// Where each ORIGINAL node sits in the graph of the current level.
		var at = new Int32Array(nodes.length);
		for (var n = 0; n < nodes.length; n++) at[n] = n;

		for (var pass = 0; pass < MAX_PASSES; pass++) {
			var step = localMoving(g, resolution);
			if (!step.moved || step.count === g.n) break;
			for (var m = 0; m < at.length; m++) at[m] = step.comm[at[m]];
			g = aggregate(g, step.comm, step.count);
		}

		var of = new Map();
		for (var v = 0; v < nodes.length; v++) of.set(nodes[v], at[v]);
		return { of: of, count: new Set(at).size, modularity: modularity(pairs, of, resolution) };
	}

	/**
	 * Q for a partition, over the pairs it was built from. Reported so a caller
	 * can tell a real community structure from one the algorithm had to invent:
	 * below about 0.3 the split is mostly arbitrary.
	 */
	function modularity(pairs, of, resolution) {
		resolution = resolution == null ? RESOLUTION : resolution;
		var m = 0;
		var k = new Map();
		var inside = new Map();
		var tot = new Map();
		for (var i = 0; i < pairs.length; i++) {
			var p = pairs[i];
			if (!of.has(p.a) || !of.has(p.b)) continue;
			m += p.w;
			k.set(p.a, (k.get(p.a) || 0) + p.w);
			k.set(p.b, (k.get(p.b) || 0) + p.w);
			if (of.get(p.a) === of.get(p.b)) {
				var c = of.get(p.a);
				inside.set(c, (inside.get(c) || 0) + p.w);
			}
		}
		if (m <= 0) return 0;
		k.forEach(function (w, id) {
			var c = of.get(id);
			tot.set(c, (tot.get(c) || 0) + w);
		});
		var q = 0;
		tot.forEach(function (t, c) {
			q += (inside.get(c) || 0) / m - resolution * (t / (2 * m)) * (t / (2 * m));
		});
		return q;
	}

	// --- naming -----------------------------------------------------------

	/**
	 * Words that say nothing about a subfield. Function words, plus the handful
	 * of academic connectives that otherwise win every cluster: half a physics
	 * library has "using" or "towards" in its titles.
	 */
	var STOP = ('a an the and or of for in on at to from with without within by via as is are be '
		+ 'we our its their this that these those it not no new novel toward towards through over '
		+ 'under between into out about after before during use using used usage based case study '
		+ 'studies paper article report letter review overview introduction chapter thesis preprint '
		+ 'approach approaches method methods technique techniques result results effect effects '
		+ 'system systems model models can may vs versus one two three first second high low '
		+ 'large small more most less than then there here have has had do does done such also').split(' ');
	var STOPSET = new Set(STOP);

	function tokenize(title) {
		if (!title) return [];
		var raw = String(title).toLowerCase().split(/[^\p{L}\p{N}]+/u);
		var out = [];
		for (var i = 0; i < raw.length; i++) {
			var w = raw[i];
			out.push(w.length >= 3 && !STOPSET.has(w) && !/^\d+$/.test(w) ? w : null);
		}
		return out;
	}

	/** The terms one title contributes: its keepable words, and the adjacent
	 *  pairs of them -- "error correction" names a field where "error" and
	 *  "correction" each name several. */
	function terms(title) {
		var t = tokenize(title);
		var set = new Set();
		for (var i = 0; i < t.length; i++) {
			if (!t[i]) continue;
			set.add(t[i]);
			if (t[i + 1]) set.add(t[i] + ' ' + t[i + 1]);
		}
		return set;
	}

	/**
	 * Name each community after what its members are about.
	 *
	 * Scored as (share of the cluster's papers using the term) x idf, so a term
	 * has to be both common inside the cluster and uncommon outside it. A term
	 * only one paper uses is that paper's title rather than the cluster's
	 * subject, so once a cluster is big enough to have a subject the term has to
	 * appear twice.
	 *
	 * The name is derived from contents rather than from a community number,
	 * which is what keeps a cluster's colour stable: the palette hashes the
	 * label, so as long as a cluster is still about the same thing it keeps its
	 * colour, however the partition happened to be numbered this time.
	 *
	 * @param {Map<number, string[]>} members  community -> its item keys
	 * @param {Map<string, string>} titles     item key -> title
	 */
	function nameCommunities(members, titles, opts) {
		opts = opts || {};
		var want = opts.labelTerms == null ? LABEL_TERMS : opts.labelTerms;
		var fallback = opts.fallbackLabel || function (i) { return 'cluster ' + (i + 1); };

		var perDoc = new Map();
		var df = new Map();
		members.forEach(function (keys) {
			for (var i = 0; i < keys.length; i++) {
				var s = terms(titles.get(keys[i]));
				perDoc.set(keys[i], s);
				s.forEach(function (term) { df.set(term, (df.get(term) || 0) + 1); });
			}
		});
		var docs = perDoc.size || 1;

		var out = new Map();
		var taken = new Set();
		var nth = 0;
		members.forEach(function (keys, comm) {
			var local = new Map();
			for (var i = 0; i < keys.length; i++) {
				perDoc.get(keys[i]).forEach(function (term) {
					local.set(term, (local.get(term) || 0) + 1);
				});
			}
			var minDf = keys.length >= 4 ? 2 : 1;
			var ranked = [];
			local.forEach(function (count, term) {
				if (count < minDf) return;
				ranked.push({
					term: term,
					score: (count / keys.length) * Math.log(1 + docs / df.get(term)),
				});
			});
			// On a tie the pair wins: "error correction" and "correction" score
			// identically whenever the word only ever occurs in the phrase, and
			// the phrase is the one that names something.
			ranked.sort(function (a, b) {
				return b.score - a.score
					|| b.term.split(' ').length - a.term.split(' ').length
					|| (a.term < b.term ? -1 : a.term > b.term ? 1 : 0);
			});

			var picked = [];
			var words = new Set();
			for (var r = 0; r < ranked.length && picked.length < want; r++) {
				var parts = ranked[r].term.split(' ');
				// Never "error / error correction": a second term that repeats a
				// word of the first adds nothing to the name.
				var overlap = parts.some(function (w) { return words.has(w); });
				if (overlap) continue;
				parts.forEach(function (w) { words.add(w); });
				picked.push(ranked[r].term);
			}

			var label = picked.length ? picked.join(LABEL_SEP) : fallback(nth);
			// Two clusters sharing a name would share a colour and a legend row,
			// which would read as one cluster. Widen the loser's name instead.
			if (taken.has(label)) {
				for (var s = 0; s < ranked.length && taken.has(label); s++) {
					if (picked.indexOf(ranked[s].term) >= 0) continue;
					label = picked.concat([ranked[s].term]).join(LABEL_SEP);
				}
				var n = 2;
				var base = label;
				while (taken.has(label)) label = base + ' (' + (n++) + ')';
			}
			taken.add(label);
			out.set(comm, label);
			nth++;
		});
		return out;
	}

	// --- the whole thing --------------------------------------------------

	/**
	 * Cluster the held items by what they cite, and name the clusters.
	 *
	 * @param {{from: string, to: string}[]} edges
	 * @param {{key: string, title: ?string}[]} items  the held items
	 * @param {Object} [opts] direct, maxShare, resolution, labelTerms, fallbackLabel
	 * @returns {{of: Map<string, string>, sizes: Map<string, number>, count: number,
	 *   unassigned: number, modularity: number}}
	 *   `of` maps an item key to its cluster's name. An item sharing no
	 *   reference with anything is simply absent from it -- placing a paper that
	 *   has nothing in common with any other would be an invention.
	 */
	function cluster(edges, items, opts) {
		opts = opts || {};
		var titles = new Map();
		var held = new Set();
		for (var i = 0; i < (items || []).length; i++) {
			held.add(items[i].key);
			titles.set(items[i].key, items[i].title || '');
		}

		var cp = coupling(edges, held, opts);
		var seen = new Set();
		for (var p = 0; p < cp.pairs.length; p++) { seen.add(cp.pairs[p].a); seen.add(cp.pairs[p].b); }
		var nodes = [...seen].sort();

		var lv = louvain(nodes, cp.pairs, opts);
		var members = new Map();
		lv.of.forEach(function (comm, key) {
			var list = members.get(comm);
			if (!list) members.set(comm, list = []);
			list.push(key);
		});
		// Biggest first, in a stable order: a fallback name numbers them the way
		// a reader would, and the legend lists them the same way.
		var ordered = new Map([...members.entries()].sort(function (a, b) {
			return b[1].length - a[1].length || a[0] - b[0];
		}));

		var names = nameCommunities(ordered, titles, opts);
		var of = new Map();
		var sizes = new Map();
		ordered.forEach(function (keys, comm) {
			var name = names.get(comm);
			sizes.set(name, keys.length);
			for (var k = 0; k < keys.length; k++) of.set(keys[k], name);
		});

		return {
			of: of,
			sizes: sizes,
			count: ordered.size,
			unassigned: held.size - of.size,
			modularity: lv.modularity,
		};
	}

	global.ZGCluster = {
		DIRECT_WEIGHT: DIRECT_WEIGHT,
		MAX_SHARE: MAX_SHARE,
		LABEL_SEP: LABEL_SEP,
		coupling: coupling,
		louvain: louvain,
		modularity: modularity,
		terms: terms,
		nameCommunities: nameCommunities,
		cluster: cluster,
	};
}(typeof window !== 'undefined' ? window : globalThis));
