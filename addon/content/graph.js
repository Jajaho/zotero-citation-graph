/* global ForceGraph, ZGScale, ZGLinks */

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

	// Held items with nothing to colour BY: no date, when colouring by year.
	const NO_KEY_COLOR = '#9aa0a6';

	// How far the graph outside the isolated node's neighbourhood is faded.
	// Faded and not hidden: the whole point of isolating is to read one node's
	// citations against the shape of the graph they sit in.
	const DIM_NODE_ALPHA = 0.1;
	const DIM_LINK_FACTOR = 0.15;

	// Whether the control panel was left collapsed, remembered across openings.
	const COLLAPSE_KEY = 'zg.panel.collapsed';

	// Same, for the legend.
	const LEGEND_KEY = 'zg.legend.collapsed';

	// Published by nodeScale.js and nodeLinks.js, which graph.html loads first.
	const Scale = ZGScale;
	const Links = ZGLinks;

	let fg = null;
	let raw = null;
	let nodeCache = new Map(); // id -> node object, so x/y survive a re-render
	let disabledVia = new Set();
	let yearRange = null;
	// The citation count that maps to the largest node: the 95th percentile of
	// what is on screen, not the maximum. Recomputed every render, because
	// filtering the graph should rescale it.
	let globalRef = 1;

	// View state for isolation. None of this filters the graph or reaches
	// chrome -- see setIsolated() for why it must not.
	let isolated = null;          // focused node id, or null
	let adjacency = new Map();    // node id -> Set of ids one edge away
	let hoverNode = null;         // whatever force-graph's hit test is over

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
	let elSizeBy = el('size-by');
	let elAction = el('action');
	let elMenu = el('menu');
	let elIsolate = el('isolate-clear');
	let elPanel = el('panel');
	let elPanelToggle = el('panel-toggle');
	let elLegend = el('legend');
	let elLegendToggle = el('legend-toggle');
	let elLegendTitle = el('legend-title');
	let elLegendBody = el('legend-body');

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
		// The ghost the popover describes may not exist in this payload -- after
		// an add it is a real item, and after a rebuild it may be filtered out.
		hideAction();
		hideMenu();
		hoverNode = null;
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
		bits.push('double-click for details · right-click for actions');
		return 'Not in collection — ' + head + '<br/>' + bits.join(' · ');
	}

	/** Held items. Same two counts, same wording, so they read side by side. */
	function itemTooltip(n) {
		let bits = [];
		if (n.inDeg) bits.push('cited by ' + n.inDeg + ' here');
		if (n.citedByGlobal != null) {
			bits.push(n.citedByGlobal.toLocaleString() + ' citations total');
		}
		bits.push('double-click to select in Zotero · right-click for actions');
		return escapeHtml(n.name) + (n.year ? ' (' + n.year + ')' : '')
			+ '<br/>' + bits.join(' · ');
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
		let c = baseColor(n);
		return dimmed(n) ? fade(c, DIM_NODE_ALPHA) : c;
	}

	function baseColor(n) {
		if (n.ghost) return GHOST_COLOR;
		let key = colorKey(n);
		if (key === null) return NO_KEY_COLOR;
		// Year is ordinal, so a ramp says something a hash cannot: old papers
		// read blue, recent ones orange.
		if (elColorBy.value === 'year' && yearRange) {
			let [lo, hi] = yearRange;
			return yearColor(hi > lo ? (n.year - lo) / (hi - lo) : 1);
		}
		return keyColor(key);
	}

	/** Both palettes as functions of the thing being coloured, so the legend
	 *  paints its swatches from the same source the nodes take their colour
	 *  from and the two cannot drift apart. */
	function yearColor(t) {
		return 'hsl(' + Math.round(215 - 190 * t) + ', 62%, 52%)';
	}

	function keyColor(key) {
		return 'hsl(' + hashHue(key) + ', 58%, 55%)';
	}

	/** Stable per-string hue: the same collection keeps its colour across
	 *  renders, which force-graph's own nodeAutoColorBy does not guarantee. */
	function hashHue(s) {
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
		return ((h % 360) + 360) % 360;
	}

	// --- legend -----------------------------------------------------------

	/**
	 * What the node colours mean right now, in the corner opposite the
	 * controls. "Which collection is the blue one" is a question you ask while
	 * reading the graph rather than while changing it, so the answer sits away
	 * from the settings -- and clear of the status line bottom left.
	 *
	 * Rebuilt on every render, because every input to it moves: the colour
	 * mode, the year range, and which nodes survived the filters.
	 */
	const LEGEND_TITLE = {
		year: 'year',
		collection: 'collection',
		author: 'first author',
		type: 'item type',
	};

	// Author and collection have long tails: a legend with two hundred rows is
	// a wall, and each row past this one explains a single node.
	const LEGEND_MAX = 12;

	function renderLegend(nodes) {
		let mode = elColorBy.value;
		elLegendTitle.textContent = LEGEND_TITLE[mode] || mode;
		elLegendBody.textContent = '';

		let held = [];
		let ghosts = 0;
		for (let n of nodes) {
			if (n.ghost) ghosts++;
			else held.push(n);
		}

		if (mode === 'year') yearLegend(held);
		else keyLegend(held);

		// Outside references are the one population coloured by what they are
		// rather than by any metadata they carry, so they get an entry of their
		// own in every mode.
		if (ghosts) elLegendBody.appendChild(legendRow(GHOST_COLOR, 'outside refs', ghosts));

		elLegend.hidden = !elLegendBody.firstChild;
	}

	/** Year is a continuum, so its legend is the ramp itself with the ends
	 *  labelled -- one swatch per year would be fifty rows saying nothing. */
	function yearLegend(nodes) {
		let undated = 0;
		for (let n of nodes) if (n.year == null) undated++;

		if (yearRange) {
			let stops = [];
			for (let i = 0; i <= 8; i++) stops.push(yearColor(i / 8));
			let ramp = document.createElement('div');
			ramp.className = 'legend-ramp';
			ramp.style.background = 'linear-gradient(to right, ' + stops.join(', ') + ')';
			elLegendBody.appendChild(ramp);

			let ends = document.createElement('div');
			ends.className = 'legend-ends';
			let lo = document.createElement('span');
			lo.textContent = yearRange[0];
			let hi = document.createElement('span');
			hi.textContent = yearRange[1];
			ends.appendChild(lo);
			ends.appendChild(hi);
			elLegendBody.appendChild(ends);
		}

		if (undated) elLegendBody.appendChild(legendRow(NO_KEY_COLOR, 'no date', undated));
	}

	/** The hashed modes: one swatch per key, commonest first, so the colours
	 *  covering most of the screen are the ones explained first. */
	function keyLegend(nodes) {
		let counts = new Map();
		for (let n of nodes) {
			let key = colorKey(n);
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		let keys = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a)
			|| (a < b ? -1 : a > b ? 1 : 0));
		for (let key of keys.slice(0, LEGEND_MAX)) {
			elLegendBody.appendChild(legendRow(keyColor(key), key, counts.get(key)));
		}
		let rest = keys.length - LEGEND_MAX;
		if (rest > 0) {
			let more = document.createElement('div');
			more.className = 'legend-more';
			more.textContent = '+' + rest + ' more';
			elLegendBody.appendChild(more);
		}
	}

	function legendRow(color, label, count) {
		let row = document.createElement('div');
		row.className = 'legend-row';
		// The name is clipped to the panel width, so the whole of it has to be
		// reachable somewhere.
		row.title = label + ' — ' + count + (count === 1 ? ' node' : ' nodes');
		let dot = document.createElement('span');
		dot.className = 'dot';
		dot.style.background = color;
		let name = document.createElement('span');
		name.className = 'legend-name';
		name.textContent = label;
		let n = document.createElement('span');
		n.className = 'legend-count';
		n.textContent = count;
		row.appendChild(dot);
		row.appendChild(name);
		row.appendChild(n);
		return row;
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
		adjacency = new Map();
		for (let { e, via } of candidates) {
			if (!inCollection.has(e.to) && !visibleGhosts.has(e.to)) continue;
			links.push({ source: e.from, target: e.to, confidence: e.confidence, via, doi: e.doi });
			inDegree[e.to] = (inDegree[e.to] || 0) + 1;
			outDegree[e.from] = (outDegree[e.from] || 0) + 1;
			relate(e.from, e.to);
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
			n.doi = it.doi || null;
			n.url = it.url || null;
			n.creators = it.creators || [];
			n.collections = it.collections || [];
			n.year = year(it);
			n.deg = deg;
			n.inDeg = inDegree[it.key] || 0;
			n.citedByGlobal = it.citedByGlobal != null ? it.citedByGlobal : null;
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
			n.citedByGlobal = x.citedByGlobal != null ? x.citedByGlobal : null;
			n.label = ghostLabel(x);
			nodes.push(n);
		}

		// After both populations are in: the scale spans held items and ghosts
		// alike, so the two are directly comparable at a glance.
		let counts = [];
		for (let n of nodes) if (n.citedByGlobal != null) counts.push(n.citedByGlobal);
		globalRef = Scale.referenceCount(counts);

		// A filter change or a rebuild can take the focused node off screen, and
		// a focus on a node that is not drawn would dim the whole graph with
		// nothing left lit.
		if (isolated !== null && !nodes.some(n => n.id === isolated)) isolated = null;
		syncIsolateNote();

		if (!fg) {
			fg = ForceGraph()(elGraph);
			// One click isolates; opening the item is the double click, because
			// isolating is the cheap, reversible, in-place gesture and selecting
			// an item throws the user into a different tab.
			fg.onNodeClick(n => toggleIsolate(n.id));
			fg.onNodeRightClick(showMenu);
			fg.onNodeHover((n) => {
				hoverNode = n;
			});
			// Clicking empty canvas dismisses, the way a popover should, and
			// gives the whole graph back.
			fg.onBackgroundClick(() => {
				hideAction();
				hideMenu();
				setIsolated(null);
			});
			fg.onBackgroundRightClick(() => {
				hideAction();
				hideMenu();
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
			.nodeLabel(n => (n.ghost ? ghostTooltip(n) : itemTooltip(n)))
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
				(l.confidence >= ASSERTED ? 0.85 : 0.45)
				* (dimmedLink(l) ? DIM_LINK_FACTOR : 1)))
			.linkWidth(l => (l.confidence >= ASSERTED ? 1.4 : 0.8))
			.d3VelocityDecay(0.3);

		renderLegend(nodes);

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
	const NODE_REL_SIZE = Scale.NODE_REL_SIZE;

	/**
	 * Node area. Two metrics, chosen in the panel, and both apply to outside
	 * references as well as held items.
	 *
	 *  cited here      in-degree: how many papers in THIS collection cite it.
	 *                  The default, and the reason the graph is directed at all.
	 *  global citations how often the whole literature cites it. Needs "look up
	 *                  names" on. Area is proportional to the count up to the
	 *                  95th percentile of what is on screen, then logarithmic
	 *                  above it, so one landmark paper cannot flatten the rest.
	 *
	 * The curve itself lives in nodeScale.js, which is pure and unit-tested --
	 * the first version of this drew a 4,000-citation paper the same size as a
	 * 100-citation one, and nothing but an eye caught it.
	 */
	function nodeVal(n) {
		if (elSizeBy.value === 'global') return Scale.globalVal(n.citedByGlobal, globalRef);
		return 1 + n.inDeg * 2;
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

	/**
	 * Label sizing. The name is painted ON the node, not under it, so a circle
	 * and its name read as one object: with captions hanging below, a dense
	 * graph becomes a field of text whose ownership you have to guess.
	 *
	 * The size follows the node's radius on screen, so a much-cited paper says
	 * its name loudly -- clamped at both ends, because below the floor a label
	 * is not worth drawing and above the ceiling one landmark shouts over the
	 * whole graph. A label wider than its own circle is then shrunk to fit, but
	 * never below the floor; past that it simply overhangs, which is what the
	 * halo is for.
	 */
	const LABEL_MIN_PX = 13;
	const LABEL_MAX_PX = 28;
	const LABEL_PER_RADIUS = 0.85; // screen px of type per px of node radius
	const LABEL_FIT = 1.9;         // how far past its diameter a label may run

	function drawLabel(node, ctx, globalScale) {
		if (!node.label) return;
		// Dimmed nodes lose their label entirely rather than fading it. A halo
		// stroke is what makes a label readable over dense edges, and a faded
		// halo over a faded label is just a smudge.
		if (dimmed(node)) return;
		let theme = themeColors();
		// Everything here is reasoned in screen pixels and divided by
		// globalScale on the way into the canvas, which is in graph units --
		// that is what keeps the type a constant size at any zoom.
		let r = nodeRadius(node) * globalScale;
		let px = Math.max(LABEL_MIN_PX, Math.min(LABEL_MAX_PX, r * LABEL_PER_RADIUS));
		ctx.font = (px / globalScale) + 'px sans-serif';
		let fit = 2 * r * LABEL_FIT;
		let w = ctx.measureText(node.label).width * globalScale;
		if (w > fit) {
			px = Math.max(LABEL_MIN_PX, px * (fit / w));
			ctx.font = (px / globalScale) + 'px sans-serif';
		}
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		// Halo first: the label sits over its own node and over whatever edges
		// cross it, and neither is a surface you can read type off. Painted in
		// the page background colour so it works in Zotero's dark theme too,
		// and joined round so the stroke does not spike off the glyphs.
		ctx.lineJoin = 'round';
		ctx.lineWidth = (px * 0.3) / globalScale;
		ctx.strokeStyle = theme.halo;
		ctx.strokeText(node.label, node.x, node.y);
		ctx.fillStyle = node.ghost ? theme.muted : theme.fg;
		ctx.fillText(node.label, node.x, node.y);
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

	/** Lower a colour's alpha, in either form the palette produces: a hex
	 *  literal, or the hsl() string the year ramp and the hash hues build. */
	function fade(color, a) {
		if (color.charAt(0) === '#') return withAlpha(color, a);
		return color.replace('hsl(', 'hsla(').replace(')', ', ' + a + ')');
	}

	// force-graph renders labels as HTML in its tooltip.
	function escapeHtml(s) {
		return String(s == null ? '' : s).replace(/[&<>"]/g,
			c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	}

	// --- isolation --------------------------------------------------------

	/**
	 * Focus one node: it and everything one edge away keep their colour, and the
	 * rest of the graph fades to a wash.
	 *
	 * Dimming, not filtering, and the difference is load-bearing. Filtering
	 * would drop the other nodes from the simulation, the layout would resettle,
	 * and the neighbourhood you were trying to look at would end up somewhere
	 * else on screen -- destroying exactly the spatial memory you were reading
	 * the graph with. Nothing here touches graphData; only the colour accessors
	 * change, so every node stays exactly where it was.
	 */
	function setIsolated(id) {
		if (isolated === id) return;
		isolated = id;
		syncIsolateNote();
		// Re-setting a visual accessor is what marks the canvas dirty.
		// force-graph pauses its redraw loop once the simulation has cooled, so
		// without this the fade would not appear until something else moved.
		if (fg) fg.nodeColor(nodeColor);
	}

	function toggleIsolate(id) {
		hideAction();
		hideMenu();
		setIsolated(isolated === id ? null : id);
	}

	/**
	 * Adjacency is undirected on purpose. Isolating a paper should show what it
	 * cites AND what cites it -- the neighbourhood is the interesting object,
	 * and half of it would be a strange thing to show.
	 */
	function relate(a, b) {
		let sa = adjacency.get(a);
		if (!sa) adjacency.set(a, sa = new Set());
		sa.add(b);
		let sb = adjacency.get(b);
		if (!sb) adjacency.set(b, sb = new Set());
		sb.add(a);
	}

	function dimmed(n) {
		if (isolated === null || n.id === isolated) return false;
		let near = adjacency.get(isolated);
		return !(near && near.has(n.id));
	}

	/** force-graph rewrites a link's endpoints into node references once the
	 *  data is loaded, so the same field is a plain id before the first tick. */
	function endId(x) {
		return x && typeof x === 'object' ? x.id : x;
	}

	function dimmedLink(l) {
		if (isolated === null) return false;
		return endId(l.source) !== isolated && endId(l.target) !== isolated;
	}

	/**
	 * Isolation is otherwise invisible in the panel, and a user who does not
	 * know that clicking the background clears it would have no way back to the
	 * whole graph.
	 */
	function syncIsolateNote() {
		let n = isolated === null ? null : nodeCache.get(isolated);
		elIsolate.hidden = !n;
		if (n) elIsolate.textContent = 'isolated: ' + (n.label || n.name) + ' ✕';
	}

	elIsolate.addEventListener('click', () => setIsolated(null));

	window.addEventListener('pointerdown', (e) => {
		if (!elMenu.hidden && !elMenu.contains(e.target)) hideMenu();
	}, true);

	/**
	 * force-graph has no double-click event, but it does unbind d3-zoom's
	 * dblclick-to-zoom, which leaves the DOM one free for us. The node is
	 * whatever the pointer is over -- force-graph's own hit test already knows,
	 * and asking it is more reliable than timing two clicks ourselves.
	 *
	 * The pair of clicks underneath still runs toggleIsolate twice, which
	 * cancels out: a double click leaves the isolation state exactly as it found
	 * it and does nothing but open the node.
	 */
	elGraph.addEventListener('dblclick', (event) => {
		if (hoverNode) activate(hoverNode, event);
	});

	/**
	 * What "open this" means for the two node populations. A held item is
	 * selected in the library pane; an outside reference has no item to select,
	 * so it gets the card describing what adding it would add.
	 */
	function activate(n, event) {
		hideMenu();
		if (n.ghost) showAction(n, event);
		else if (n.itemID) emit({ type: 'open-item', itemID: n.itemID });
	}

	// --- the node context menu --------------------------------------------

	/**
	 * Built fresh per node rather than shown and hidden, because what it offers
	 * differs between the two populations: a held item can be selected in the
	 * library and opened at its own URL, an outside reference can only be
	 * resolved through its identifier or added.
	 */
	function showMenu(n, event) {
		hideAction();
		elMenu.textContent = '';
		for (let entry of (n.ghost ? ghostMenu(n) : itemMenu(n))) {
			elMenu.appendChild(menuItem(entry));
		}
		elMenu.hidden = false;
		positionAt(elMenu, event);
	}

	function hideMenu() {
		elMenu.hidden = true;
	}

	function menuItem({ label, hint, disabled, run }) {
		let b = document.createElement('button');
		b.type = 'button';
		b.className = 'menu-item';
		b.textContent = label;
		if (hint) b.title = hint;
		if (disabled) {
			b.disabled = true;
		}
		else {
			b.addEventListener('click', () => {
				hideMenu();
				run();
			});
		}
		return b;
	}

	function ghostMenu(n) {
		let x = n.meta || {};
		let url = Links.externalUrl(x.ns, x.id || n.name);
		return [
			{
				label: 'Open in browser',
				hint: url || 'no resolvable identifier',
				disabled: !url,
				run: () => emit({ type: 'open-url', url }),
			},
			{
				// Straight to the add, where the card on double click asks
				// first. A menu entry cannot be hit by a stray click while
				// panning, and that is the only thing the confirmation was ever
				// there to prevent.
				label: 'Add to Zotero',
				hint: n.name,
				disabled: x.ns !== 'doi',
				run: () => emit({ type: 'add-item', doi: n.name }),
			},
		];
	}

	function itemMenu(n) {
		let url = Links.itemUrl(n);
		return [
			{
				label: 'Select in Zotero',
				disabled: !n.itemID,
				run: () => emit({ type: 'open-item', itemID: n.itemID }),
			},
			{
				label: isolated === n.id ? 'Show whole graph' : 'Isolate',
				run: () => setIsolated(isolated === n.id ? null : n.id),
			},
			{
				label: 'Open in browser',
				hint: url || 'this item has neither a URL nor a DOI',
				disabled: !url,
				run: () => emit({ type: 'open-url', url }),
			},
		];
	}

	/**
	 * Open at the pointer, clamped so a floating panel cannot land off-screen at
	 * the right or bottom edge -- which is exactly where a dense graph pushes
	 * you to click.
	 */
	function positionAt(node, event) {
		let w = node.offsetWidth;
		let h = node.offsetHeight;
		let px = event ? event.clientX : window.innerWidth / 2;
		let py = event ? event.clientY : window.innerHeight / 2;
		node.style.left = Math.max(4, Math.min(px + 12, window.innerWidth - w - 8)) + 'px';
		node.style.top = Math.max(4, Math.min(py + 12, window.innerHeight - h - 8)) + 'px';
	}

	// --- the outside-reference action popover -----------------------------

	/**
	 * A ghost's detail card, opened by double click -- the outside reference's
	 * answer to "select this in Zotero", since there is no item to select yet.
	 *
	 * Adding WRITES to the library, so from here it sits behind an explicit
	 * button: a double click is one stray gesture away while panning, and
	 * silently filing a paper is cheap to undo but not something to do unasked.
	 * The context menu skips the confirmation because a right-click menu entry
	 * cannot be hit by accident.
	 */
	let actionNode = null;

	function showAction(n, event) {
		actionNode = n;
		let x = n.meta || {};
		el('action-title').textContent = x.title || n.name;
		let sub = [];
		if (x.creators && x.creators.length) {
			sub.push(x.creators.slice(0, 3).join(', ') + (x.creators.length > 3 ? ' et al.' : ''));
		}
		if (x.year) sub.push(x.year);
		sub.push('cited by ' + n.inDeg + ' here');
		if (x.citedByGlobal != null) sub.push(x.citedByGlobal.toLocaleString() + ' citations total');
		// The DOI is the thing actually being added, so show it verbatim.
		sub.push(n.name);
		el('action-sub').textContent = sub.join(' · ');

		let add = el('action-add');
		add.disabled = false;
		add.textContent = 'Add to Zotero';

		elAction.hidden = false;
		positionAt(elAction, event);
	}

	function hideAction() {
		elAction.hidden = true;
		actionNode = null;
	}

	el('action-close').addEventListener('click', hideAction);
	el('action-add').addEventListener('click', () => {
		if (!actionNode) return;
		let add = el('action-add');
		add.disabled = true;
		add.textContent = 'Adding…';
		// Chrome answers by rebuilding, which re-pushes and re-renders; the
		// popover is dismissed now because the node it describes is about to
		// stop existing as a ghost.
		emit({ type: 'add-item', doi: actionNode.name });
		hideAction();
	});
	// One layer per press, outermost first, so Escape never throws away more
	// state than the user was looking at.
	window.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		if (!elMenu.hidden) hideMenu();
		else if (!elAction.hidden) hideAction();
		else setIsolated(null);
	});

	// --- controls ---------------------------------------------------------

	function syncEnabled() {
		let on = elIncludeExternal.checked;
		elMinCites.disabled = !on;
		elEnrich.disabled = !on;
		el('min-cites-label').classList.toggle('disabled', !on);
		el('enrich-label').classList.toggle('disabled', !on);

		// Nothing has a global count until the lookup has run, so offering to
		// size by one would just flatten every node to the same dot.
		let haveCounts = !!(raw && raw.options && raw.options.enrich);
		let globalOpt = elSizeBy.querySelector('option[value="global"]');
		globalOpt.disabled = !haveCounts;
		globalOpt.textContent = haveCounts
			? 'global citations'
			: 'global citations (needs look up names)';
		if (!haveCounts && elSizeBy.value === 'global') elSizeBy.value = 'here';
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
	// Size changes node radii, which the collision force sizes its grid from --
	// re-registering it is what makes it pick the new radii up.
	elSizeBy.addEventListener('change', () => {
		render();
		if (fg) fg.d3Force('collide', collide()).d3ReheatSimulation();
	});
	elHideIsolated.addEventListener('change', () => {
		elHideIsolated.dataset.touched = '1';
		render();
	});

	// The panel floats over the canvas, so collapsing it does not resize the
	// graph -- it just gives the nodes underneath back.
	function setCollapsed(on) {
		elPanel.classList.toggle('collapsed', on);
		elPanelToggle.setAttribute('aria-expanded', on ? 'false' : 'true');
		elPanelToggle.title = on ? 'Show controls' : 'Collapse controls';
		// Storage is a nicety, not a requirement: a resource:// page can be
		// denied it, and the panel still works when the write throws.
		try {
			window.localStorage.setItem(COLLAPSE_KEY, on ? '1' : '0');
		}
		catch (e) { /* no persistence, no problem */ }
	}

	elPanelToggle.addEventListener('click', () => {
		setCollapsed(!elPanel.classList.contains('collapsed'));
	});

	try {
		if (window.localStorage.getItem(COLLAPSE_KEY) === '1') setCollapsed(true);
	}
	catch (e) { /* see setCollapsed */ }

	// The legend collapses the same way and for the same reason: on a narrow
	// pane a twelve-author list is more legend than graph.
	function setLegendCollapsed(on) {
		elLegend.classList.toggle('collapsed', on);
		elLegendToggle.setAttribute('aria-expanded', on ? 'false' : 'true');
		elLegendToggle.title = on ? 'Show legend' : 'Collapse legend';
		try {
			window.localStorage.setItem(LEGEND_KEY, on ? '1' : '0');
		}
		catch (e) { /* no persistence, no problem */ }
	}

	elLegendToggle.addEventListener('click', () => {
		setLegendCollapsed(!elLegend.classList.contains('collapsed'));
	});

	try {
		if (window.localStorage.getItem(LEGEND_KEY) === '1') setLegendCollapsed(true);
	}
	catch (e) { /* see setCollapsed */ }

	window.addEventListener('resize', () => {
		if (fg) fg.width(elGraph.clientWidth).height(elGraph.clientHeight);
		// Both were positioned against the viewport they opened in.
		hideMenu();
		hideAction();
	});

	syncEnabled();
}());
