/* global ForceGraph */

/**
 * Content-side renderer. Runs with an ordinary content principal inside a
 * <browser type="content">, so it has no Zotero/XPCOM access -- everything
 * arrives as a JSON string through window.zgSetData / window.zgSetStatus and
 * goes back out as a JSON string on a 'zg-event' CustomEvent.
 *
 * Two classes of control:
 *   - Scope (subcollections, outside refs) change what gets DERIVED, so they
 *     send a rebuild back to chrome and cost a full pass.
 *   - Everything else filters an already-built graph and is instant, no matter
 *     how expensive that graph was to compute.
 */

(function () {
	'use strict';

	// Confidence at which an edge counts as publisher-asserted (a DOI the
	// typesetter embedded) rather than inferred from a title match.
	const ASSERTED = 0.9;

	// Works we do not hold. Deliberately one flat colour: they carry no metadata
	// to colour BY -- offline, a reference outside the collection is a DOI and
	// nothing else.
	const GHOST_COLOR = '#8e8e93';

	let fg = null;
	let raw = null;
	let nodeCache = new Map(); // id -> node object, so x/y survive a re-render
	let disabledVia = new Set();
	let yearRange = null;

	let el = id => document.getElementById(id);
	let elGraph = el('graph');
	let elStats = el('stats');
	let elStatus = el('status');
	let elName = el('collection-name');
	let elMinConf = el('min-conf');
	let elConfValue = el('conf-value');
	let elStrategies = el('strategies');
	let elHideIsolated = el('hide-isolated');
	let elRecursive = el('recursive');
	let elIncludeExternal = el('include-external');
	let elMinCites = el('min-cites');
	let elEnrich = el('enrich');
	let elColorBy = el('color-by');

	function emit(msg) {
		window.dispatchEvent(new CustomEvent('zg-event', { detail: JSON.stringify(msg) }));
	}

	// --- chrome -> content ------------------------------------------------

	window.zgSetData = function (json) {
		let next;
		try {
			next = JSON.parse(json);
		}
		catch (e) {
			elStatus.textContent = 'Bad payload: ' + e.message;
			return;
		}
		let firstEdges = (!raw || !raw.edges.length) && next.edges.length;
		raw = next;
		raw.external = raw.external || [];
		elName.textContent = (raw.collection && raw.collection.name) || '';
		// Chrome owns the scope options; reflect what it actually used, which
		// matters after a rebuild that was still in flight.
		if (raw.options) {
			elRecursive.checked = !!raw.options.recursive;
			elIncludeExternal.checked = !!raw.options.includeExternal;
			elEnrich.checked = !!raw.options.enrich;
		}
		yearRange = null;
		renderStrategyToggles();
		// Only auto-hide unconnected nodes the first time edges show up; after
		// that the checkbox belongs to the user.
		if (firstEdges && !elHideIsolated.dataset.touched) {
			elHideIsolated.checked = true;
		}
		syncEnabled();
		render();
	};

	window.zgSetStatus = function (text) {
		elStatus.textContent = text || '';
	};

	// --- item helpers -----------------------------------------------------

	function year(item) {
		let m = String(item.date || '').match(/\b(1[89]\d\d|20\d\d)\b/);
		return m ? Number(m[1]) : null;
	}

	/**
	 * The always-visible node label, in the usual citekey form: first author's
	 * surname followed by the year, e.g. "Kucsko2013". Falls back through the
	 * title's first meaningful word, because a node with no label at all is
	 * worse than an approximate one.
	 */
	function shortLabel(item, y) {
		let author = (item.creators || [])[0];
		if (!author) {
			let word = String(item.title || '').split(/\s+/)
				.find(w => w.replace(/\W/g, '').length > 3);
			author = word ? word.replace(/\W/g, '') : '';
		}
		author = author.replace(/\s+/g, '');
		if (!author && !y) return '?';
		return author + (y || '');
	}

	/**
	 * Ghost labels. With "look up names" on, an enriched ghost gets the same
	 * Surname+Year citekey as a real node, so the two read alike and the graph
	 * becomes legible without opening a tooltip.
	 *
	 * Unenriched -- which is the default, and also every ghost past the lookup
	 * cap -- falls back to the DOI suffix. The registrant prefix is the same for
	 * every paper from one publisher and carries no information.
	 */
	function ghostLabel(x) {
		if (x.title || (x.creators && x.creators.length)) {
			return shortLabel({ creators: x.creators, title: x.title }, x.year);
		}
		let s = String(x.id || '');
		let slash = s.indexOf('/');
		let tail = slash >= 0 ? s.slice(slash + 1) : s;
		return tail.length > 20 ? tail.slice(0, 19) + '…' : tail;
	}

	/**
	 * Tooltip for a ghost. Both counts appear, and both are named: `citedBy` is
	 * citers inside this collection, `citedByGlobal` is the whole literature.
	 * Conflating them would undo the reason ghosts are computed at all -- see
	 * docs/external-references.md part 4.
	 */
	function ghostTooltip(n) {
		let x = n.meta || {};
		let head = x.title ? escapeHtml(x.title) : escapeHtml(n.name);
		let bits = [];
		if (x.creators && x.creators.length) {
			bits.push(escapeHtml(x.creators.slice(0, 3).join(', ')
				+ (x.creators.length > 3 ? ' et al.' : '')));
		}
		if (x.year) bits.push(x.year);
		bits.push('cited by ' + n.inDeg + ' here');
		if (x.citedByGlobal != null) {
			bits.push(x.citedByGlobal.toLocaleString() + ' citations total');
		}
		return 'Not in collection — ' + head + '<br/>' + bits.join(' · ');
	}

	// --- colour -----------------------------------------------------------

	function colorKey(n) {
		switch (elColorBy.value) {
			case 'collection': return (n.collections || [])[0] || '(no collection)';
			case 'author': return (n.creators || [])[0] || '(no author)';
			case 'type': return n.itemType || '(unknown type)';
			default: return n.year == null ? null : String(n.year);
		}
	}

	function nodeColor(n) {
		if (n.ghost) return GHOST_COLOR;
		let key = colorKey(n);
		if (key === null) return '#9aa0a6'; // no date, when colouring by year
		// Year is ordinal, so a ramp says something a hash cannot: old papers
		// read blue, recent ones orange.
		if (elColorBy.value === 'year' && yearRange) {
			let [lo, hi] = yearRange;
			let t = hi > lo ? (n.year - lo) / (hi - lo) : 1;
			return 'hsl(' + Math.round(215 - 190 * t) + ', 62%, 52%)';
		}
		return 'hsl(' + hashHue(key) + ', 58%, 55%)';
	}

	/** Stable per-string hue: the same collection keeps its colour across
	 *  renders, which force-graph's own nodeAutoColorBy does not guarantee. */
	function hashHue(s) {
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
		return ((h % 360) + 360) % 360;
	}

	// --- strategy toggles -------------------------------------------------

	let renderedVias = '';

	function renderStrategyToggles() {
		let seen = new Set();
		for (let e of raw.edges) for (let v of e.via) seen.add(v);
		let vias = [...seen].sort();
		let sig = vias.join(',');
		if (sig === renderedVias) return;
		renderedVias = sig;

		elStrategies.textContent = '';
		for (let via of vias) {
			let label = document.createElement('label');
			label.className = 'via-toggle';
			let cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = !disabledVia.has(via);
			cb.addEventListener('change', () => {
				if (cb.checked) disabledVia.delete(via);
				else disabledVia.add(via);
				render();
			});
			let dot = document.createElement('span');
			dot.className = 'dot';
			dot.style.background = viaColor(via);
			label.appendChild(cb);
			label.appendChild(dot);
			label.appendChild(document.createTextNode(via));
			elStrategies.appendChild(label);
		}
	}

	function viaColor(via) {
		switch (via) {
			case 'pdf-links': return '#4a90d9';
			case 'text-doi': return '#3fa66a';
			case 'title-match': return '#b0b0b0';
			default: return '#8a7fd0';
		}
	}

	const VIA_RANK = ['pdf-links', 'text-doi', 'title-match'];

	function bestVia(via) {
		for (let v of VIA_RANK) if (via.includes(v)) return v;
		return via[0];
	}

	// --- rendering --------------------------------------------------------

	function render() {
		if (!raw) return;
		let minConf = Number(elMinConf.value);
		elConfValue.textContent = minConf.toFixed(2);
		let minCites = Math.max(1, Number(elMinCites.value) || 1);
		let showGhosts = elIncludeExternal.checked && raw.external.length > 0;

		let inCollection = new Set(raw.items.map(i => i.key));

		// 1. Edges surviving the confidence and strategy filters.
		let candidates = [];
		for (let e of raw.edges) {
			if (e.confidence < minConf) continue;
			// An edge survives if any strategy that produced it is still enabled.
			let via = e.via.filter(v => !disabledVia.has(v));
			if (via.length) candidates.push({ e, via });
		}

		// 2. Ghost citation counts, recomputed over the FILTERED edges -- a count
		//    taken before filtering would contradict what is on screen.
		let ghostCites = Object.create(null);
		for (let { e } of candidates) {
			if (!inCollection.has(e.to)) ghostCites[e.to] = (ghostCites[e.to] || 0) + 1;
		}

		let visibleGhosts = new Map();
		if (showGhosts) {
			for (let x of raw.external) {
				let n = ghostCites[x.key] || 0;
				if (n >= minCites) visibleGhosts.set(x.key, { x, cites: n });
			}
		}

		// 3. Links, dropped when their target ghost is filtered out.
		let inDegree = Object.create(null);
		let outDegree = Object.create(null);
		let links = [];
		for (let { e, via } of candidates) {
			if (!inCollection.has(e.to) && !visibleGhosts.has(e.to)) continue;
			links.push({ source: e.from, target: e.to, confidence: e.confidence, via, doi: e.doi });
			inDegree[e.to] = (inDegree[e.to] || 0) + 1;
			outDegree[e.from] = (outDegree[e.from] || 0) + 1;
		}

		// 4. Nodes. Reuse the objects so force-graph keeps the simulated
		//    position: later build phases then add edges to a settled layout
		//    instead of restarting it from scratch.
		let years = [];
		for (let it of raw.items) {
			let y = year(it);
			if (y) years.push(y);
		}
		yearRange = years.length ? [Math.min(...years), Math.max(...years)] : null;

		let nodes = [];
		for (let it of raw.items) {
			let deg = (inDegree[it.key] || 0) + (outDegree[it.key] || 0);
			if (elHideIsolated.checked && !deg) continue;
			let n = nodeCache.get(it.key);
			if (!n) nodeCache.set(it.key, n = { id: it.key });
			n.ghost = false;
			n.name = it.title;
			n.itemID = it.itemID;
			n.itemType = it.itemType;
			n.creators = it.creators || [];
			n.collections = it.collections || [];
			n.year = year(it);
			n.deg = deg;
			n.inDeg = inDegree[it.key] || 0;
			n.label = shortLabel(it, n.year);
			nodes.push(n);
		}
		for (let [key, { x, cites }] of visibleGhosts) {
			let n = nodeCache.get(key);
			if (!n) nodeCache.set(key, n = { id: key });
			n.ghost = true;
			n.name = x.id;
			n.itemID = null;
			n.deg = cites;
			n.inDeg = cites;
			// Node size stays on local in-degree; citedByGlobal is tooltip-only.
			// A famous paper you do not hold is not a gap in your library.
			n.meta = x;
			n.label = ghostLabel(x);
			nodes.push(n);
		}

		if (!fg) {
			fg = ForceGraph()(elGraph);
			fg.onNodeClick(n => {
				if (n.itemID) emit({ type: 'open-item', itemID: n.itemID });
			});
			// d3 re-initialises every registered force whenever the node array
			// is replaced, so these pick up new nodes and new radii on their
			// own and only ever need registering once.
			fg.d3Force('centerPull', centerPull());
			fg.d3Force('collide', collide());
		}

		fg.width(elGraph.clientWidth)
			.height(elGraph.clientHeight)
			.graphData({ nodes, links })
			.nodeId('id')
			.nodeLabel(n => (n.ghost
				? ghostTooltip(n)
				: escapeHtml(n.name) + (n.year ? ' (' + n.year + ')' : '')
					+ (n.inDeg ? ' — cited by ' + n.inDeg + ' here' : '')))
			.nodeRelSize(NODE_REL_SIZE)
			.nodeVal(nodeVal)
			.nodeColor(nodeColor)
			.nodeCanvasObjectMode(() => 'after')
			.nodeCanvasObject(drawLabel)
			.linkDirectionalArrowLength(4)
			.linkDirectionalArrowRelPos(1)
			.linkCurvature(0.08)
			.linkLabel(l => l.via.join(', ') + (l.doi ? ' — ' + escapeHtml(l.doi) : ''))
			// Colour by the strongest strategy backing the edge, so a publisher's
			// own DOI link reads differently from an inferred title match.
			.linkColor(l => withAlpha(viaColor(bestVia(l.via)),
				l.confidence >= ASSERTED ? 0.85 : 0.45))
			.linkWidth(l => (l.confidence >= ASSERTED ? 1.4 : 0.8))
			.d3VelocityDecay(0.3);

		let phase = raw.meta && raw.meta.phase;
		let ghostCount = visibleGhosts.size;
		let named = 0;
		for (let [, { x }] of visibleGhosts) if (x.title) named++;
		elStats.textContent = (nodes.length - ghostCount) + ' / ' + raw.items.length + ' items'
			+ (ghostCount ? ' · ' + ghostCount + ' outside'
				+ (named ? ' (' + named + ' named)' : '') : '')
			+ ' · ' + links.length + ' edges'
			+ (phase && phase !== 'done' ? ' · building…' : '');
	}

	/**
	 * Labels are drawn in 'after' mode, so force-graph still paints the node
	 * circle and still owns hit-testing. Dividing by globalScale keeps the text
	 * a constant size on screen at any zoom.
	 */
	const NODE_REL_SIZE = 4;

	/** In-degree = how many papers in this collection cite it. Sizing by it is the
	 *  whole reason the graph is directed. Ghosts stay small: they are context,
	 *  not the subject. */
	function nodeVal(n) {
		return n.ghost ? 0.6 : 1 + n.inDeg * 2;
	}

	/** force-graph draws a node as a circle of sqrt(val) * nodeRelSize, in graph
	 *  coordinates. The label has to clear that, so it uses the same formula. */
	function nodeRadius(n) {
		return Math.sqrt(nodeVal(n)) * NODE_REL_SIZE;
	}

	// --- layout forces ----------------------------------------------------

	/**
	 * Pull every node toward the origin. force-graph's built-in centring force
	 * only translates the whole cloud so its centroid sits at 0,0 -- it exerts
	 * nothing on an individual node. A node with no edges therefore feels only
	 * charge repulsion, which is purely outward, and drifts away forever.
	 *
	 * Connected nodes get a light pull (their links already hold them, and a
	 * hard pull would crush the layout into a disc); unconnected ones get a
	 * firm one, which parks them in a ring at the edge of the graph instead of
	 * off screen.
	 */
	const PULL = 0.02;
	const PULL_ORPHAN = 0.15;

	function centerPull() {
		let nodes = [];
		function force(alpha) {
			for (let n of nodes) {
				let k = (n.deg ? PULL : PULL_ORPHAN) * alpha;
				n.vx -= n.x * k;
				n.vy -= n.y * k;
			}
		}
		force.initialize = ns => {
			nodes = ns;
		};
		return force;
	}

	/**
	 * Hard-sphere collision, sized per node. Charge repulsion falls off with
	 * distance and is balanced against link attraction, so it happily lets two
	 * circles overlap -- and ours differ in radius several-fold, because a
	 * much-cited paper is drawn much bigger. This is the same resolution rule
	 * d3's forceCollide uses: if two circles interpenetrate at their projected
	 * next position, push them apart along the line of centres and split the
	 * correction by area, so the big node barely moves and the small one gives
	 * way. Run at full strength over two passes -- overlap is a hard constraint
	 * here, not a preference.
	 *
	 * Candidate pairs come from a uniform grid whose cell is the largest
	 * distance at which any two nodes can touch, so only the 3x3 neighbourhood
	 * has to be searched and the tick stays linear in node count.
	 */
	const COLLIDE_PAD = 3; // graph units of clear space left between circles
	const COLLIDE_PASSES = 2;

	function collide() {
		let nodes = [];
		let radii = [];
		let cell = 1;

		function force() {
			if (nodes.length < 2) return;
			for (let pass = 0; pass < COLLIDE_PASSES; pass++) {
				let grid = new Map();
				for (let i = 0; i < nodes.length; i++) {
					let n = nodes[i];
					let key = Math.floor((n.x + n.vx) / cell) + ',' + Math.floor((n.y + n.vy) / cell);
					let bucket = grid.get(key);
					if (bucket) bucket.push(i);
					else grid.set(key, [i]);
				}
				for (let i = 0; i < nodes.length; i++) {
					let a = nodes[i];
					let ri = radii[i];
					let cx = Math.floor((a.x + a.vx) / cell);
					let cy = Math.floor((a.y + a.vy) / cell);
					for (let gx = cx - 1; gx <= cx + 1; gx++) {
						for (let gy = cy - 1; gy <= cy + 1; gy++) {
							let bucket = grid.get(gx + ',' + gy);
							if (!bucket) continue;
							for (let j of bucket) {
								// Each pair is resolved once, by its lower index.
								if (j <= i) continue;
								let b = nodes[j];
								let rj = radii[j];
								let r = ri + rj + COLLIDE_PAD;
								let dx = (b.x + b.vx) - (a.x + a.vx);
								let dy = (b.y + b.vy) - (a.y + a.vy);
								let l2 = dx * dx + dy * dy;
								if (l2 >= r * r) continue;
								// Exactly coincident: no line of centres to push
								// along, so pick an arbitrary one.
								if (l2 < 1e-12) {
									dx = (Math.random() - 0.5) * 1e-4;
									dy = (Math.random() - 0.5) * 1e-4;
									l2 = dx * dx + dy * dy;
								}
								let l = Math.sqrt(l2);
								let push = (r - l) / l;
								dx *= push;
								dy *= push;
								// Share of the correction taken by b, weighted by
								// a's area: the heavier circle stays put.
								let wb = (ri * ri) / (ri * ri + rj * rj);
								b.vx += dx * wb;
								b.vy += dy * wb;
								a.vx -= dx * (1 - wb);
								a.vy -= dy * (1 - wb);
							}
						}
					}
				}
			}
		}

		force.initialize = ns => {
			nodes = ns;
			radii = nodes.map(nodeRadius);
			let maxR = 0;
			for (let r of radii) if (r > maxR) maxR = r;
			cell = 2 * maxR + COLLIDE_PAD;
		};
		return force;
	}

	function drawLabel(node, ctx, globalScale) {
		if (!node.label) return;
		let theme = themeColors();
		ctx.font = (10 / globalScale) + 'px sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		let y = node.y + nodeRadius(node) + 2 / globalScale;
		// Halo first: labels sit on top of edges and would otherwise be unreadable
		// wherever the graph is dense. Painted in the page background colour so it
		// works in Zotero's dark theme too.
		ctx.lineWidth = 3 / globalScale;
		ctx.strokeStyle = theme.halo;
		ctx.strokeText(node.label, node.x, y);
		ctx.fillStyle = node.ghost ? theme.muted : theme.fg;
		ctx.fillText(node.label, node.x, y);
	}

	/** Read from the stylesheet rather than hardcoded, so light/dark both work. */
	let _theme = null;
	function themeColors() {
		if (!_theme) {
			let cs = getComputedStyle(document.documentElement);
			let get = (v, fallback) => (cs.getPropertyValue(v) || '').trim() || fallback;
			_theme = {
				fg: get('--fg', '#1a1a1a'),
				muted: get('--muted', '#6b6b6b'),
				halo: get('--bg', '#ffffff'),
			};
		}
		return _theme;
	}
	if (window.matchMedia) {
		window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
			_theme = null;
			if (fg) fg.nodeCanvasObject(drawLabel); // force a repaint
		});
	}

	function withAlpha(hex, a) {
		let n = parseInt(hex.slice(1), 16);
		return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
	}

	// force-graph renders labels as HTML in its tooltip.
	function escapeHtml(s) {
		return String(s == null ? '' : s).replace(/[&<>"]/g,
			c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	}

	// --- controls ---------------------------------------------------------

	function syncEnabled() {
		let on = elIncludeExternal.checked;
		elMinCites.disabled = !on;
		elEnrich.disabled = !on;
		el('min-cites-label').classList.toggle('disabled', !on);
		el('enrich-label').classList.toggle('disabled', !on);
	}

	/** Scope changes cannot be filtered into existence -- they need a new build. */
	function requestRebuild() {
		syncEnabled();
		elStatus.textContent = 'Rebuilding…';
		emit({
			type: 'rebuild',
			options: {
				recursive: elRecursive.checked,
				includeExternal: elIncludeExternal.checked,
				enrich: elEnrich.checked,
			},
		});
	}

	elRecursive.addEventListener('change', requestRebuild);
	elIncludeExternal.addEventListener('change', requestRebuild);
	// Scope, not a filter: names have to be fetched, so this costs a rebuild.
	elEnrich.addEventListener('change', requestRebuild);
	el('rebuild').addEventListener('click', requestRebuild);

	elMinConf.addEventListener('input', render);
	elMinCites.addEventListener('input', render);
	elColorBy.addEventListener('change', render);
	elHideIsolated.addEventListener('change', () => {
		elHideIsolated.dataset.touched = '1';
		render();
	});

	window.addEventListener('resize', () => {
		if (fg) fg.width(elGraph.clientWidth).height(elGraph.clientHeight);
	});

	syncEnabled();
}());
