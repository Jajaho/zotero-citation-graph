/* global ForceGraph, ZGScale, ZGLinks, ZGFilters, ZGCluster, ZGGaps, ZGL10n, ZGIcons */

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

	// How far the graph outside the isolated neighbourhood is faded. Faded and
	// not hidden: the whole point of isolating is to read one node's citations
	// against the shape of the graph they sit in.
	const DIM_NODE_ALPHA = 0.1;
	const DIM_LINK_FACTOR = 0.15;

	// How far a highlighted node's own edges are lifted out of the picture.
	// Lifted, where isolation dims: a highlight answers "which lines touch this
	// one", and that only reads against the lines it is being picked out from.
	// The two are meant to be legible at the same time, so they must not both
	// work by taking colour away.
	const HL_LINK_ALPHA = 1;
	const HL_LINK_WIDTH = 2;

	// Whether the control panel was left collapsed, remembered across openings.
	const COLLAPSE_KEY = 'zg.panel.collapsed';

	// Same, for the legend.
	const LEGEND_KEY = 'zg.legend.collapsed';
	/** Layout comfort, not a view of the data: how hard the user likes their
	 *  edges to pull. Worth remembering across windows for the same reason the
	 *  collapsed panel is -- it is a setting about this screen, not this graph. */
	const PULL_KEY = 'zg.link.pull';
	/** And for how hard the middle of the canvas holds on. */
	const CENTER_KEY = 'zg.center.pull';
	/** Same again, for how far an isolation reaches: someone who reads their
	 *  graph two steps out reads every graph two steps out. */
	const DEPTH_KEY = 'zg.isolate.depth';
	/** Whether the sidebar is showing, and how wide it was left. Both are facts
	 *  about this screen rather than about this collection, which is why they
	 *  live here beside the rest and not in a Zotero pref. */
	const SIDE_KEY = 'zg.side.open';
	const SIDE_WIDTH_KEY = 'zg.side.width';

	/** What the drag handle will let the sidebar be. The floor is core's own
	 *  #zotero-collections-pane minimum; the ceiling is the point past which a
	 *  pane of settings is wider than the graph it is settings for. */
	const SIDE_MIN = 200;
	const SIDE_MAX = 420;

	// Published by nodeScale.js, nodeLinks.js, nodeFilters.js, graphCluster.js
	// and graphGaps.js, which graph.html loads first.
	const Scale = ZGScale;
	const Links = ZGLinks;
	const Filters = ZGFilters;
	const Cluster = ZGCluster;
	const Gaps = ZGGaps;
	const Icons = ZGIcons;

	/**
	 * One string, from the .ftl chrome hands the page. Until that lands t()
	 * gives back the id it was asked for -- see l10n.js -- so nothing below has
	 * to check whether the strings have arrived before it can draw.
	 */
	const t = (id, args) => ZGL10n.t(id, args);

	// nodeFilters.js is pure and stays that way: it is handed the translator
	// rather than reaching for one, so the same file still runs under Node with
	// its own English labels.
	Filters.setTranslator(t);

	let fg = null;
	let raw = null;
	let nodeCache = new Map(); // id -> node object, so x/y survive a re-render
	// The node an incoming payload wants placed without disturbing the rest.
	// Consumed by render(); see holdStill().
	let anchorNext = null;
	let disabledVia = new Set();
	let yearRange = null;
	// The citation count that maps to the largest node: the 95th percentile of
	// what is on screen, not the maximum. Recomputed every render, because
	// filtering the graph should rescale it.
	let globalRef = 1;

	// What force-graph is currently holding on screen. Handing it new graphData
	// restarts its simulation, so render() compares against these to work out
	// whether it has to -- see updateGraph().
	let drawnStructure = null;    // node ids + every drawn edge property
	let drawnRadii = null;        // the radii the collision force was sized from
	let drawnNodes = [];          // the node array those two describe

	// View state for isolation. None of this filters the graph or reaches
	// chrome -- see setIsolated() for why it must not.
	//
	// A set rather than one id: isolating answers "what is around this paper",
	// and the question is often asked of two or three papers at once -- whether
	// their neighbourhoods overlap is exactly what you are looking at the graph
	// to find out.
	let isolated = new Set();     // focused node ids; empty means no isolation
	let isolateDepth = 1;         // how many edges out from a focus stays lit
	let litCache = null;          // see lit(); invalidated, never mutated
	let adjacency = new Map();    // node id -> Set of ids one edge away
	let hoverNode = null;         // whatever force-graph's hit test is over

	// View state for the highlight, kept apart from isolation because they are
	// different questions asked with different gestures. One id and not a set:
	// a highlight is "this one, and the lines out of it", which is only ever
	// about a single node -- see setHighlight().
	let highlighted = null;       // node id picked out, or null for none

	let el = id => document.getElementById(id);
	let elGraph = el('graph');
	let elStats = el('stats');
	let elStatus = el('status');
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
	let elLinkPull = el('link-pull');
	let elPullValue = el('pull-value');
	let elCenterPull = el('center-pull');
	let elCenterValue = el('center-value');
	let elAction = el('action');
	let elMenu = el('menu');
	let elIsolate = el('isolate-clear');
	let elIsolateDepth = el('isolate-depth');
	let elReframe = el('reframe');
	let elFrame = el('frame');
	let elSide = el('side');
	let elSideToggle = el('side-toggle');
	let elSideGrip = el('side-grip');
	let elSearch = el('search');
	let elSearchBox = el('search-box');
	let elSearchIcon = el('search-icon');
	let elSearchClear = el('search-clear');
	let elSearchSuggest = el('search-suggest');
	let elPaneToggle = el('pane-toggle');
	let elPanel = el('panel');
	let elPanelToggle = el('panel-toggle');
	let elLegend = el('legend');
	let elLegendToggle = el('legend-toggle');
	let elLegendTitle = el('legend-title');
	let elLegendBody = el('legend-body');
	let elEmpty = el('empty');
	let elEmptySub = el('empty-sub');
	let elEmptyRecursive = el('empty-recursive');
	let elFilterChips = el('filter-chips');
	let elFilterInput = el('filter-input');
	let elSuggest = el('filter-suggest');
	let elGroup = el('group');
	let elGroupInput = el('group-input');
	let elGroupChips = el('group-chips');
	let elGroupSub = el('group-sub');
	let elGroupTitle = el('group-title');
	let elGroupPull = el('group-pull');
	let elGroupPullValue = el('group-pull-value');

	/**
	 * Put the node a just-added paper will be drawn as where the ghost it
	 * replaces already stood.
	 *
	 * Chrome does not re-derive the graph for an add -- see adoptAdded() in
	 * lib/graphTab.js -- but the work does change key, and to force-graph a new
	 * id is a node with no coordinates. Left to the engine it lands near the
	 * origin and the layout has to fetch it, which is the whole re-anneal this
	 * exists to avoid.
	 *
	 * The ghost's own position is the first answer and the right one. With
	 * outside refs switched off there is no ghost on screen, so the second is the
	 * middle of the papers that cite it -- roughly where the layout would have
	 * taken it anyway.
	 *
	 * @returns {Boolean} whether it starts life somewhere meant, and so whether
	 *                    the layout can be held still around it
	 */
	function placeAdopted(adopted, edges) {
		let was = nodeCache.get(adopted.was);
		nodeCache.delete(adopted.was);
		if (nodeCache.has(adopted.now)) return false;

		let at = was && was.x != null ? was : citedFrom(edges, adopted.now);
		if (!at) return false;
		let n = { id: adopted.now, x: at.x, y: at.y, vx: 0, vy: 0 };
		// A pinned ghost becomes a pinned item: the pin was a statement about
		// where that work belongs, not about the key it wore.
		if (was && was.fx != null) n.fx = was.fx;
		if (was && was.fy != null) n.fy = was.fy;
		nodeCache.set(adopted.now, n);
		return true;
	}

	/** The middle of the nodes the incoming edges join `id` to, over the ones
	 *  already on screen. Null when none of them are. */
	function citedFrom(edges, id) {
		let x = 0;
		let y = 0;
		let seen = 0;
		for (let e of edges) {
			let other = e.from === id ? e.to : (e.to === id ? e.from : null);
			if (!other) continue;
			let n = nodeCache.get(other);
			if (!n || n.x == null) continue;
			x += n.x;
			y += n.y;
			seen++;
		}
		return seen ? { x: x / seen, y: y / seen } : null;
	}

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
			elStatus.textContent = t('bad-payload', { message: e.message });
			return;
		}
		let firstEdges = (!raw || !raw.edges.length) && next.edges.length;
		let adopted = next.meta && next.meta.adopted;
		anchorNext = adopted && placeAdopted(adopted, next.edges) ? adopted.now : null;
		raw = next;
		raw.external = raw.external || [];
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
		hideSuggest();
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

	/**
	 * Whether the item pane is there, and whether it is open.
	 *
	 * Both are chrome's facts and neither can be worked out here: the pane is a
	 * XUL element in the main window, and it is opened and collapsed by four
	 * different gestures -- a click on a node, "what is missing", core's own
	 * Toggle Item Pane in the pane's sidenav, and the button below. Pushed after
	 * every one of them (lib/graphTab.js), so the button in the bar says what
	 * the pane is actually doing rather than what it was last asked to do.
	 */
	window.zgSetPane = function (json) {
		let state;
		try {
			state = JSON.parse(json);
		}
		catch (e) {
			return;
		}
		setPaneOpen(!!state.has, !!state.open);
	};

	// An add that ended without a rebuild. The gap list disables a row's "+"
	// the moment it is pressed and gets it back from the rebuild that normally
	// follows; with no rebuild coming, this is what gives it back.
	window.zgAddSettled = function () {
		renderGaps();
	};

	/**
	 * The native node menu has gone away, whatever took it away. This is the
	 * hold's one way out on that path -- Escape, a click elsewhere, the window
	 * losing focus and picking an entry all end here -- so it is where the node
	 * carried into the menu is given back to the layout.
	 */
	window.zgMenuClosed = function () {
		nativeOpen = false;
		release();
	};

	/**
	 * One of this plugin's own entries was picked out of the native menu.
	 *
	 * Sent after zgMenuClosed, never before: "Pin node here" fixes the node
	 * where the hold is keeping it, and a release arriving afterwards would
	 * undo the pin it had just asked for. That is the same order this page's
	 * own menu rows run in.
	 */
	window.zgMenuPicked = function (id) {
		let run = nativeRuns.get(id);
		if (run) run();
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
		if (x.creators && x.creators.length) bits.push(escapeHtml(creatorList(x.creators)));
		if (x.year) bits.push(x.year);
		bits.push(t('tooltip-cited-here', { count: n.inDeg }));
		if (x.citedByGlobal != null) {
			bits.push(t('tooltip-citations-total', { count: x.citedByGlobal.toLocaleString() }));
		}
		if (isPinned(n)) bits.push(t('tooltip-pinned'));
		bits.push(t('tooltip-actions'));
		return t('tooltip-not-in-collection', { title: head }) + '<br/>' + bits.join(' · ');
	}

	/** The first few names, with the rest folded into an "et al." the locale
	 *  owns -- some languages abbreviate it differently, or not at all. */
	function creatorList(creators) {
		let head = creators.slice(0, 3).join(', ');
		return creators.length > 3 ? t('tooltip-et-al', { names: head }) : head;
	}

	/** Held items. Same two counts, same wording, so they read side by side. */
	function itemTooltip(n) {
		let bits = [];
		if (n.inDeg) bits.push(t('tooltip-cited-here', { count: n.inDeg }));
		if (n.citedByGlobal != null) {
			bits.push(t('tooltip-citations-total', { count: n.citedByGlobal.toLocaleString() }));
		}
		if (isPinned(n)) bits.push(t('tooltip-pinned'));
		bits.push(t('tooltip-actions'));
		return escapeHtml(n.name) + (n.year ? ' (' + n.year + ')' : '')
			+ '<br/>' + bits.join(' · ');
	}

	// --- colour -----------------------------------------------------------

	function colorKey(n) {
		switch (elColorBy.value) {
			case 'collection': return (n.collections || [])[0] || t('color-no-collection');
			// A paper sharing no reference with any other cannot be placed in a
			// subfield, and inventing one for it would be the one thing this
			// mode must not do.
			case 'cluster': return clusters().of.get(n.id) || t('color-no-cluster');
			case 'author': return (n.creators || [])[0] || t('color-no-author');
			case 'publication': return n.publication || t('color-no-publication');
			case 'type': return n.itemType || t('color-unknown-type');
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
	 * What the node colours mean right now, in the sidebar under the settings.
	 * "Which collection is the blue one" is a question you ask while reading
	 * the graph rather than while changing it, so it sits below the controls
	 * rather than among them -- but in the same column, because both are
	 * questions about the picture and neither is worth covering the picture up
	 * for.
	 *
	 * Rebuilt on every render, because every input to it moves: the colour
	 * mode, the year range, and which nodes survived the filters.
	 */
	// The same words the panel's "colour" menu offers, so the legend's title is
	// literally the sentence the user just made there.
	function colorModeName(mode) {
		return t('color-by-' + mode);
	}

	// Author and collection have long tails: a legend with two hundred rows is
	// a wall, and each row past this one explains a single node.
	const LEGEND_MAX = 12;

	function renderLegend(nodes) {
		let mode = elColorBy.value;
		// Titled as the sentence the user just made in the panel -- "coloured by
		// year" -- rather than the bare noun, so the legend says what it is a
		// legend FOR without the panel having to be open beside it.
		let title = t('legend-title', { mode: colorModeName(mode) });
		elLegendTitle.textContent = title;
		// One narrow line, and it ellipsises; the tooltip carries the rest.
		// For the subfields it carries something else as well: how good the
		// split actually is. Modularity under about 0.3 means the partition is
		// mostly the algorithm's invention rather than the library's structure,
		// and a reader colouring by it deserves to be able to find that out.
		let quality = mode === 'cluster' && clusters().count
			? t('legend-cluster-quality', {
				count: clusters().count,
				q: clusters().modularity.toFixed(2),
			})
			: null;
		elLegendTitle.title = quality ? title + ' -- ' + quality : title;
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
		if (ghosts) elLegendBody.appendChild(legendRow(GHOST_COLOR, t('legend-outside'), ghosts));

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

		if (undated) elLegendBody.appendChild(legendRow(NO_KEY_COLOR, t('legend-no-date'), undated));
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
			more.textContent = t('legend-more', { count: rest });
			elLegendBody.appendChild(more);
		}
	}

	function legendRow(color, label, count) {
		let row = document.createElement('div');
		row.className = 'legend-row';
		// The name is clipped to the panel width, so the whole of it has to be
		// reachable somewhere.
		row.title = t('legend-row-hint', { label, count });
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

	// --- the gap list -----------------------------------------------------

	/**
	 * The works the collection keeps citing and does not hold, ranked.
	 *
	 * The graph draws these already, as ghosts sized by how many of your papers
	 * cite them. What it cannot do is answer the question in one look: on the
	 * canvas the interesting ones sit somewhere in a cloud of several thousand,
	 * and filtering the cloud down far enough to read leaves you reading a
	 * graph where a list is what the question wants. So the same data, ranked,
	 * as a list.
	 *
	 * The ranking is not the raw count -- see graphGaps.js for why fame is
	 * divided out of it -- and the subfield attribution comes from the same
	 * partition the graph colours by, which is what lets a row say that seven
	 * papers of one subfield lean on something the library does not have.
	 *
	 * The LIST is chrome's, in the right-hand pane beside the item pane. The
	 * RANKING stays here, and that split is the only sensible one: ranking
	 * reads the believed edges, the external works, the cluster partition and
	 * the lookup checkbox, none of which chrome has, while drawing needs a XUL
	 * deck that this page cannot reach. So the page ranks and pushes rows, and
	 * chrome draws them and pushes the clicks back.
	 */
	/**
	 * Whether the list is the page currently showing in the pane.
	 *
	 * Set optimistically on the way out and then corrected by chrome, which is
	 * the side that actually knows: the deck is turned away from the list by a
	 * click on a node as readily as by the list's own close button, and neither
	 * of those starts here. The canvas menu reads this to decide whether it is
	 * offering to open the list or to put it away, and an answer that drifted
	 * would cost a click every time.
	 */
	let gapsOpen = false;

	window.zgGapsShowing = function (json) {
		try {
			gapsOpen = !!JSON.parse(json).showing;
		}
		catch (e) { /* leave it as it was */ }
	};

	function openGaps() {
		gapsOpen = true;
		// The list is built from the outside references, and the build only
		// derives those when they are asked for. Opening the list IS that
		// request -- the same bargain "size by global citations" strikes with
		// the lookup -- so it switches them on and rebuilds, rather than
		// opening an empty card next to a checkbox the user is left to find.
		if (!elIncludeExternal.checked) {
			elIncludeExternal.checked = true;
			requestRebuild();
		}
		emit({ type: 'gaps-open' });
		renderGaps();
	}

	function closeGaps() {
		if (!gapsOpen) return;
		gapsOpen = false;
		emit({ type: 'gaps-close' });
	}

	/**
	 * Rank, and push what came out.
	 *
	 * Pushed on every render, because every one of the ranking's inputs is
	 * something a render can have changed. Chrome drops the payload when its
	 * page is not showing, which is the same deal the item pane already has:
	 * the side that knows whether anything needs drawing is the side holding
	 * the pane.
	 */
	function renderGaps() {
		if (!gapsOpen) return;

		let ranked = raw
			? Gaps.rank(believedEdges(), raw.external, { clusterOf: clusters().of })
			: { rows: [], total: 0 };

		emit({
			type: 'gaps-rows',
			rows: ranked.rows,
			total: ranked.total,
			// A build still running has not read most of the PDFs yet, and
			// "nothing is missing" would be a lie until it has.
			building: !raw || !!(raw.meta && raw.meta.phase && raw.meta.phase !== 'done'),
			// Without the counts every gap is ranked at face value, which is
			// the plain "most cited here" order. Worth saying, since the
			// ranking is the reason to read this list rather than the graph.
			lookup: !!elEnrich.checked,
		});
	}

	/**
	 * The card that stands in for a graph when the collection produced no node.
	 *
	 * Driven by meta.empty rather than by items.length, so it only ever appears
	 * for a build that FINISHED empty -- a first payload on the way to a real
	 * graph carries no nodes either, and painting this over it would be a lie
	 * that lasts a second and reads as a bug.
	 */
	function renderEmpty() {
		let info = raw.meta && raw.meta.empty;
		elEmpty.hidden = !info;
		if (!info) return;
		// Worth offering only what is not already on: with subcollections
		// included, or with none to include, this button would change nothing.
		let offer = info.subcollections > 0 && !info.recursive;
		elEmptySub.hidden = !offer;
		elEmptyRecursive.hidden = !offer;
		if (offer) elEmptySub.textContent = t('empty-sub', { count: info.subcollections });
	}

	/**
	 * Light the papers that cite a gap, from a click on its row in the pane.
	 *
	 * The gap itself joins them when it is drawn, so the star reads as a star;
	 * with outside refs hidden it cannot, and what is left -- your own papers,
	 * lit together -- is still the answer to "who leans on this". Anything the
	 * filters have taken off screen is not isolated, because isolating a node
	 * nobody can see would dim the graph around nothing.
	 *
	 * The citers come back with the click rather than being looked up here:
	 * chrome is holding the ranked rows, and a second copy of them on this side
	 * could only ever come to disagree with the one being clicked.
	 */
	window.zgGapsIsolate = function (json) {
		let msg;
		try {
			msg = JSON.parse(json);
		}
		catch (e) {
			return;
		}
		let onScreen = new Set((drawnNodes || []).map(n => n.id));
		let ids = new Set();
		for (let key of (msg.citers || [])) if (onScreen.has(key)) ids.add(key);
		if (msg.key && onScreen.has(msg.key)) ids.add(msg.key);
		if (ids.size) setIsolated(ids);
	};


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

	// --- subfields --------------------------------------------------------

	/**
	 * Which subfield each held item belongs to, by bibliographic coupling.
	 *
	 * Two decisions worth stating, because both would be defensible the other
	 * way round and neither is visible in the output:
	 *
	 * It is computed over the WHOLE collection, not over what the masks have
	 * left on screen. A subfield is a property of a paper's place in the
	 * library, so filtering down to one author must not re-partition and
	 * recolour what survives -- and "cluster:" is itself a mask, which would
	 * otherwise be asking the partition to describe the partition.
	 *
	 * It does honour the confidence slider and the strategy toggles, because
	 * those change which edges are believed at all, and a partition drawn from
	 * edges the user has switched off would describe a graph nobody is looking
	 * at.
	 *
	 * Memoised on exactly those inputs: itemFacets() runs this per item per
	 * keystroke in the filter box, and Louvain over a few hundred nodes is not
	 * something to redo between two characters.
	 */
	let clusterMemo = { raw: null, sig: null, result: null };
	const NO_CLUSTERS = { of: new Map(), sizes: new Map(), count: 0, unassigned: 0, modularity: 0 };

	function clusters() {
		if (!raw) return NO_CLUSTERS;
		let sig = believedSig();
		if (clusterMemo.raw === raw && clusterMemo.sig === sig) return clusterMemo.result;
		let result = Cluster.cluster(believedEdges(), raw.items, {
			fallbackLabel: i => t('color-cluster-n', { n: i + 1 }),
		});
		clusterMemo = { raw, sig, result };
		return result;
	}

	/**
	 * The edges the user currently believes: everything the build derived, less
	 * what the confidence slider and the strategy toggles disown.
	 *
	 * Shared by the two analyses that read the whole collection rather than
	 * what the masks left on screen -- the subfields above and the gap list
	 * below -- and memoised on the same signature they are, because both are
	 * asked for it repeatedly per render.
	 */
	let believedMemo = { raw: null, sig: null, edges: null };

	function believedSig() {
		return elMinConf.value + '|' + [...disabledVia].sort().join(',');
	}

	function believedEdges() {
		if (!raw) return [];
		let sig = believedSig();
		if (believedMemo.raw === raw && believedMemo.sig === sig) return believedMemo.edges;
		let minConf = Number(elMinConf.value);
		let edges = raw.edges.filter(e => e.confidence >= minConf
			&& e.via.some(v => !disabledVia.has(v)));
		believedMemo = { raw, sig, edges };
		return edges;
	}

	// --- filter masks -----------------------------------------------------

	/** A raw item in the shape nodeFilters.js matches against. */
	function itemFacets(it) {
		return Filters.facets({
			creators: it.creators,
			tags: it.tags,
			cluster: clusters().of.get(it.key),
			year: year(it),
			itemType: it.itemType,
			publication: it.publication,
			collections: it.collections,
			title: it.title,
		});
	}

	/** The chip is clipped to the panel width, so the long form -- every value,
	 *  and which of them are exact -- has to be reachable on hover. */
	function chipHint(f) {
		let what = f.field ? Filters.fieldLabel(f.field) : t('field-any');
		let bits = f.terms.map((term) => {
			if (term.op === 'range') {
				if (term.lo != null && term.hi != null) {
					return term.lo === term.hi
						? t('chip-is', { value: term.lo })
						: t('chip-between', { lo: term.lo, hi: term.hi });
				}
				return term.lo != null
					? t('chip-or-later', { year: term.lo })
					: t('chip-or-earlier', { year: term.hi });
			}
			return t(term.op === 'is' ? 'chip-is-exactly' : 'chip-contains', { value: term.value });
		});
		// "or", because terms widen. It is the chips between them that narrow.
		return what + ' ' + bits.join(t('chip-or-join')) + '\n' + t('chip-click-to-edit');
	}

	/**
	 * A stack of masks: the box that authors them, the chips that show them,
	 * and the completion list they share.
	 *
	 * Two of these exist, and they differ in one thing only -- what the masks
	 * are FOR. The panel's stack decides what is DRAWN; a group's decides what
	 * that group's anchor PULLS. Every gesture in between is the same in both
	 * places: commit the box into a chip, widen that chip with the next pick,
	 * click a chip to edit it back into the box, backspace to lift the last
	 * one. Which is why this is a factory rather than a second copy of it.
	 *
	 * An owner supplies its two elements, what to do when the stack changes,
	 * and `candidates(skip)` -- the facets completions are drawn from, with one
	 * mask left out because that is the one about to be widened.
	 */
	function filterBox({ input, chips, candidates, onChange }) {
		/**
		 * The masks currently laid down, oldest first. AND commutes, so the
		 * order carries no meaning -- it is kept only so a chip does not jump
		 * around when another one is removed.
		 */
		let filters = [];

		/**
		 * Which chip the box is currently authoring, or -1 for none.
		 *
		 * A mask holds several values that OR, so building one is not a single
		 * gesture: pick "Nature", then "Science", then "APL". Rather than make
		 * the user finish the list before seeing anything, the chip is
		 * committed on the first pick and then rewritten in place on every one
		 * after -- what the masks control widens under the pointer as the list
		 * grows. This index is what says "rewrite" instead of "add a second
		 * chip".
		 */
		let editing = -1;

		let box = {
			input,
			filters: () => filters,
			candidates: () => candidates(editing),
			commit,
			/** Take a stack this box did not author -- reopening a group's. */
			load(fs) {
				filters = fs.slice();
				endEdit();
				renderChips();
			},
		};

		/**
		 * Whatever is in the box becomes a mask: a new chip, or the one being
		 * edited rewritten in place.
		 */
		function commit() {
			let f = Filters.parse(input.value);
			if (!f) return;
			if (editing >= 0) {
				filters[editing] = f;
			}
			else {
				let k = Filters.key(f);
				// Laying down a mask that is already down would look like the box
				// swallowed the input. Edit the one that exists instead.
				let same = filters.findIndex(x => Filters.key(x) === k);
				editing = same >= 0 ? same : filters.push(f) - 1;
			}
			renderChips();
			onChange();
		}

		/** The box is done with whatever it was authoring. The chip keeps every
		 *  term that was committed; a half-typed one was never part of it. */
		function endEdit() {
			editing = -1;
			input.value = '';
		}

		function removeFilter(i) {
			filters.splice(i, 1);
			if (editing === i) endEdit();
			else if (editing > i) editing--;
			renderChips();
			onChange();
		}

		/**
		 * Put a chip back in the box with a trailing comma, ready for more
		 * values. This is the only way to reach a value that the chip's own
		 * width has clipped, and the only way to drop one value out of several.
		 */
		function editChip(i) {
			editing = i;
			input.value = Filters.toInput(filters[i]) + ', ';
			input.focus();
			refreshSuggest(box);
		}

		function renderChips() {
			chips.textContent = '';
			filters.forEach((f, i) => {
				let chip = document.createElement('span');
				chip.className = 'chip';
				if (i === editing) chip.classList.add('editing');
				let text = document.createElement('button');
				text.type = 'button';
				text.className = 'chip-text';
				text.title = chipHint(f);
				text.textContent = Filters.describe(f);
				text.addEventListener('click', () => editChip(i));
				let x = document.createElement('button');
				x.type = 'button';
				x.className = 'chip-x';
				x.textContent = '✕';
				x.title = t('chip-remove');
				x.addEventListener('click', () => removeFilter(i));
				chip.appendChild(text);
				chip.appendChild(x);
				chips.appendChild(chip);
			});
			chips.hidden = !filters.length;
		}

		input.addEventListener('input', () => refreshSuggest(box));
		// On focus too, and with an empty box: with nothing typed the list is the
		// only thing that says which fields exist at all.
		input.addEventListener('focus', () => refreshSuggest(box));
		// After the row's own mousedown, which fires first and may have accepted.
		// Leaving the box ends the edit: everything committed is on the chip
		// already, so there is nothing in the text worth keeping.
		input.addEventListener('blur', () => window.setTimeout(() => {
			hideSuggest();
			if (editing >= 0) {
				endEdit();
				renderChips();
			}
		}, 0));

		input.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				if (elSuggest.hidden) refreshSuggest(box);
				moveSuggest(e.key === 'ArrowDown' ? 1 : -1);
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				// On a highlighted row, take it and stay on this mask -- the next
				// Enter can add another value. On typed text, commit and be done.
				if (suggestIndex >= 0) {
					accept(suggestIndex);
					return;
				}
				commit();
				endEdit();
				hideSuggest();
				renderChips();
				return;
			}
			if (e.key === 'Escape') {
				// Inside a box, Escape belongs to the list first and then to the
				// box, and must not reach the window handler past either. Once
				// there is nothing left in here for it to close it is let
				// through, so a card holding one of these can still be shut
				// with the key that shuts everything else.
				if (!elSuggest.hidden) {
					e.stopPropagation();
					hideSuggest();
				}
				else if (editing >= 0) {
					e.stopPropagation();
					endEdit();
					renderChips();
				}
				else if (input.value) {
					e.stopPropagation();
					input.value = '';
				}
				return;
			}
			// Backspace on an empty box lifts the last mask -- the gesture everyone
			// already has from every other chips-in-front-of-an-input there is.
			if (e.key === 'Backspace' && !input.value && filters.length) {
				removeFilter(filters.length - 1);
			}
		});

		renderChips();
		return box;
	}

	// --- the completion list ----------------------------------------------

	// A list taller than this is a wall, not a menu.
	const SUGGEST_MAX_PX = 240;

	// One list, shared by every box there is: only one of them can hold the
	// focus, and the list belongs to whichever that is.
	let suggestBox = null;
	let suggestions = [];
	// -1 means nothing is highlighted, which is a state in its own right:
	// Enter then commits whatever was typed rather than a row.
	let suggestIndex = -1;

	/**
	 * Rebuild the list under a box.
	 *
	 * The candidates come from what that box's owner says is available, never
	 * from the whole collection -- for the panel, the items that survive its
	 * other masks. That is what makes the list narrow as chips stack, and it
	 * means anything offered there is guaranteed to leave something on screen
	 * rather than emptying the graph.
	 */
	function refreshSuggest(box) {
		if (!raw) return;
		suggestBox = box;
		suggestions = Filters.suggest(box.input.value, box.candidates());
		suggestIndex = -1;
		elSuggest.textContent = '';
		for (let i = 0; i < suggestions.length; i++) {
			elSuggest.appendChild(suggestRow(suggestions[i], i));
		}
		let open = suggestions.length > 0;
		elSuggest.hidden = !open;
		box.input.setAttribute('aria-expanded', open ? 'true' : 'false');
		// Only once it is visible: placing it needs its height.
		if (open) placeSuggest();
	}

	/**
	 * Put the list against the box it completes.
	 *
	 * It lives outside #panel, which clips, so nothing positions it for free --
	 * see the comment on it in graph.html. It opens downward, flips above the
	 * box when the room below is worse, and is capped to whichever side it took
	 * so it can never run off the window.
	 */
	function placeSuggest() {
		let r = suggestBox.input.getBoundingClientRect();
		let below = window.innerHeight - r.bottom - 8;
		let above = r.top - 8;
		let down = below >= above;
		elSuggest.style.maxHeight = Math.max(80, Math.min(SUGGEST_MAX_PX, down ? below : above)) + 'px';
		elSuggest.style.left = r.left + 'px';
		elSuggest.style.width = r.width + 'px';
		elSuggest.style.top = (down ? r.bottom + 2 : Math.max(4, r.top - elSuggest.offsetHeight - 2)) + 'px';
	}

	function hideSuggest() {
		elSuggest.hidden = true;
		suggestIndex = -1;
		if (suggestBox) suggestBox.input.setAttribute('aria-expanded', 'false');
	}

	function suggestRow(s, i) {
		let b = document.createElement('button');
		b.type = 'button';
		b.className = 'suggest-item';
		b.setAttribute('role', 'option');
		if (s.hint) b.title = s.hint;
		let label = document.createElement('span');
		label.className = 'suggest-label';
		label.textContent = s.label;
		b.appendChild(label);
		// Which facet a value came from: a bare search spans all of them, and
		// Nature the journal is not Nature the collection.
		if (s.kind === 'value') {
			let f = document.createElement('span');
			f.className = 'suggest-field';
			f.textContent = s.hint;
			b.appendChild(f);
		}
		if (s.count != null) {
			let c = document.createElement('span');
			c.className = 'suggest-count';
			c.textContent = s.count;
			b.appendChild(c);
		}
		// mousedown rather than click: the input's own blur fires first and
		// would have torn the list down before a click could land on it.
		b.addEventListener('mousedown', (e) => {
			e.preventDefault();
			accept(i);
		});
		return b;
	}

	/**
	 * Take a completion. A value is spliced into the box and committed at once,
	 * so the chip and whatever it controls both move on the first pick -- and
	 * the box is left with a trailing comma and the list still open, so the
	 * pick after it widens the same mask instead of starting a new one.
	 */
	function accept(i) {
		let s = suggestions[i];
		if (!s || !suggestBox) return;
		let box = suggestBox;
		// A field name is only half a filter. Put it in the box and let the
		// list come straight back with that field's values.
		if (s.insert) {
			box.input.value = s.insert;
			refreshSuggest(box);
			return;
		}
		box.input.value = Filters.spliceTerm(box.input.value, s.field, s.term);
		box.commit();
		refreshSuggest(box);
	}

	function moveSuggest(d) {
		let n = suggestions.length;
		if (!n) return;
		suggestIndex = suggestIndex < 0
			? (d > 0 ? 0 : n - 1)
			: (suggestIndex + d + n) % n;
		let rows = elSuggest.children;
		for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('active', i === suggestIndex);
		if (rows[suggestIndex]) rows[suggestIndex].scrollIntoView({ block: 'nearest' });
	}

	// The list is positioned against the box, and the panel it sits in scrolls
	// independently of it -- so a scroll would leave it stranded. Dismiss rather
	// than chase: it is one keystroke away from coming back.
	el('panel-body').addEventListener('scroll', hideSuggest);

	// --- the panel's masks ------------------------------------------------

	/**
	 * The held items surviving every mask, with their facets alongside -- the
	 * graph needs the items and the completion list needs the facets, and
	 * deriving them separately would mean two rules for what is visible.
	 *
	 * `skip` leaves one mask out. The completion list passes the chip being
	 * edited, because that chip is about to be widened: constraining the
	 * candidates by a mask whose terms OR would hide exactly the values the
	 * user is reaching for. The graph itself skips nothing.
	 *
	 * Outside references are deliberately NOT masked here. A ghost is a DOI
	 * and, with lookup on, a title; masking it on author or publication would
	 * delete every one of them the moment any filter existed. Instead it keeps
	 * the treatment it already had -- a ghost is drawn when a held item that
	 * survived still cites it -- which makes "author:Kucsko" read as "his
	 * papers, and what they cite".
	 */
	function masked(skip) {
		let items = [];
		let facets = [];
		let filters = panelBox.filters();
		for (let it of raw.items) {
			let f = itemFacets(it);
			let ok = true;
			for (let i = 0; i < filters.length && ok; i++) {
				if (i !== skip && !Filters.matches(filters[i], f)) ok = false;
			}
			if (!ok) continue;
			items.push(it);
			facets.push(f);
		}
		return { items, facets };
	}

	let panelBox = filterBox({
		input: elFilterInput,
		chips: elFilterChips,
		candidates: skip => masked(skip).facets,
		// These masks decide what is on screen at all, so a change to them is a
		// change to the graph itself.
		onChange: render,
	});

	// --- rendering --------------------------------------------------------

	function render() {
		if (!raw) return;
		let minConf = Number(elMinConf.value);
		elConfValue.textContent = minConf.toFixed(2);
		let minCites = Math.max(1, Number(elMinCites.value) || 1);
		let showGhosts = elIncludeExternal.checked && raw.external.length > 0;

		// Identity, not visibility: this is what tells a held item apart from an
		// outside reference, and a masked-out paper must not turn into a ghost of
		// itself. `shown` is the visibility half.
		let inCollection = new Set(raw.items.map(i => i.key));
		let { items: held, facets: heldFacets } = masked(-1);
		let shown = new Set(held.map(i => i.key));

		// 1. Edges surviving the confidence, strategy and mask filters. An edge
		//    with a masked-out end is gone in both directions: it can neither
		//    keep a ghost alive nor draw itself to a node nobody can see.
		let candidates = [];
		for (let e of raw.edges) {
			if (e.confidence < minConf) continue;
			if (!shown.has(e.from)) continue;
			if (inCollection.has(e.to) && !shown.has(e.to)) continue;
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
		for (let it of held) {
			let y = year(it);
			if (y) years.push(y);
		}
		yearRange = years.length ? [Math.min(...years), Math.max(...years)] : null;

		let nodes = [];
		// Facets for the nodes that end up drawn, kept for the groups: an
		// anchor is re-matched whenever it moves or its masks change, which is
		// far more often than the graph is rebuilt, and rebuilding a facet set
		// per keystroke to answer it would be absurd.
		facetCache = new Map();
		for (let i = 0; i < held.length; i++) {
			let it = held[i];
			let deg = (inDegree[it.key] || 0) + (outDegree[it.key] || 0);
			if (elHideIsolated.checked && !deg) continue;
			facetCache.set(it.key, heldFacets[i]);
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
			n.publication = it.publication || null;
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

		// A filter change or a rebuild can take a focused or highlighted node
		// off screen. A focus on a node that is not drawn would dim the graph
		// around nothing, and a highlight on one would leave a handful of edges
		// lit with nothing at the end of them.
		if (isolated.size || highlighted != null) {
			let onScreen = new Set(nodes.map(n => n.id));
			for (let id of isolated) if (!onScreen.has(id)) isolated.delete(id);
			if (highlighted != null && !onScreen.has(highlighted)) highlighted = null;
		}
		// The adjacency lit() walks has just been rebuilt out of these edges.
		litCache = null;
		syncIsolateNote();
		// Which nodes each anchor pulls, against the set that is now on screen.
		assignGroups();
		syncGroupNote();

		if (!fg) {
			fg = ForceGraph()(elGraph);
			// One click asks what this paper is: it picks the node and its own
			// edges out of the picture AND describes the item in the pane
			// beside the graph. Both halves answer the same question, one about
			// what it is connected to and one about what it is, so they are one
			// gesture. It is the cheap half of the pair on purpose -- nothing
			// else on screen changes, so a stray click while panning costs a
			// ring rather than a graph you have to undim. Isolating, which does
			// change the whole picture, is the double click.
			fg.onNodeClick((n) => {
				if (spentPress()) return;
				toggleHighlight(n.id);
				showItemPane(n);
			});
			fg.onNodeRightClick(showMenu);
			fg.onNodeHover((n) => {
				hoverNode = n;
			});
			// Which node the pointer is carrying, for the guard below. Both
			// fire on the same condition -- force-graph raises neither until
			// the pointer has moved 5px -- so the flag cannot be left set by a
			// drag that never really started.
			fg.onNodeDrag((n) => {
				dragNode = n;
			});
			fg.onNodeDragEnd((n) => {
				dragNode = null;
				if (!menuOnDrop) return;
				let event = menuOnDrop;
				menuOnDrop = null;
				// Built first, while the node is merely dropped: the entry has
				// to read "Pin node here", and it would say "Unpin" if the hold
				// below were already on. Nothing ticks in between -- both run
				// inside the mouseup -- so the node cannot move between them.
				showMenu(n, event);
				if (!isPinned(n)) hold(n);
				// The left button is still down -- the press that began the
				// drag outlives the gesture it started. See spentPress().
				menuPress = !!(event.buttons & 1);
			});
			// Clicking empty canvas dismisses, the way a popover should, and
			// gives the whole graph back.
			fg.onBackgroundClick(() => {
				if (spentPress()) return;
				hideAction();
				hideMenu();
				clearHighlight();
				clearIsolated();
			});
			fg.onBackgroundRightClick(showCanvasMenu);
			// A settle sheds its alpha tick by tick and ends when the engine
			// stops -- see settle().
			fg.onEngineTick(shed);
			// Nothing to do at the end of an ordinary cooldown; this is the
			// safety net for a settle whose shed never finishes. See settle().
			fg.onEngineStop(thaw);

			// Every accessor below is a closure over live state and re-read on
			// each redraw, so these are set once and never touched again. That
			// is not merely tidiness: nodeId is one of the handful of props
			// force-graph re-initialises its whole engine for, so re-setting
			// the chain per render reheated the layout all by itself.
			fg.nodeId('id')
				.nodeLabel(n => (n.ghost ? ghostTooltip(n) : itemTooltip(n)))
				.nodeRelSize(NODE_REL_SIZE)
				.nodeVal(nodeVal)
				.nodeColor(nodeColor)
				.nodeCanvasObjectMode(() => 'after')
				.nodeCanvasObject(drawNode)
				.linkDirectionalArrowLength(4)
				.linkDirectionalArrowRelPos(1)
				.linkCurvature(0.08)
				.linkLabel(l => l.via.join(', ') + (l.doi ? ' — ' + escapeHtml(l.doi) : ''))
				// Colour by the strongest strategy backing the edge, so a
				// publisher's own DOI link reads differently from an inferred
				// title match. A highlighted node's own edges give up the
				// alpha that says how well attested they are and go to full
				// strength: what is being asked of them is which lines touch
				// this node, and the hue still answers the other question.
				.linkColor(l => withAlpha(viaColor(bestVia(l.via)),
					(highlightedLink(l)
						? HL_LINK_ALPHA
						: l.confidence >= ASSERTED ? 0.85 : 0.45)
					* (dimmedLink(l) ? DIM_LINK_FACTOR : 1)))
				.linkWidth(l => (l.confidence >= ASSERTED ? 1.4 : 0.8)
					* (highlightedLink(l) ? HL_LINK_WIDTH : 1))
				// After the graph, so a flag is never buried under the cluster
				// it gathered.
				.onRenderFramePost(drawGroups)
				.d3VelocityDecay(0.3);

			// d3 re-initialises every registered force whenever the node array
			// is replaced, so these pick up new nodes and new radii on their
			// own and only ever need registering once.
			fg.d3Force('centerPull', centerPull());
			fg.d3Force('groupPull', groupPull());
			fg.d3Force('collide', collide());
			// force-graph registers 'link' itself, so this reaches in and
			// reprices it rather than replacing it -- the arrows, curvature and
			// endpoint resolution all belong to that force.
			fg.d3Force('link').strength(linkStrength);
		}

		// The pane can be resized without a window resize event -- a Zotero
		// layout change, or the tab coming back into view.
		fg.width(elGraph.clientWidth).height(elGraph.clientHeight);

		updateGraph(nodes, links);
		// After updateGraph, which is what handed force-graph the changed node
		// set and so what set the layout alight.
		if (anchorNext) {
			holdStill(anchorNext);
			anchorNext = null;
		}
		renderLegend(nodes);
		// Rebuilt with the graph rather than only when opened: a build phase
		// landing, a strategy switched off or a paper added all change what is
		// missing, and a stale list would be a list of the wrong papers.
		renderGaps();
		renderEmpty();

		let phase = raw.meta && raw.meta.phase;
		let ghostCount = visibleGhosts.size;
		let named = 0;
		for (let [, { x }] of visibleGhosts) if (x.title) named++;
		// Fragments joined with a separator rather than one sentence: three of
		// the four are conditional, and a message with three holes that are
		// usually empty is not a thing anyone can translate.
		let stats = [t('stats-items', { shown: nodes.length - ghostCount, total: raw.items.length })];
		if (ghostCount) {
			stats.push(t('stats-outside', { count: ghostCount })
				+ (named ? ' ' + t('stats-named', { count: named }) : ''));
		}
		stats.push(t('stats-edges', { count: links.length }));
		if (phase && phase !== 'done') stats.push(t('stats-building'));
		elStats.textContent = stats.join(' · ');
	}

	/**
	 * Give force-graph the part of the new graph that actually changed.
	 *
	 * graphData is the one prop it re-initialises its engine for: setting it
	 * runs `forceLayout.stop().alpha(1)`, which re-anneals the whole layout
	 * from full temperature. Reusing the node objects (see nodeCache) carries
	 * their coordinates across, but a re-annealed layout drifts off them within
	 * a second anyway -- so recolouring the graph, or writing looked-up names
	 * onto it, used to move every node on screen to report a change that had
	 * touched neither a position nor an edge.
	 *
	 * Three tiers, cheapest first:
	 *
	 *  nothing structural   Repaint in place. Node objects are mutated by
	 *                       render(), so new names and new tooltips are already
	 *                       on them; all that is missing is a redraw.
	 *  radii changed        Re-register the collision force, which caches the
	 *                       radii it was built with, and reheat. Sizing by
	 *                       global citations is the case that matters: the
	 *                       counts arrive with the looked-up names and every
	 *                       circle changes size, so the layout genuinely has to
	 *                       resolve overlaps that did not exist before.
	 *  nodes or edges       The real thing.
	 */
	function updateGraph(nodes, links) {
		let structure = structureSig(nodes, links);
		let radii = radiiSig(nodes);
		let movedStructure = structure !== drawnStructure;
		let movedRadii = radii !== drawnRadii;
		drawnStructure = structure;
		drawnRadii = radii;
		drawnNodes = nodes;

		// A settle fixes the graph for a frame or two; a reheat landing inside
		// that window has to lift the freeze first, or it would lay the graph
		// out around a hundred nodes nailed to their old positions.
		if (movedStructure || movedRadii) thaw();

		if (movedStructure) {
			fg.graphData({ nodes, links });
			return;
		}
		// Skipping graphData leaves force-graph holding the previous link
		// objects. That is safe precisely because the signature covers every
		// field anything reads off them: identical signature, interchangeable
		// arrays -- and the old ones have their endpoints already resolved.
		if (movedRadii) {
			fg.d3Force('collide', collide()).d3ReheatSimulation();
			return;
		}
		repaint();
	}

	// A separator no key, DOI or strategy name can contain.
	const SIG_SEP = String.fromCharCode(1);

	/**
	 * Everything a new graphData would tell force-graph that it does not
	 * already know: which nodes are on screen, and every edge property that is
	 * drawn or that the layout prices. Taken from the fresh arrays, before
	 * force-graph resolves link endpoints from ids to node objects.
	 */
	function structureSig(nodes, links) {
		let out = [];
		for (let node of nodes) out.push(node.id);
		out.push('|');
		for (let l of links) {
			out.push(l.source + '>' + l.target + ':' + l.confidence
				+ ':' + l.via.join('+') + ':' + (l.doi || ''));
		}
		return out.join(SIG_SEP);
	}

	/** The other thing the layout is built from. Rounded, because a radius that
	 *  differs in the fourth decimal moves nothing anyone can see. */
	function radiiSig(nodes) {
		let out = [];
		for (let node of nodes) out.push(nodeRadius(node).toFixed(2));
		return out.join(',');
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
	 *  global citations how often the whole literature cites it. Switches "look
	 *                  up names" on when picked, because that is where the
	 *                  counts come from. Area is proportional to the count up
	 *                  to the 95th percentile of what is on screen, then
	 *                  logarithmic above it, so one landmark paper cannot
	 *                  flatten the rest.
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
	 * off screen. The panel scales both together, so the ratio between them --
	 * which is what keeps orphans in a ring rather than in the middle -- is not
	 * something the slider can get wrong.
	 */
	const PULL = 0.02;
	const PULL_ORPHAN = 0.15;

	/** The panel's multiplier over both. Read live rather than cached: unlike a
	 *  link strength, nothing downstream holds a copy of this. */
	function centerScale() {
		let v = Number(elCenterPull.value);
		return Number.isFinite(v) ? v : 1;
	}

	function centerPull() {
		let nodes = [];
		function force(alpha) {
			// Once per tick, not once per node: it cannot change mid-tick, and at
			// zero there is nothing for the loop to add.
			let scale = centerScale();
			if (!scale) return;
			for (let n of nodes) {
				// A node with an anchor has somewhere to be, and the centre is
				// not it. Left in, the two pulls would fight and park it short
				// of the flag -- a group planted out at the rim would gather a
				// cluster that visibly sags towards the middle.
				if (groupOf.has(n.id)) continue;
				let k = (n.deg ? PULL : PULL_ORPHAN) * scale * alpha;
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
	 * Pull every grouped node to the point its group was planted at.
	 *
	 * Firm by default, an order of magnitude past the centre pull, because this
	 * is not a tendency but an instruction: the user said these papers belong
	 * here. It still competes with the links, which is the whole interest of it
	 * -- a group that drags a paper away from its citations stretches the edges
	 * between them, and how far they stretch is the picture being asked for. How
	 * hard it pulls is the group's own, set on its card, because that trade is
	 * the thing being looked at and where it should sit differs per anchor: a
	 * firm one states where these papers go, a slack one asks how far they are
	 * willing to travel and lets their citations answer.
	 *
	 * Pinned nodes are unaffected, since d3 stops integrating a node with fixed
	 * coordinates at all. That is the right precedence: a pin is a position the
	 * user placed by hand, and a mask should not overrule it.
	 */
	const GROUP_PULL = 0.4;

	/**
	 * The ceiling on the pull one node can feel from every anchor holding it.
	 *
	 * A node moves by k * (1 - velocityDecay) of the way to its target each
	 * tick, and the engine runs at a decay of 0.3 -- so past about 1.4 the step
	 * overshoots by more than the damping takes back and the node rings around
	 * the flag forever instead of arriving. Capped on the sum rather than on
	 * each slider, because it is the sum a node actually feels.
	 */
	const GROUP_PULL_MAX = 1;

	function groupPull() {
		let nodes = [];
		function force(alpha) {
			if (!groupOf.size) return;
			for (let n of nodes) {
				let at = groupOf.get(n.id);
				if (!at) continue;
				n.vx += (at.x - n.x) * at.k * alpha;
				n.vy += (at.y - n.y) * at.k * alpha;
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
	 * Edge attraction, as a multiplier over d3's own per-link strength.
	 *
	 * d3 gives a link 1 / min(deg a, deg b), so a hub is not torn apart by the
	 * many edges hanging off it. That default is tuned for sparse graphs: a
	 * densely cited collection packs into tight balls, because every edge pulls
	 * at full strength while charge repulsion falls off with distance. Scaling
	 * the whole set trades cohesion for room -- at 0 the links hold nothing and
	 * the layout is left to repulsion and the centre pull, which is what an
	 * over-packed graph needs before it can be read.
	 *
	 * Degrees are counted from the link array d3 hands in, not from n.deg:
	 * n.deg describes the item, and would misprice a node whose edges the
	 * filters have mostly taken away.
	 */
	let pullLinks = null;         // link array the degrees below were counted from
	let pullDeg = new Map();      // node object -> its degree within that array

	function linkStrength(link, i, links) {
		if (links !== pullLinks) {
			pullLinks = links;
			pullDeg = new Map();
			for (let l of links) {
				pullDeg.set(l.source, (pullDeg.get(l.source) || 0) + 1);
				pullDeg.set(l.target, (pullDeg.get(l.target) || 0) + 1);
			}
		}
		let deg = Math.min(pullDeg.get(link.source) || 1, pullDeg.get(link.target) || 1);
		return Number(elLinkPull.value) / deg;
	}

	/**
	 * Reinstalling the function is what makes the new value take: d3 evaluates
	 * link strengths once, when the force is initialised, and caches them.
	 */
	function applyLinkPull() {
		elPullValue.textContent = Number(elLinkPull.value).toFixed(2);
		if (!fg) return;
		let link = fg.d3Force('link');
		if (link) link.strength(linkStrength);
		fg.d3ReheatSimulation();
	}

	/**
	 * The centre pull needs no such reinstalling -- the force reads the slider
	 * on every tick. All a change needs is for the layout to be moving when it
	 * does, which a cooled graph is not.
	 */
	function applyCenterPull() {
		elCenterValue.textContent = centerScale().toFixed(2);
		if (!fg) return;
		fg.d3ReheatSimulation();
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

	function drawNode(node, ctx, globalScale) {
		drawHighlight(node, ctx, globalScale);
		drawPin(node, ctx, globalScale);
		drawLabel(node, ctx, globalScale);
	}

	/**
	 * The highlighted node wears a ring in the accent colour, outside where a
	 * pin's ring goes so that a node which is both still reads as both.
	 *
	 * A ring rather than a recoloured fill, for the reason the pin's is: the
	 * fill already means whatever the panel is colouring by, and a highlight
	 * must not take that hue away from the one node you are looking hardest at.
	 *
	 * Faded with the rest when isolation has dimmed it, exactly as drawPin is.
	 * Highlighting a node outside the isolated neighbourhood is a fair thing to
	 * do -- it is how you check whether something over there connects in -- and
	 * a ring at full strength on a node that is otherwise a ghost would read as
	 * the isolation having lost track of itself.
	 */
	const HL_RING_GAP = 5.5;   // screen px between the node edge and the ring
	const HL_RING_WIDTH = 2;   // screen px

	function drawHighlight(node, ctx, globalScale) {
		if (!isHighlighted(node)) return;
		let theme = themeColors();
		ctx.beginPath();
		ctx.arc(node.x, node.y, nodeRadius(node) + HL_RING_GAP / globalScale,
			0, 2 * Math.PI);
		ctx.lineWidth = HL_RING_WIDTH / globalScale;
		ctx.strokeStyle = dimmed(node) ? fade(theme.accent, DIM_NODE_ALPHA) : theme.accent;
		ctx.stroke();
	}

	/**
	 * A pinned node wears a ring just outside its circle, in the label colour.
	 * Drawn rather than recoloured: the fill already means whatever the panel
	 * is colouring by, and pinning must not take a hue away from it.
	 *
	 * Sized in screen pixels like the label, so the ring stays a hairline at
	 * any zoom instead of swelling with the node.
	 */
	const PIN_RING_GAP = 2.5;   // screen px between the node edge and the ring
	const PIN_RING_WIDTH = 1.5; // screen px

	function drawPin(node, ctx, globalScale) {
		if (!isPinned(node)) return;
		let theme = themeColors();
		ctx.beginPath();
		ctx.arc(node.x, node.y, nodeRadius(node) + PIN_RING_GAP / globalScale,
			0, 2 * Math.PI);
		ctx.lineWidth = PIN_RING_WIDTH / globalScale;
		ctx.strokeStyle = dimmed(node) ? fade(theme.fg, DIM_NODE_ALPHA) : theme.fg;
		ctx.stroke();
	}

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
				accent: get('--accent', '#0a67c2'),
			};
		}
		return _theme;
	}
	if (window.matchMedia) {
		window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
			_theme = null;
			repaint();
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

	// --- highlight --------------------------------------------------------

	/**
	 * Pick one node and the edges out of it out of the picture: the node gets a
	 * ring, its own edges are drawn at full strength, and nothing else on
	 * screen changes at all.
	 *
	 * That last part is the whole design. This is the gesture a single click
	 * makes, so it is made constantly and half of those are made by accident
	 * while panning a dense graph -- which means it has to be free to undo and
	 * free to ignore. Isolation, which repaints the entire graph into a wash,
	 * is behind the double click for the same reason.
	 *
	 * Like isolation, it touches nothing but the repaint: no filtering, no
	 * graphData, so the layout never resettles and the node stays where your
	 * eye left it.
	 */
	function setHighlight(id) {
		if (highlighted === id) return;
		highlighted = id;
		repaint();
	}

	function clearHighlight() {
		if (highlighted != null) setHighlight(null);
	}

	/** Clicking the highlighted node again puts it back, which is the only way
	 *  out of a highlight that does not involve clicking the canvas. */
	function toggleHighlight(id) {
		setHighlight(highlighted === id ? null : id);
	}

	function isHighlighted(n) {
		return highlighted != null && n.id === highlighted;
	}

	/**
	 * Only the edges incident to the highlighted node, and not the ones among
	 * its neighbours. "This node and its edges" is a question about one node;
	 * lighting the rungs between its neighbours would answer a question about
	 * its neighbourhood, which is what isolation is for.
	 */
	function highlightedLink(l) {
		if (highlighted == null) return false;
		return endId(l.source) === highlighted || endId(l.target) === highlighted;
	}

	// --- isolation --------------------------------------------------------

	/**
	 * Focus a set of nodes: they and everything within `isolateDepth` edges of
	 * one of them keep their colour, and the rest of the graph fades to a wash.
	 *
	 * Dimming, not filtering, and the difference is load-bearing. Filtering
	 * would drop the other nodes from the simulation, the layout would resettle,
	 * and the neighbourhood you were trying to look at would end up somewhere
	 * else on screen -- destroying exactly the spatial memory you were reading
	 * the graph with. Nothing here touches graphData -- it repaints, and the
	 * colour accessors read `isolated` on the way past -- so every node stays
	 * exactly where it was.
	 */
	function setIsolated(ids) {
		isolated = ids;
		litCache = null;
		syncIsolateNote();
		repaint();
	}

	function clearIsolated() {
		if (isolated.size) setIsolated(new Set());
	}

	/** Start over on one node: the whole focus becomes this and nothing else. */
	function isolateOnly(id) {
		if (isolated.size === 1 && isolated.has(id)) return;
		setIsolated(new Set([id]));
	}

	/** Light a second neighbourhood without losing the first. */
	function addIsolated(id) {
		if (isolated.has(id)) return;
		let next = new Set(isolated);
		next.add(id);
		setIsolated(next);
	}

	function dropIsolated(id) {
		if (!isolated.has(id)) return;
		let next = new Set(isolated);
		next.delete(id);
		setIsolated(next);
	}

	/**
	 * A double click keeps its meaning whatever the focus set holds: it
	 * isolates the node clicked, and double-clicking that same node when it is
	 * the only thing isolated gives the whole graph back. Building a focus out
	 * of several nodes is the context menu's job -- a gesture that cannot be
	 * made by accident while panning.
	 */
	function toggleIsolate(id) {
		hideAction();
		hideMenu();
		if (isolated.size === 1 && isolated.has(id)) clearIsolated();
		else isolateOnly(id);
	}

	/**
	 * Every node within `isolateDepth` edges of a focus node, mapped to the
	 * distance it was reached at. The distance is not bookkeeping: it is what
	 * tells a link whether it is one of the edges walked to get here, or a rung
	 * past the fringe between two nodes that both happen to be lit.
	 *
	 * Cached because it is read once per node and once per link on every frame,
	 * and thrown away whenever the focus, the depth or the graph changes.
	 */
	function lit() {
		if (litCache) return litCache;
		let seen = new Map();
		let frontier = [];
		for (let id of isolated) {
			seen.set(id, 0);
			frontier.push(id);
		}
		for (let d = 1; d <= isolateDepth && frontier.length; d++) {
			let next = [];
			for (let id of frontier) {
				let near = adjacency.get(id);
				if (!near) continue;
				for (let other of near) {
					if (seen.has(other)) continue;
					seen.set(other, d);
					next.push(other);
				}
			}
			frontier = next;
		}
		return (litCache = seen);
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
		if (!isolated.size) return false;
		return !lit().has(n.id);
	}

	/** force-graph rewrites a link's endpoints into node references once the
	 *  data is loaded, so the same field is a plain id before the first tick. */
	function endId(x) {
		return x && typeof x === 'object' ? x.id : x;
	}

	/**
	 * An edge stays lit only if it is one of the edges the neighbourhood was
	 * walked along -- both ends lit, and at least one of them reached before the
	 * last step out. Without that second half, raising the depth would light
	 * every edge among the fringe nodes as well, and a two-step isolation of a
	 * dense cluster would come back looking like the whole graph again.
	 */
	function dimmedLink(l) {
		if (!isolated.size) return false;
		let seen = lit();
		let a = seen.get(endId(l.source));
		let b = seen.get(endId(l.target));
		if (a == null || b == null) return true;
		// At depth 0 there is no step out to be the last one, and the rule
		// would dim an edge with both ends in the focus -- a link wholly
		// inside what you asked to see. Below one step, both ends lit is the
		// whole test.
		return Math.min(a, b) >= Math.max(1, isolateDepth);
	}

	/**
	 * Isolation is otherwise invisible in the panel, and a user who does not
	 * know that clicking the background clears it would have no way back to the
	 * whole graph.
	 *
	 * A focus of several nodes names the first and counts the rest: the button
	 * lives in a narrow panel, and the full list is one hover away in the title.
	 */
	function syncIsolateNote() {
		let names = [];
		for (let id of isolated) {
			let n = nodeCache.get(id);
			if (n) names.push(n.label || n.name);
		}
		elIsolate.hidden = !names.length;
		if (!names.length) return;
		elIsolate.textContent = names.length > 1
			? t('isolate-note-more', { name: names[0], count: names.length - 1 })
			: t('isolate-note', { name: names[0] });
		elIsolate.title = t('isolate-note-hint', { names: names.join(', ') });
	}

	elIsolate.addEventListener('click', clearIsolated);

	window.addEventListener('pointerdown', (e) => {
		if (!elMenu.hidden && !elMenu.contains(e.target)) hideMenu();
	}, true);

	/**
	 * force-graph has no double-click event, but it does unbind d3-zoom's
	 * dblclick-to-zoom, which leaves the DOM one free for us. The node is
	 * whatever the pointer is over -- force-graph's own hit test already knows,
	 * and asking it is more reliable than timing two clicks ourselves.
	 *
	 * The pair of clicks underneath still runs toggleHighlight twice, which
	 * cancels out: the highlight goes on and straight back off, and a double
	 * click ends with the neighbourhood isolated and no ring left over. That is
	 * the right end state -- isolation already says which node was asked about,
	 * far louder than a ring would.
	 */
	elGraph.addEventListener('dblclick', () => {
		if (hoverNode) toggleIsolate(hoverNode.id);
	});

	/**
	 * Ask chrome to describe this node in Zotero's own item pane beside the
	 * graph. Chrome builds the pane on the first such request and opens the
	 * panel again if the divider's chevron had hidden it; see lib/itemPane.js.
	 *
	 * Sent on every click, including a second click on the paper already shown:
	 * clicking a node is how you ask to see it, and asking again after hiding
	 * the panel has to bring it back.
	 *
	 * An outside reference does not replace what is shown. There is no item to
	 * describe, and no metadata beyond the DOI already on the tooltip; the
	 * ghost's own card, on its context menu, is what answers this for one of
	 * those.
	 */
	function showItemPane(n) {
		if (!n || n.ghost || !n.itemID) return;
		emit({ type: 'item-pane-show', itemID: n.itemID });
	}

	// --- defending a drag in progress -------------------------------------

	/**
	 * Right-clicking a node you are still carrying is the gesture the pin was
	 * built for: drag it where it belongs, ask for the menu, pin it there.
	 * Getting there takes some care, because d3-drag ends a gesture on ANY
	 * mouseup that reaches the window -- its handler is registered on the view,
	 * not the canvas, and never looks at which button came up.
	 *
	 * Left alone, that drops the node and the layout immediately pulls it off
	 * the spot being aimed at, which is the one thing this gesture must not do.
	 * So the drag is allowed to end -- a node the pointer is no longer carrying
	 * cannot be dragged across the canvas on the way to the menu, which is the
	 * other half of the problem -- and the node is HELD where it was dropped
	 * for as long as the menu is open. Pin makes the hold permanent; dismissing
	 * the menu any other way gives the node back to the layout.
	 *
	 * Everything else about the press is swallowed: the whole point is that the
	 * right button decides when the drag ends, not the browser's idea of what a
	 * second button means.
	 *
	 * Capture on window, and registered at load, which is what puts these ahead
	 * of d3's: d3 re-registers its window listeners on every mousedown, and a
	 * later registration on the same target and phase runs later.
	 */
	let dragNode = null;      // node the pointer is carrying, or null
	let menuOnDrop = null;    // the right-click that asked for a menu, if any
	let menuPress = false;    // left button still down from the drag it ended

	/**
	 * Spend the tail of the press the menu was opened from.
	 *
	 * The right button ends the drag, but the left one is still held: the press
	 * that began the drag outlives the gesture. force-graph stopped counting
	 * that gesture as a drag the moment the right button ended it, so it reads
	 * the left button coming up as an ordinary click on whatever is under the
	 * pointer -- which dismisses the menu it just opened, isolates the node
	 * underneath, and hands the held node back to the layout. Unless the
	 * pointer is moved onto the menu first, so that the release lands on the
	 * menu rather than the canvas; that is what made the gesture feel like it
	 * demanded a steady hand.
	 *
	 * Ignored here rather than swallowed on the way in. force-graph raises its
	 * clicks from its own pointerup handler, which is also where it forgets
	 * that a button was down -- stop that event and the flag sticks on, and the
	 * next real click is eaten instead. So the click is allowed to happen and
	 * comes to nothing.
	 *
	 * The flag is dropped by whichever comes first: the click it is waiting
	 * for, or the next press, for a release that lands on the menu and so
	 * raises no click at all.
	 */
	function spentPress() {
		if (!menuPress) return false;
		menuPress = false;
		return true;
	}

	function guardDrag(e) {
		// Button 0 is the drag's own, and has to get through: it is what ends
		// the gesture normally.
		if (!dragNode || e.button === 0) return;
		// The right button's mouseup is the one event that IS allowed past, so
		// that d3 sees it and ends the drag. Noted on the way, because
		// force-graph will not raise its own right-click for it -- it suppresses
		// clicks that end a drag, which is otherwise exactly the right rule.
		if (e.type === 'mouseup' && e.button === 2) {
			menuOnDrop = e;
			return;
		}
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	for (let type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu']) {
		window.addEventListener(type, guardDrag, true);
	}

	// onNodeDragEnd is the normal way out, but a flag that stuck here would
	// swallow every right-click for the rest of the session -- far worse than
	// the bug above. Two ways back, then: the left button coming up ends every
	// drag there is, and a mouse that moves without it down was never dragging.
	// The second catches the case the first cannot -- a button released outside
	// the window, whose mouseup never arrives.
	function endDrag() {
		dragNode = null;
		menuOnDrop = null;
	}

	// A new press means the last one is spent, whatever became of its release.
	window.addEventListener('pointerdown', () => {
		menuPress = false;
	}, true);

	window.addEventListener('mouseup', (e) => {
		if (e.button === 0) endDrag();
	}, true);

	window.addEventListener('mousemove', (e) => {
		if (dragNode && !(e.buttons & 1)) endDrag();
	}, true);

	// --- pinning ----------------------------------------------------------

	/**
	 * Holding a node where the user put it. d3 reads fx/fy as "this coordinate
	 * is fixed" and stops integrating the node, while every force the node
	 * exerts on its neighbours keeps acting -- so pinning one paper anchors the
	 * cluster around it rather than freezing it.
	 *
	 * The pin lives on the node object, and nodeCache hands the same objects
	 * back on every re-render, so a pin survives a filter change and a late
	 * build phase landing -- exactly the moments when a layout arranged by hand
	 * would otherwise be lost.
	 *
	 * force-graph's drag handler restores fx/fy to whatever they were before
	 * the drag, which gives the two gestures the right shapes for free:
	 * dragging a pinned node MOVES its pin, dragging an unpinned one still
	 * releases it on drop.
	 */
	function isPinned(n) {
		return (n.fx != null || n.fy != null) && n !== heldNode && !frozen.has(n);
	}

	/**
	 * A hold is a pin the user has not agreed to yet: the same fixed
	 * coordinates, worn only while the menu that offers to make it permanent is
	 * open. Without it, a node dropped by the right button would drift away
	 * underneath the menu asking whether to pin it -- and it would be pinned to
	 * wherever it had got to by the time the answer came.
	 *
	 * Deliberately not drawn: a ring means "this node is staying", and a hold
	 * lasts only as long as an open menu.
	 */
	let heldNode = null;

	function hold(n) {
		heldNode = n;
		n.fx = n.x;
		n.fy = n.y;
	}

	function release() {
		if (!heldNode) return;
		let n = heldNode;
		heldNode = null;
		delete n.fx;
		delete n.fy;
		// No repaint: a hold draws nothing, so there is nothing to un-draw.
	}

	function pin(n) {
		// A node pinned during someone else's settle is pinned by the user, and
		// must not be freed when that settle lifts its freeze.
		frozen.delete(n);
		n.fx = n.x;
		n.fy = n.y;
		repaint();
	}

	function unpin(n) {
		delete n.fx;
		delete n.fy;
		repaint();
		settle();
	}

	/**
	 * Let go of a node the way a drag lets go of one.
	 *
	 * An unpinned node used to keep the coordinates it was pinned at until
	 * something else stirred the simulation, so "Unpin node" looked like it had
	 * done nothing at all: the ring came off and the graph stood still.
	 *
	 * What it should do instead is settled by what a pin IS. A pinned node was
	 * dragged to where it sits, with the simulation running and the whole
	 * neighbourhood moving to accommodate it, exactly as for any other drag --
	 * the pin only keeps it there afterwards. So at the moment the pin comes off
	 * the graph is in the same state a drop leaves behind, and there is nothing
	 * to invent: unpinning IS the drop, and the right behaviour is the one the
	 * user already knows from dropping a node.
	 *
	 * That means the whole graph relaxes, not just the released node. It is
	 * tempting to fix everything else in place first -- taking one pin out is a
	 * small thing to reshuffle a layout for -- but a freeze is what makes the
	 * two gestures look different rather than alike. A drop shares the strain:
	 * the node moves part of the way and its neighbours move to meet it, which
	 * is why a drop is a small settling motion rather than one node travelling.
	 * Freeze them and the same force has one body to move instead of a dozen,
	 * against anchors that never give ground -- so the node goes further, faster,
	 * and the neighbours it displaced never answer at all.
	 *
	 * All this needs, then, is a drop's energy. force-graph drags at an alpha
	 * TARGET of 0.3, so a dropped node is released into an alpha of about that.
	 * The only way into the engine from out here is d3ReheatSimulation(), which
	 * sets alpha to 1 -- and alpha scales the link, charge and centre-pull
	 * forces, so reheating outright throws the graph around with three times a
	 * drop's push. There is no alpha setter on the public API, so the settle
	 * sheds the difference instead: the graph is fixed where it stands for the
	 * couple of ticks it takes alphaDecay, turned right up, to halve alpha down
	 * to a drop's, and then let go all at once. Nothing moves during the shed --
	 * every node is fixed, including the one being released -- so those two
	 * frames are invisible, and what follows is an ordinary drop.
	 */

	// force-graph's own d3AlphaTarget while a node is being dragged, and so the
	// alpha a dropped node is released into.
	const DROP_ALPHA = 0.3;

	// Alpha is multiplied by (1 - decay) per tick, so this sheds it in halves:
	// two ticks take 1 down to 0.25.
	const SHED_DECAY = 0.5;

	// The other end a shed can be aimed at: far enough below d3's own alphaMin
	// that the ticks after the release move nothing anyone can see. Ten ticks of
	// halving, a sixth of a second -- and that is the whole life of the freeze,
	// which is what keeps a freeze out of the way of whatever the user does next.
	const SPENT_ALPHA = 0.001;

	/** Ticks of halving it takes to bring alpha from 1 down to `target`. */
	function shedTicks(target) {
		return Math.ceil(Math.log(target) / Math.log(1 - SHED_DECAY));
	}

	// Fixed for the length of the shed, and not by the user. isPinned() has to
	// see through this, or every node would wear a pin ring for those two frames.
	let frozen = new Set();

	// Ticks of shed left to run, and the alpha decay the graph runs at when it
	// is not shedding.
	let shedLeft = 0;
	let settleDecay = null;

	/**
	 * Fix the graph where it stands, spend alpha down to `target` over the few
	 * ticks that takes, and let go of everything at once. `freeID` names the one
	 * node left free to move while the rest are held.
	 *
	 * A shed always ENDS, and quickly -- ten ticks at the outside. That is not
	 * only about how the release looks: a frozen node carries fx/fy, and a drag
	 * begun while the graph is frozen drags one node against a picture nailed to
	 * the canvas. A freeze that outlived its shed would take the answer out of
	 * every gesture the user made next.
	 */
	function shedTo(target, freeID = null) {
		if (!fg) return;
		thaw();
		for (let n of drawnNodes) {
			if (n.id === freeID) continue;
			if (n.fx != null || n.fy != null) continue;
			n.fx = n.x;
			n.fy = n.y;
			frozen.add(n);
		}
		if (!frozen.size) return;
		shedLeft = shedTicks(target);
		settleDecay = fg.d3AlphaDecay();
		fg.d3AlphaDecay(SHED_DECAY).d3ReheatSimulation();
	}

	function settle() {
		shedTo(DROP_ALPHA);
	}

	/**
	 * Take a just-added paper into the layout without moving the layout.
	 *
	 * Adding turns a ghost into a held item, which is a different id -- so
	 * force-graph is handed a changed node set and sets alpha to 1, which would
	 * re-anneal the whole picture. Nothing about the derivation changed, though:
	 * the same papers cite the same work. placeAdopted() has already put the new
	 * node where the ghost stood, so there is nothing left to arrange -- this
	 * spends that alpha against a frozen graph instead of letting it be paid out
	 * in motion, and leaves the new node itself free for those few ticks so the
	 * collide force can nudge it off anything it landed on.
	 */
	function holdStill(freeID) {
		shedTo(SPENT_ALPHA, freeID);
	}

	/**
	 * One tick of the shed, counted rather than watched, because alpha cannot be
	 * read back from out here -- which comes to the same thing, since the decay
	 * is fixed and the starting alpha is always 1. When the count runs out the
	 * graph is handed back, and from there this is a drop: alpha decaying from
	 * 0.3-ish to nothing over the engine's ordinary cooldown, every node free.
	 */
	function shed() {
		if (!shedLeft || --shedLeft > 0) return;
		thaw();
	}

	/** Give the graph its freedom back, and its cooling schedule. Idempotent,
	 *  and the engine's stop handler too, so a settle cannot outlive the run it
	 *  was started for. */
	function thaw() {
		if (fg && settleDecay !== null) fg.d3AlphaDecay(settleDecay);
		shedLeft = 0;
		settleDecay = null;
		if (!frozen.size) return;
		for (let n of frozen) {
			delete n.fx;
			delete n.fy;
		}
		frozen.clear();
	}

	/** force-graph stops redrawing once the simulation has cooled, so a change
	 *  that is purely visual has to announce itself. Re-setting a visual
	 *  accessor is what marks the canvas dirty. */
	function repaint() {
		if (fg) fg.nodeCanvasObject(drawNode);
	}

	// --- groups -----------------------------------------------------------

	/**
	 * An anchor planted on the canvas that pulls in whatever a mask picks out.
	 *
	 * The layout arranges papers by citation, which is the point of it -- but
	 * that leaves "where do this author's papers actually sit" answered by
	 * scattering them across the picture. A group answers it instead: plant a
	 * flag, say what belongs there, and they come.
	 *
	 * The masks are the panel's masks, down to the completion list -- but where
	 * the panel's decide what is DRAWN, a group's decide only what is PULLED.
	 * Nothing enters or leaves the graph for a group: the papers it names are
	 * the same papers, standing somewhere else. So the two stacks compose the
	 * way you would want -- a group naming something the panel has already
	 * filtered away simply pulls nothing, because a node that is not there has
	 * no position to change.
	 *
	 * Held items only, for the same reason the panel's masks are held-item
	 * only: an outside reference is a DOI and, with lookup on, a title. It has
	 * no author or year to be grouped by, and it follows the papers that cite
	 * it in any case.
	 */
	let groups = [];             // { id, x, y, filters, pull }; x/y in GRAPH coords
	let groupSeq = 0;
	let groupOf = new Map();     // node id -> { x, y, k }: where it is pulled, how hard
	let facetCache = new Map();  // node id -> facets, for the nodes on screen

	/**
	 * Which point each node is being pulled to. Recomputed whenever the anchors
	 * or the nodes on screen change, and never per tick: a mask match is a
	 * string comparison per facet per filter, and the force runs sixty times a
	 * second over every node in the graph.
	 *
	 * A node caught by two groups is pulled to the point between them their two
	 * strengths put it at -- the midpoint when they pull equally, nearer the
	 * firmer one when they do not. That is both what the arithmetic falls out as
	 * (two springs on one body are one spring at their weighted centre, pulling
	 * as hard as the two together) and the honest picture: it belongs to both, so
	 * it sits between them rather than picking a side.
	 *
	 * An anchor turned down to nothing is skipped outright rather than recorded
	 * with a strength of zero, so its papers go back to feeling the centre pull
	 * -- which centerPull() withholds from anything an anchor is holding. A
	 * group that pulls nothing must leave nothing behind, or its papers would be
	 * held by neither force and drift.
	 */
	function assignGroups() {
		let next = new Map();
		for (let g of groups) {
			if (!g.filters.length || !g.pull) continue;
			for (let [id, f] of facetCache) {
				if (!Filters.matchesAll(g.filters, f)) continue;
				let at = next.get(id);
				if (at) {
					at.x += g.x * g.pull;
					at.y += g.y * g.pull;
					at.k += g.pull;
				}
				else next.set(id, { x: g.x * g.pull, y: g.y * g.pull, k: g.pull });
			}
		}
		for (let at of next.values()) {
			at.x /= at.k;
			at.y /= at.k;
			if (at.k > GROUP_PULL_MAX) at.k = GROUP_PULL_MAX;
		}
		groupOf = next;
	}

	/** How many nodes on screen an anchor is actually pulling -- which is what
	 *  its card reports, because a mask that matches nothing looks identical to
	 *  one that has not been typed yet. */
	function groupSize(g) {
		if (!g.filters.length) return 0;
		let n = 0;
		for (let f of facetCache.values()) if (Filters.matchesAll(g.filters, f)) n++;
		return n;
	}

	/**
	 * Planting an anchor, moving one or changing what it names is a request to
	 * REARRANGE: nodes have to travel, sometimes the width of the graph. So
	 * this reheats outright rather than shedding down to a drop's alpha the way
	 * unpinning does -- a drop asks the layout to absorb one node's new
	 * position, and this asks it to answer a force that was not there before.
	 */
	function groupsChanged() {
		let before = groupOf;
		assignGroups();
		if (!fg) return;
		repaint();
		// Nothing is being pulled anywhere new: an anchor planted and thrown
		// away before it named anything, or one removed that never matched a
		// paper. The flag has to be un-drawn, but shaking a settled layout to
		// say so would be a strange thing to do.
		if (sameTargets(before, groupOf)) return;
		// A settle in flight has half the graph fixed in place; it would sit
		// out exactly the rearrangement being asked for.
		thaw();
		fg.d3ReheatSimulation();
	}

	function sameTargets(a, b) {
		if (a.size !== b.size) return false;
		for (let [id, at] of a) {
			let bt = b.get(id);
			if (!bt || bt.x !== at.x || bt.y !== at.y || bt.k !== at.k) return false;
		}
		return true;
	}

	/**
	 * The flag itself: a mast planted at the anchor with a pennant at the top,
	 * and what it pulls written beside it. Sized in screen pixels like the node
	 * labels are, so it stays a flag at any zoom instead of swelling into a
	 * banner. Drawn even while the graph is dimmed by an isolation -- it is
	 * furniture rather than data, and a flag you cannot see is one you cannot
	 * find your way back to.
	 */
	const FLAG_MAST = 16;      // screen px from the anchor to the top of the mast
	const FLAG_FLY = 9;        // screen px along the pennant
	const FLAG_DROP = 6;       // screen px the pennant hangs down the mast
	const FLAG_DOT = 2.5;      // screen px, the anchor point itself
	const FLAG_LABEL_PX = 11;

	function drawGroups(ctx, globalScale) {
		if (!groups.length) return;
		let theme = themeColors();
		// Screen pixels into graph units at this zoom -- the same trick the
		// labels use, and the reason nothing here is in graph units to start.
		let s = 1 / globalScale;
		for (let g of groups) {
			let top = g.y - FLAG_MAST * s;
			ctx.beginPath();
			ctx.arc(g.x, g.y, FLAG_DOT * s, 0, 2 * Math.PI);
			ctx.fillStyle = theme.fg;
			ctx.fill();
			ctx.beginPath();
			ctx.moveTo(g.x, g.y);
			ctx.lineTo(g.x, top);
			ctx.lineWidth = 1.5 * s;
			ctx.strokeStyle = theme.fg;
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(g.x, top);
			ctx.lineTo(g.x + FLAG_FLY * s, top + (FLAG_DROP / 2) * s);
			ctx.lineTo(g.x, top + FLAG_DROP * s);
			ctx.closePath();
			ctx.fillStyle = theme.fg;
			ctx.fill();

			let label = groupLabel(g);
			ctx.font = (FLAG_LABEL_PX * s) + 'px sans-serif';
			ctx.textAlign = 'left';
			ctx.textBaseline = 'middle';
			let x = g.x + (FLAG_FLY + 4) * s;
			let y = top + (FLAG_DROP / 2) * s;
			// Halo first, for the same reason the node labels have one: this
			// text lands over whatever the anchor gathered.
			ctx.lineJoin = 'round';
			ctx.lineWidth = (FLAG_LABEL_PX * 0.3) * s;
			ctx.strokeStyle = theme.halo;
			ctx.strokeText(label, x, y);
			ctx.fillStyle = g.filters.length ? theme.fg : theme.muted;
			ctx.fillText(label, x, y);
		}
	}

	/** What the flag says: the masks it pulls by, or the invitation to say. */
	function groupLabel(g) {
		if (!g.filters.length) return t('group-flag-empty');
		return g.filters.map(Filters.describe).join(' + ');
	}

	/**
	 * The flag under the pointer, if any.
	 *
	 * Measured against the middle of the mast rather than the anchor: the
	 * graphic stands above the point it marks, and aiming at a flag means
	 * aiming at the flag. Generous, because it is small -- but not so generous
	 * that a right-click meaning "group here" lands on a neighbour instead.
	 */
	const FLAG_HIT_PX = 18;

	function groupAt(event) {
		if (!fg || !groups.length) return null;
		let r = elGraph.getBoundingClientRect();
		let px = event.clientX - r.left;
		let py = event.clientY - r.top;
		let best = null;
		let bestD = FLAG_HIT_PX * FLAG_HIT_PX;
		for (let g of groups) {
			let p = fg.graph2ScreenCoords(g.x, g.y);
			let dx = p.x - px;
			let dy = (p.y - FLAG_MAST / 2) - py;
			let d = dx * dx + dy * dy;
			if (d > bestD) continue;
			bestD = d;
			best = g;
		}
		return best;
	}

	/** Where an event points, in graph coordinates. */
	function graphAt(event) {
		let r = elGraph.getBoundingClientRect();
		return fg.screen2GraphCoords(event.clientX - r.left, event.clientY - r.top);
	}

	/**
	 * Picking a flag up, and clicking one.
	 *
	 * An anchor is a position, so moving it should be the gesture that moves
	 * anything: pick it up, put it down. And a flag was the one thing on the
	 * canvas the left button had nothing to say about -- the click that lands
	 * on the empty canvas beside it gives the whole graph back, which is the
	 * opposite of what someone aiming at a flag meant. So the press decides
	 * between the two on the way up: it travelled, and it was a drag; it did
	 * not, and it was a click asking the flag what can be done with it.
	 *
	 * Both are intercepted on the container in the capture phase, because the
	 * two layers underneath both want this press: d3-zoom reads a left drag on
	 * the canvas as a pan, and force-graph's own pointer bookkeeping would
	 * raise a background click on the way up and clear the isolation. The
	 * canvas is a child of the container, so capture reaches it first -- but
	 * force-graph's listeners are on the container ITSELF, registered when the
	 * graph is built and therefore after these, which is why swallowing has to
	 * be immediate rather than merely stopping the propagation.
	 *
	 * The mouse events are a second door onto the same press. Preventing a
	 * pointerdown's default is supposed to suppress them and d3-zoom listens
	 * for mousedown rather than pointerdown, so a browser that disagreed would
	 * pan the canvas out from under the flag being dragged. Swallowing them
	 * while a drag is live costs one comparison and closes the question.
	 */
	const FLAG_DRAG_PX = 4;   // screen px of travel before a press is a drag
	let flagDrag = null;      // { g, id, dx, dy, x, y, moved }

	function flagDown(e) {
		if (flagDrag || e.button !== 0 || !fg) return;
		let g = groupAt(e);
		if (!g) return;
		let at = graphAt(e);
		// Carried by the offset it was grabbed at, so a flag taken by its
		// pennant is not snatched down to the pointer: the hit box stands a
		// mast's height above the anchor, and what is being moved is the
		// graphic the user is looking at.
		flagDrag = {
			g, id: e.pointerId,
			dx: g.x - at.x, dy: g.y - at.y,
			x: e.clientX, y: e.clientY,
			moved: false,
		};
		// So the drag survives the pointer leaving the pane -- and so the moves
		// and the release come back to this element, ahead of force-graph's
		// listeners on it.
		elGraph.setPointerCapture(e.pointerId);
		swallow(e);
	}

	function flagMove(e) {
		if (!flagDrag || e.pointerId !== flagDrag.id) return;
		swallow(e);
		// A press that has not travelled is still a click: the threshold is
		// what keeps a hand that shifts on the button from nudging the anchor a
		// pixel sideways instead of opening the menu.
		if (!flagDrag.moved
			&& Math.abs(e.clientX - flagDrag.x) < FLAG_DRAG_PX
			&& Math.abs(e.clientY - flagDrag.y) < FLAG_DRAG_PX) return;
		flagDrag.moved = true;
		let at = graphAt(e);
		flagDrag.g.x = at.x + flagDrag.dx;
		flagDrag.g.y = at.y + flagDrag.dy;
		// The flag follows the pointer and the papers wait for the drop.
		// Dragging them along would mean reheating the layout on every frame of
		// the gesture, and what is being aimed at is where the flag ends up,
		// not the cloud chasing it there.
		repaint();
	}

	function flagUp(e) {
		if (!flagDrag || e.pointerId !== flagDrag.id) return;
		let { g, moved } = flagDrag;
		flagDrag = null;
		swallow(e);
		// Somewhere new is a rearrangement, and groupsChanged() is what asks
		// the layout for one. Nowhere new is a click, answered with the flag's
		// own menu -- the entries the right button already offers over it,
		// which is everything there is to do to an anchor.
		if (moved) groupsChanged();
		else openMenu(groupEntries(g, e), e);
	}

	// A capture lost mid-gesture -- a pen leaving the tablet, the pane going
	// away underneath the pointer -- never sends the release. The flag keeps
	// wherever it had got to, because that is where the user last saw it.
	function flagCancel(e) {
		if (!flagDrag || e.pointerId !== flagDrag.id) return;
		let moved = flagDrag.moved;
		flagDrag = null;
		if (moved) groupsChanged();
	}

	function flagGuard(e) {
		if (flagDrag) swallow(e);
	}

	function swallow(e) {
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	elGraph.addEventListener('pointerdown', flagDown, true);
	elGraph.addEventListener('pointermove', flagMove, true);
	elGraph.addEventListener('pointerup', flagUp, true);
	elGraph.addEventListener('pointercancel', flagCancel, true);
	for (let type of ['mousedown', 'mousemove', 'mouseup']) {
		elGraph.addEventListener(type, flagGuard, true);
	}

	/**
	 * A flag's own two entries: what it names, and whether it stays. Offered
	 * both by a left click on the flag and by the canvas menu when the right
	 * click landed on one, because they are the same question asked twice.
	 */
	function groupEntries(g, event) {
		return [{
			icon: 'edit',
			label: t('menu-edit-group'),
			hint: t('menu-edit-group-hint'),
			run: () => openGroup(g, event),
		}, {
			// Not the trash: removing an anchor throws away a way of reading the
			// graph, never a paper.
			icon: 'minus-circle',
			label: t('menu-remove-group'),
			hint: t('menu-remove-group-hint'),
			run: () => removeGroup(g),
		}];
	}

	// --- a group's card ---------------------------------------------------

	/**
	 * The anchor being edited, and the only thing the card below describes. A
	 * group is planted and named in one gesture, so "Group here" opens this on
	 * a flag that names nothing yet -- and closing it without naming anything
	 * throws that flag away, because a half-made gesture should leave nothing
	 * behind.
	 */
	let editingGroup = null;

	function addGroup(event) {
		if (!fg) return;
		let at = graphAt(event);
		let g = { id: ++groupSeq, x: at.x, y: at.y, filters: [], pull: GROUP_PULL };
		groups.push(g);
		openGroup(g, event);
		repaint();
	}

	function openGroup(g, event) {
		hideAction();
		editingGroup = g;
		// "here" is only true of the flag being planted; on one already stood
		// up the card is about the group, not about the click that opened it.
		elGroupTitle.textContent = t(g.filters.length ? 'group-existing' : 'group-here');
		groupBox.load(g.filters);
		// The slider belongs to the anchor, not to the card: opening a second
		// flag must show that flag's strength, not the last one's.
		elGroupPull.value = String(g.pull);
		syncGroupPull();
		syncGroupNote();
		elGroup.hidden = false;
		positionAt(elGroup, event);
		elGroupInput.focus();
	}

	function closeGroup() {
		if (!editingGroup) return;
		let g = editingGroup;
		editingGroup = null;
		elGroup.hidden = true;
		hideSuggest();
		// A flag that names nothing pulls nothing and says nothing. It is the
		// gesture half-made, not a group, so the card takes it with it.
		if (!g.filters.length) removeGroup(g);
	}

	function removeGroup(g) {
		let i = groups.indexOf(g);
		if (i < 0) return;
		groups.splice(i, 1);
		if (editingGroup === g) {
			editingGroup = null;
			elGroup.hidden = true;
			hideSuggest();
		}
		groupsChanged();
	}

	/**
	 * The readout beside the slider, and -- while a card is open -- the anchor's
	 * own strength.
	 *
	 * Committed as it is dragged, the way the masks are committed as they are
	 * picked: what a group pulls at is something you find by watching the graph
	 * answer, and a value that only took effect on release would make that a
	 * guessing game.
	 */
	function syncGroupPull() {
		elGroupPullValue.textContent = Number(elGroupPull.value).toFixed(2);
	}

	function applyGroupPull() {
		syncGroupPull();
		if (!editingGroup) return;
		editingGroup.pull = Number(elGroupPull.value);
		groupsChanged();
		// The note says what the anchor is doing, and at zero that is no longer
		// pulling -- so the slider has to retitle it.
		syncGroupNote();
	}

	elGroupPull.addEventListener('input', applyGroupPull);

	function syncGroupNote() {
		if (!editingGroup) return;
		let n = groupSize(editingGroup);
		// Three things it can be saying: nothing has been named yet, these papers
		// are being gathered, or these papers are named and left where they are.
		elGroupSub.textContent = !editingGroup.filters.length
			? t('group-empty')
			: t(editingGroup.pull ? 'group-pulls' : 'group-names', { count: n });
	}

	/**
	 * A group's own mask stack. Its candidates come from what is on screen,
	 * narrowed by this group's other masks: an anchor can only pull nodes that
	 * exist, so a value the panel has already filtered away would be a
	 * completion for a mask that pulls nothing.
	 */
	let groupBox = filterBox({
		input: elGroupInput,
		chips: elGroupChips,
		candidates: groupCandidates,
		onChange: () => {
			if (!editingGroup) return;
			editingGroup.filters = groupBox.filters().slice();
			groupsChanged();
			syncGroupNote();
		},
	});

	function groupCandidates(skip) {
		let filters = groupBox.filters();
		let out = [];
		for (let f of facetCache.values()) {
			let ok = true;
			for (let i = 0; i < filters.length && ok; i++) {
				if (i !== skip && !Filters.matches(filters[i], f)) ok = false;
			}
			if (ok) out.push(f);
		}
		return out;
	}

	/**
	 * The card is dragged by its title.
	 *
	 * It opens at the pointer, which is exactly where the flag it describes was
	 * just planted -- so the one thing it is certain to cover is the thing you
	 * are looking at while you decide what belongs there. Every other floating
	 * thing in this page can be dismissed and re-opened somewhere better; this
	 * one is being typed into, and dismissing it is not free.
	 *
	 * Pointer capture, so a fast drag that outruns the title bar keeps the
	 * card rather than dropping it under the cursor.
	 */
	let cardDrag = null;

	elGroupTitle.addEventListener('pointerdown', (e) => {
		if (e.button !== 0) return;
		let r = elGroup.getBoundingClientRect();
		cardDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
		try {
			elGroupTitle.setPointerCapture(e.pointerId);
		}
		catch (err) { /* no capture, just a draggier drag */ }
		// Otherwise the gesture selects the title text instead of moving it.
		e.preventDefault();
	});

	elGroupTitle.addEventListener('pointermove', (e) => {
		if (!cardDrag) return;
		// Clamped the way positionAt() clamps: a card dragged off the edge
		// would take the handle it is dragged by with it.
		let w = elGroup.offsetWidth;
		let h = elGroup.offsetHeight;
		elGroup.style.left = Math.max(4,
			Math.min(e.clientX - cardDrag.dx, window.innerWidth - w - 8)) + 'px';
		elGroup.style.top = Math.max(4,
			Math.min(e.clientY - cardDrag.dy, window.innerHeight - h - 8)) + 'px';
	});

	for (let type of ['pointerup', 'pointercancel']) {
		elGroupTitle.addEventListener(type, () => {
			cardDrag = null;
		});
	}

	el('group-close').addEventListener('click', closeGroup);
	el('group-remove').addEventListener('click', () => {
		if (editingGroup) removeGroup(editingGroup);
	});

	// Clicking away is the other way out, and it means the same as Done: the
	// masks are committed as they are picked, so there is nothing in the card
	// left to save. The completion list is a sibling of the card rather than a
	// child of it, so a click on a row has to be spared explicitly.
	window.addEventListener('pointerdown', (e) => {
		if (elGroup.hidden) return;
		if (elGroup.contains(e.target) || elSuggest.contains(e.target)) return;
		closeGroup();
	}, true);

	// --- the node context menu --------------------------------------------

	/**
	 * Which of the two menus a node gets, and it turns on what the node IS.
	 *
	 * A held node is a Zotero item, and the menu for a Zotero item already
	 * exists: the one the library window opens over a row. Everything this page
	 * used to offer a held item was a thinner copy of an entry in that menu --
	 * select it, open its file, open its URL -- and a thinner copy is the worst
	 * kind, because it drifts. So a held node asks chrome for the real thing;
	 * see openNativeMenu() and lib/nodeMenu.js.
	 *
	 * An outside reference is not an item and has no such menu to ask for. It
	 * keeps this page's own, which is where its two entries live: resolving the
	 * identifier, and adding the paper the library does not hold.
	 *
	 * Both end with the same questions about the picture rather than the paper
	 * -- what this node is next to, and where it sits -- because a reference
	 * outside the collection has both as much as a held item does.
	 */
	function showMenu(n, event) {
		if (!n.ghost) {
			openNativeMenu(n, event);
			return;
		}
		let entries = ghostMenu(n);
		for (let entry of isolateEntries(n)) entries.push(entry);
		entries.push(pinEntry(n));
		openMenu(entries, event);
	}

	/**
	 * Zotero's own item context menu, opened over the graph.
	 *
	 * It has to be built and opened in chrome: it is a XUL <menupopup> in the
	 * main window, and this page is content. So the entries this plugin adds to
	 * the bottom of it cross the bridge as data -- an icon name, a label, a
	 * hint -- and what each one DOES stays here, in a run() kept against the id
	 * chrome hands back when that entry is picked.
	 *
	 * Screen coordinates rather than client ones: the popup is placed by a
	 * window that knows nothing of this document's offset inside it, and
	 * screenX/screenY is what core's own reader hands across for the same
	 * reason.
	 */
	let nativeRuns = new Map();
	let nativeOpen = false;

	function openNativeMenu(n, event) {
		// Dismisses whatever was open -- this page's own menu, or a native one
		// still up -- and with it the hold that menu was carrying.
		hideMenu();
		hideAction();
		nativeRuns.clear();
		let entries = isolateEntries(n);
		entries.push(pinEntry(n));
		let wire = entries.map((entry, i) => {
			let id = 'e' + i;
			nativeRuns.set(id, entry.run);
			return { id, icon: entry.icon, label: entry.label, hint: entry.hint || null };
		});
		nativeOpen = true;
		emit({
			type: 'node-menu',
			itemID: n.itemID,
			x: event ? event.screenX : 0,
			y: event ? event.screenY : 0,
			entries: wire,
		});
	}

	/**
	 * The menu the canvas itself gets, where there is no node under the
	 * pointer. Both of its entries are about the picture as a whole: how it is
	 * framed, and where things belong in it.
	 *
	 * Over a flag it offers that flag's own two entries instead of a second
	 * "Group here". Planting one anchor on top of another makes two flags that
	 * cannot be told apart on screen, and the click that would do it is far
	 * more likely to have meant the one already there.
	 */
	function showCanvasMenu(event) {
		let entries = [{
			icon: 'zoom-to-fit',
			label: t('menu-zoom-to-fit'),
			hint: t('menu-zoom-to-fit-hint'),
			run: reframe,
		}, {
			// Not a node gesture: what is missing is a question about the
			// collection, so it is asked of the canvas rather than of any one
			// paper on it.
			icon: gapsOpen ? 'hide' : 'gaps',
			label: t(gapsOpen ? 'menu-gaps-hide' : 'menu-gaps'),
			hint: t('menu-gaps-hint'),
			run: () => (gapsOpen ? closeGaps() : openGaps()),
		}];
		let g = groupAt(event);
		if (g) {
			for (let entry of groupEntries(g, event)) entries.push(entry);
		}
		else {
			entries.push({
				icon: 'group-here',
				label: t('menu-group-here'),
				hint: t('menu-group-here-hint'),
				run: () => addGroup(event),
			});
		}
		openMenu(entries, event);
	}

	function openMenu(entries, event) {
		hideAction();
		// A menu replaced rather than dismissed still owes the previous node
		// its freedom.
		release();
		elMenu.textContent = '';
		for (let entry of entries) {
			elMenu.appendChild(menuItem(entry));
		}
		elMenu.hidden = false;
		positionAt(elMenu, event);
	}

	function hideMenu() {
		elMenu.hidden = true;
		// A native menu is chrome's to take down, and chrome answers by saying
		// so -- see zgMenuClosed, which is where the hold is given up in that
		// case. Releasing here as well would hand the node back to the layout
		// while the popup asking whether to pin it was still on screen.
		if (nativeOpen) {
			nativeOpen = false;
			emit({ type: 'node-menu-close' });
			return;
		}
		// Every way out of this page's own menu comes through here -- Escape, a
		// click on the canvas, picking an entry, a rebuild landing -- so this is
		// the one place the hold has to be given up. Picking "Pin node here"
		// releases and then re-fixes the node at coordinates nothing has had a
		// chance to change, which is the same spot.
		release();
	}

	/**
	 * One row: Zotero's own icon for the gesture, then what it is called.
	 *
	 * Every entry carries an icon, and a name icons.js does not know still draws
	 * an empty box of the same width -- a column where some labels are indented
	 * past an icon and others start at the edge reads as two lists, not one.
	 */
	function menuItem({ icon, label, hint, disabled, run }) {
		let b = document.createElement('button');
		b.type = 'button';
		b.className = 'menu-item';
		b.appendChild(Icons.svg(icon));
		let text = document.createElement('span');
		text.className = 'menu-label';
		text.textContent = label;
		b.appendChild(text);
		if (hint) b.title = hint;
		if (disabled) {
			b.disabled = true;
		}
		else {
			// The click is handed on because an entry may put something at the
			// pointer -- "Show details" opens the ghost card -- and that
			// belongs where the row was picked, not where the menu was asked
			// for.
			b.addEventListener('click', (event) => {
				hideMenu();
				run(event);
			});
		}
		return b;
	}

	/**
	 * Isolation, offered to both populations for the same reason pinning is:
	 * the neighbourhood of an outside reference is as much a question about
	 * this picture as the neighbourhood of a held item.
	 *
	 * Two entries, not one, because there are two different things to ask.
	 * "Isolate" starts over on this node -- the same thing a double click does.
	 * "Add to isolation" keeps what is already lit and lights the neighbourhood
	 * around this node beside it, which is how you see whether two papers share
	 * one. It only appears once something is isolated: with an empty focus it
	 * would be a second, longer name for the entry above it.
	 */
	function isolateEntries(n) {
		let on = isolated.has(n.id);
		let only = on && isolated.size === 1;
		let entries = [{
			icon: only ? 'show-all' : 'isolate',
			label: t(only ? 'menu-show-whole-graph' : 'menu-isolate'),
			hint: only
				? t('menu-isolate-hint-undim')
				: isolateDepth === 0
					? t('menu-isolate-hint-only')
					: t('menu-isolate-hint-depth', { depth: isolateDepth }),
			run: () => (only ? clearIsolated() : isolateOnly(n.id)),
		}];
		// Removing the last focused node is what the entry above already reads
		// as "Show whole graph", so there is nothing left for this one to say.
		if (isolated.size && !only) {
			entries.push({
				icon: on ? 'minus-circle' : 'plus-circle',
				label: t(on ? 'menu-remove-from-isolation' : 'menu-add-to-isolation'),
				hint: t(on ? 'menu-remove-from-isolation-hint' : 'menu-add-to-isolation-hint'),
				run: () => (on ? dropIsolated(n.id) : addIsolated(n.id)),
			});
		}
		return entries;
	}

	function pinEntry(n) {
		let pinned = isPinned(n);
		return {
			icon: pinned ? 'unpin' : 'pin',
			label: t(pinned ? 'menu-unpin' : 'menu-pin'),
			hint: t(pinned ? 'menu-unpin-hint' : 'menu-pin-hint'),
			run: () => (pinned ? unpin(n) : pin(n)),
		};
	}

	function ghostMenu(n) {
		let x = n.meta || {};
		let url = Links.externalUrl(x.ns, x.id || n.name);
		return [
			{
				// A held node's answer to "tell me about this one" is Zotero's
				// own item pane, which a click already opens. An outside
				// reference has no item to put there, so the card is it -- and
				// it lives here now that the double click isolates.
				icon: 'show-item',
				label: t('menu-show-details'),
				hint: x.title || n.name,
				run: event => showAction(n, event),
			},
			{
				icon: 'open-link',
				label: t('menu-open-in-browser'),
				hint: url || t('menu-open-in-browser-no-id'),
				disabled: !url,
				run: () => emit({ type: 'open-url', url }),
			},
			{
				// Straight to the add, where the card above it asks first. A
				// menu entry cannot be hit by a stray click while panning, and
				// that is the only thing the confirmation was ever there to
				// prevent.
				icon: 'add-to-zotero',
				label: t('menu-add-to-zotero'),
				hint: n.name,
				disabled: x.ns !== 'doi',
				run: () => emit({ type: 'add-item', doi: n.name, title: x.title || null }),
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
	 * A ghost's detail card -- the outside reference's answer to Zotero's item
	 * pane, which a click opens for a held node and which has nothing to show
	 * for one of these.
	 *
	 * Opened from the context menu. It used to be the double click, back when
	 * that meant "open this"; the double click now isolates, and everything a
	 * card is for -- reading the metadata, and the Add button below it -- is
	 * worth a deliberate gesture rather than a stray one made while panning.
	 *
	 * The Add here is still a button rather than the act of opening the card,
	 * because adding WRITES to the library. The menu's own "Add to Zotero" goes
	 * straight there: a right-click entry cannot be hit by accident, which is
	 * the only thing the confirmation was ever guarding against.
	 */
	let actionNode = null;

	function showAction(n, event) {
		actionNode = n;
		let x = n.meta || {};
		el('action-title').textContent = x.title || n.name;
		let sub = [];
		if (x.creators && x.creators.length) sub.push(creatorList(x.creators));
		if (x.year) sub.push(x.year);
		sub.push(t('tooltip-cited-here', { count: n.inDeg }));
		if (x.citedByGlobal != null) {
			sub.push(t('tooltip-citations-total', { count: x.citedByGlobal.toLocaleString() }));
		}
		// The DOI is the thing actually being added, so show it verbatim.
		sub.push(n.name);
		el('action-sub').textContent = sub.join(' · ');

		let add = el('action-add');
		add.disabled = false;
		add.textContent = t('action-add');

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
		add.textContent = t('action-adding');
		// Chrome answers by rebuilding, which re-pushes and re-renders; the
		// popover is dismissed now because the node it describes is about to
		// stop existing as a ghost.
		emit({ type: 'add-item', doi: actionNode.name, title: (actionNode.meta || {}).title || null });
		hideAction();
	});
	// One layer per press, outermost first, so Escape never throws away more
	// state than the user was looking at.
	window.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		if (!elMenu.hidden) hideMenu();
		else if (!elGroup.hidden) closeGroup();
		else if (!elAction.hidden) hideAction();
		// The isolation before the card that caused it: a row lights a
		// neighbourhood, and the press that undoes that must not instead take
		// away the list you were reading down.
		else if (isolated.size) clearIsolated();
		// After the isolation, not before it: a highlight takes nothing away,
		// so the graph an Escape is most likely asking for back is the undimmed
		// one. Both come off in two presses either way.
		else if (highlighted != null) clearHighlight();
		else if (gapsOpen) closeGaps();
	});

	// --- controls ---------------------------------------------------------

	function syncEnabled() {
		// "cited by ≥" is a filter over outside refs and has nothing to act on
		// without them. "look up names" is NOT gated the same way: with ghosts
		// off it still resolves the held items' own DOIs, and those counts are
		// what "global citations" sizes the whole graph by.
		let on = elIncludeExternal.checked;
		elMinCites.disabled = !on;
		el('min-cites-label').classList.toggle('disabled', !on);

		// Nothing has a global count until the lookup has run, so sizing by one
		// after switching the lookup back off would flatten every node to the
		// same "unknown" dot. Keyed off the checkbox rather than the last
		// payload: while a lookup rebuild is in flight the counts are on their
		// way, and the mode the user just picked has to survive the wait.
		if (!elEnrich.checked && elSizeBy.value === 'global') elSizeBy.value = 'here';
	}

	/** Scope changes cannot be filtered into existence -- they need a new build. */
	function requestRebuild() {
		syncEnabled();
		elStatus.textContent = t('status-rebuilding');
		emit({
			type: 'rebuild',
			options: {
				recursive: elRecursive.checked,
				includeExternal: elIncludeExternal.checked,
				enrich: elEnrich.checked,
			},
		});
	}

	/**
	 * The lookup is scope too -- names have to be fetched, and that is a network
	 * pass -- but it is the one scope option that derives nothing: no item joins
	 * or leaves the collection for it, and no edge is found or lost. So it does
	 * not ask for a rebuild. Chrome runs it as one phase over the graph already
	 * on screen, which is what lets the layout survive it: a rebuild would begin
	 * by pushing an empty edge list, and the graph would re-anneal from nothing.
	 */
	function requestLookup() {
		syncEnabled();
		elStatus.textContent = t(elEnrich.checked ? 'status-looking-up' : 'status-dropping-names');
		emit({ type: 'lookup', on: elEnrich.checked });
	}

	// Ticks the box the panel already owns rather than sending a scope of its
	// own, so the control and the shortcut to it cannot drift apart.
	elEmptyRecursive.addEventListener('click', () => {
		elRecursive.checked = true;
		requestRebuild();
	});

	elRecursive.addEventListener('change', requestRebuild);
	elIncludeExternal.addEventListener('change', requestRebuild);
	elEnrich.addEventListener('change', requestLookup);
	el('rebuild').addEventListener('click', requestRebuild);

	elMinConf.addEventListener('input', render);
	// Pure layout: no node or edge changes, so this reheats rather than renders.
	elLinkPull.addEventListener('input', () => {
		applyLinkPull();
		try {
			window.localStorage.setItem(PULL_KEY, elLinkPull.value);
		}
		catch (e) { /* no persistence, no problem */ }
	});
	// Same again for the middle of the canvas: layout, not data.
	elCenterPull.addEventListener('input', () => {
		applyCenterPull();
		try {
			window.localStorage.setItem(CENTER_KEY, elCenterPull.value);
		}
		catch (e) { /* no persistence, no problem */ }
	});
	elMinCites.addEventListener('input', render);
	// Paint, not data: the colour accessors read elColorBy live, so the graph
	// only has to be redrawn and its legend retitled. Going through render()
	// would hand force-graph the same nodes and edges back and re-anneal the
	// layout, moving every node on screen to explain a change of hue.
	elColorBy.addEventListener('change', () => {
		if (!fg) return;
		renderLegend(drawnNodes);
		repaint();
	});
	elSizeBy.addEventListener('change', () => {
		// Picking "global citations" IS the request for the counts it needs, so
		// it fetches them instead of refusing to be picked until someone finds
		// the checkbox that would have allowed it. The graph rescales itself
		// when the lookup lands; until then every node is the same unknown dot,
		// which is what the status line is reporting on.
		if (elSizeBy.value === 'global' && !elEnrich.checked) {
			elEnrich.checked = true;
			requestLookup();
		}
		// Sizing changes node radii, and the collision force caches the radii
		// it was built with -- but render() compares the new ones against the
		// drawn ones and re-registers it itself, so a size change that alters
		// nothing (picking "global citations" before any counts have arrived)
		// costs nothing.
		render();
	});
	elHideIsolated.addEventListener('change', () => {
		elHideIsolated.dataset.touched = '1';
		render();
	});

	/**
	 * How far an isolation reaches. Paint, not data, exactly like isolating
	 * itself: the neighbourhood is recomputed and the canvas redrawn, and no
	 * node moves while you widen or narrow what is lit.
	 */
	function applyIsolateDepth() {
		// A number box hands back whatever is in it -- a half-typed value, a
		// blank, or a number restored from a future build -- so the clamp a
		// range input did for us is ours to do here. 0 is a depth like any
		// other now, so an empty box has to be told apart from a typed zero
		// rather than folded into it by a falsy test: blank means the default.
		let typed = String(elIsolateDepth.value).trim();
		let n = typed === '' ? 1 : Math.round(Number(typed));
		isolateDepth = Number.isFinite(n) ? Math.min(4, Math.max(0, n)) : 1;
		litCache = null;
		repaint();
	}

	elIsolateDepth.addEventListener('input', () => {
		applyIsolateDepth();
		try {
			// The clamped depth, not the box: what gets stored is what was acted
			// on, so a reopened graph never shows a number it is not using.
			window.localStorage.setItem(DEPTH_KEY, String(isolateDepth));
		}
		catch (e) { /* no persistence, no problem */ }
	});

	// Typing is left alone until it is finished -- rewriting the box on every
	// keystroke would stop you clearing it to type another number -- and then
	// the box is put back in step with the depth in force.
	elIsolateDepth.addEventListener('change', () => {
		if (elIsolateDepth.value !== String(isolateDepth)) elIsolateDepth.value = String(isolateDepth);
	});

	/**
	 * Put the whole graph back in view.
	 *
	 * Nothing else can do this: the layout wanders as later build phases add
	 * edges, dragging a node pans nothing, and a graph built at one zoom can
	 * land far outside the viewport of the next. force-graph's zoomToFit works
	 * off the node bounding box, which accounts for node radii but not for the
	 * labels we draw beside them, hence the margin.
	 *
	 * Proportional rather than fixed, because this runs in a Zotero pane as
	 * well as a full tab, and 40px a side out of a 300px pane is a third of the
	 * graph spent on nothing.
	 */
	const REFRAME_MS = 400;

	function reframe() {
		if (!fg) return;
		let pad = Math.round(Math.min(40, Math.min(elGraph.clientWidth, elGraph.clientHeight) * 0.1));
		fg.zoomToFit(REFRAME_MS, Math.max(8, pad));
	}

	elReframe.addEventListener('click', reframe);

	// --- the sidebar ------------------------------------------------------

	/**
	 * Re-measure the canvas.
	 *
	 * force-graph is told its size in pixels rather than reading it, so a grid
	 * column changing under it leaves it drawing at the old width -- the nodes
	 * stay put and the canvas is simply the wrong shape. The window's own
	 * resize listener does not fire for this: nothing about the window changed.
	 */
	function remeasure() {
		if (fg) fg.width(elGraph.clientWidth).height(elGraph.clientHeight);
	}

	/**
	 * Show or hide the sidebar.
	 *
	 * The button stays lit while the pane is open, which is what the reader's
	 * own sidebar toggle does: a toggle that looks the same in both states is a
	 * button you have to press to find out what it did.
	 */
	function setSideOpen(on) {
		elFrame.classList.toggle('side-closed', !on);
		elSideToggle.classList.toggle('on', on);
		elSideToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
		// Both ids written out at each call rather than picked into a variable:
		// npm test reads the ids this page asks for out of the source, and a
		// name it cannot see is a string nothing knows is needed.
		elSideToggle.title = t(on ? 'side-toggle-hide' : 'side-toggle-show');
		elSideToggle.setAttribute('aria-label', t(on ? 'side-toggle-hide' : 'side-toggle-show'));
		remeasure();
		try {
			window.localStorage.setItem(SIDE_KEY, on ? '1' : '0');
		}
		catch (e) { /* no persistence, no problem */ }
	}

	elSideToggle.addEventListener('click', () => {
		setSideOpen(elFrame.classList.contains('side-closed'));
	});

	/**
	 * The item pane's toggle, drawn the same way as the sidebar's for the same
	 * reason: lit while the pane is open, so the button reads as a toggle.
	 *
	 * It reports rather than decides. Nothing here knows whether the pane is
	 * open -- the click goes to chrome, and what comes back is zgSetPane.
	 */
	function setPaneOpen(has, on) {
		elPaneToggle.disabled = !has;
		elPaneToggle.classList.toggle('on', has && on);
		elPaneToggle.setAttribute('aria-expanded', has && on ? 'true' : 'false');
		// Both ids written out at each call, as in setSideOpen: npm test reads
		// the ids this page asks for out of the source.
		elPaneToggle.title = t(has && on ? 'pane-toggle-hide' : 'pane-toggle-show');
		elPaneToggle.setAttribute('aria-label', t(has && on ? 'pane-toggle-hide' : 'pane-toggle-show'));
	}

	elPaneToggle.addEventListener('click', () => {
		emit({ type: 'item-pane-toggle' });
	});

	function setSideWidth(px) {
		let w = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, px)));
		document.documentElement.style.setProperty('--zg-side-width', w + 'px');
		return w;
	}

	/**
	 * Drag the sidebar's edge.
	 *
	 * Pointer events rather than a <splitter>, because there is no such element
	 * in an HTML document -- which is exactly why Zotero's reader carries a
	 * sidebar resizer of its own instead of using core's.
	 *
	 * setPointerCapture is what makes the drag survive the pointer leaving the
	 * 6px handle, which at any speed it immediately does; without it the grip
	 * is only draggable as fast as the layout can keep up.
	 */
	elSideGrip.addEventListener('pointerdown', (e) => {
		if (e.button !== 0) return;
		e.preventDefault();
		elSideGrip.setPointerCapture(e.pointerId);
		let startX = e.clientX;
		let startW = elSide.getBoundingClientRect().width;

		let move = (ev) => {
			// Live, so the graph reflows under the hand rather than jumping
			// when it is let go. remeasure() is cheap: it sets two numbers.
			setSideWidth(startW + (ev.clientX - startX));
			remeasure();
		};
		let up = () => {
			elSideGrip.removeEventListener('pointermove', move);
			elSideGrip.removeEventListener('pointerup', up);
			elSideGrip.removeEventListener('pointercancel', up);
			// Written back only on release: a pref written sixty times a second
			// is a pref written sixty times a second.
			try {
				window.localStorage.setItem(SIDE_WIDTH_KEY,
					String(Math.round(elSide.getBoundingClientRect().width)));
			}
			catch (e2) { /* no persistence, no problem */ }
		};

		elSideGrip.addEventListener('pointermove', move);
		elSideGrip.addEventListener('pointerup', up);
		elSideGrip.addEventListener('pointercancel', up);
	});

	// The two bar buttons and the field's two icons. Drawn from icons.js rather
	// than written as glyphs, for the reason that file exists: a near-miss
	// beside the real thing is worse than either.
	elSideToggle.appendChild(Icons.svg('open-pane'));
	// The same icon as the sidebar's toggle, mirrored in CSS -- see graph.css.
	elPaneToggle.appendChild(Icons.svg('open-pane'));
	elReframe.appendChild(Icons.svg('zoom-to-fit'));
	elSearchIcon.appendChild(Icons.svg('magnifier'));
	elSearchClear.appendChild(Icons.svg('clear'));
	el('panel-chevron').appendChild(Icons.svg('chevron-12'));
	el('legend-chevron').appendChild(Icons.svg('chevron-12'));

	try {
		let saved = window.localStorage.getItem(SIDE_WIDTH_KEY);
		if (saved !== null && Number.isFinite(Number(saved))) setSideWidth(Number(saved));
	}
	catch (e) { /* see setSideOpen */ }

	try {
		if (window.localStorage.getItem(SIDE_KEY) === '0') setSideOpen(false);
	}
	catch (e) { /* see setSideOpen */ }

	// --- the search field -------------------------------------------------

	/**
	 * Find a paper on the canvas and go to it.
	 *
	 * Deliberately NOT a second filter. The panel's chips already narrow the
	 * graph, and typing the same thing into two boxes to mean two different
	 * things would be a trap. What had no answer until now is the other
	 * question -- "where in here is the paper I am thinking of" -- because a
	 * force-directed layout puts a known paper somewhere you have to hunt for,
	 * and there is no ordering to hunt along.
	 *
	 * Matching is the filter grammar's own, over the facets render() already
	 * kept: a bare term is asked of all eight fields, so a surname, a journal
	 * and half a title all work without anyone having to say which is which.
	 * No new matching code, and no new pass over the data.
	 */
	const SEARCH_MAX = 10;

	let searchRows = [];   // the nodes offered, in the order they are drawn
	let searchAt = -1;     // which row the keyboard is on, or -1

	function searchMatches(text) {
		let filter = Filters.parse(text);
		if (!filter || !filter.terms.length) return [];
		let out = [];
		for (let n of (drawnNodes || [])) {
			let fac = facetCache.get(n.id);
			// A ghost has no facets to match on -- it is a DOI and, with the
			// lookup on, a title -- and the panel's masks already leave them
			// out for the same reason. Its title is worth searching, though,
			// which is the one thing the facets cannot answer for it.
			if (fac ? Filters.matches(filter, fac) : ghostMatches(filter, n)) out.push(n);
			if (out.length >= SEARCH_MAX) break;
		}
		return out;
	}

	/** A ghost's own text, since it has no facet record. */
	function ghostMatches(filter, n) {
		if (!n.ghost) return false;
		let hay = ((n.label || '') + ' ' + (n.name || '') + ' ' + (n.id || '')).toLowerCase();
		for (let term of filter.terms) {
			// A year range has no text to look for, and a ghost has no year to
			// find it in; the held nodes answer that one through their facets.
			if (term.value == null) continue;
			if (hay.includes(String(term.value).toLowerCase())) return true;
		}
		return false;
	}

	function renderSearch() {
		let text = elSearch.value.trim();
		elSearchClear.hidden = !text;
		if (!text) return hideSearch();

		searchRows = searchMatches(text);
		searchAt = -1;
		elSearchSuggest.textContent = '';

		if (!searchRows.length) {
			let none = document.createElement('div');
			none.className = 'search-empty';
			none.textContent = t('search-empty');
			elSearchSuggest.appendChild(none);
		}
		for (let i = 0; i < searchRows.length; i++) {
			elSearchSuggest.appendChild(searchRow(searchRows[i], i));
		}

		elSearchSuggest.hidden = false;
		elSearch.setAttribute('aria-expanded', 'true');
		placeSearch();
	}

	function searchRow(n, i) {
		let row = document.createElement('div');
		row.className = 'search-row';
		row.setAttribute('role', 'option');

		let key = document.createElement('span');
		key.className = 'search-key';
		key.textContent = n.label || '';

		let title = document.createElement('span');
		title.className = 'search-title';
		title.textContent = n.name || n.id || '';
		row.title = n.name || n.id || '';

		row.appendChild(key);
		row.appendChild(title);
		// mousedown, not click: the field is about to lose the focus either
		// way, and a blur handler that closed the list first would take the
		// row out from under the pointer before the click landed on it.
		row.addEventListener('mousedown', (e) => {
			e.preventDefault();
			goTo(i);
		});
		return row;
	}

	/** Against the field, by hand, because #bar is 41px tall and clips. */
	function placeSearch() {
		let r = elSearchBox.getBoundingClientRect();
		elSearchSuggest.style.top = Math.round(r.bottom + 2) + 'px';
		elSearchSuggest.style.left = Math.round(r.left) + 'px';
		elSearchSuggest.style.width = Math.round(r.width) + 'px';
	}

	function hideSearch() {
		elSearchSuggest.hidden = true;
		elSearch.setAttribute('aria-expanded', 'false');
		searchRows = [];
		searchAt = -1;
	}

	function markSearch(i) {
		let rows = elSearchSuggest.querySelectorAll('.search-row');
		for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('on', k === i);
		if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
		searchAt = i;
	}

	/**
	 * Go to the paper on row i.
	 *
	 * The same three things a click on the node itself does -- centre it, ring
	 * it, describe it in the item pane -- because they are the same gesture
	 * arrived at from a list instead of from the canvas, and the two must not
	 * come to mean different things.
	 *
	 * The zoom is deliberately left alone. Someone reading a dense cluster at
	 * one magnification did not ask to be pulled out of it; centring is what
	 * was asked for, and it is enough to put the node under the eye.
	 */
	function goTo(i) {
		let n = searchRows[i];
		if (!n || !fg) return;
		if (Number.isFinite(n.x) && Number.isFinite(n.y)) fg.centerAt(n.x, n.y, REFRAME_MS);
		setIsolated(new Set([n.id]));
		showItemPane(n);
		hideSearch();
		elSearch.blur();
	}

	function clearSearch() {
		elSearch.value = '';
		elSearchClear.hidden = true;
		hideSearch();
	}

	elSearch.addEventListener('input', renderSearch);
	elSearch.addEventListener('focus', () => {
		if (elSearch.value.trim()) renderSearch();
	});
	// The list is closed on the way out, but the field keeps its text: what was
	// typed is still the answer to "what was I looking for", and clearing it
	// silently would be the box forgetting on the user's behalf.
	elSearch.addEventListener('blur', hideSearch);

	elSearch.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (!searchRows.length) return;
			e.preventDefault();
			let step = e.key === 'ArrowDown' ? 1 : -1;
			let i = searchAt < 0
				? (step > 0 ? 0 : searchRows.length - 1)
				: (searchAt + step + searchRows.length) % searchRows.length;
			markSearch(i);
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			// With nothing picked, Enter means the first row -- which is what
			// the list is ordered to make true.
			goTo(searchAt < 0 ? 0 : searchAt);
			return;
		}
		if (e.key === 'Escape') {
			// Escape closes the list, then empties the box, and only then is
			// let through. The same ladder the filter box climbs, so that one
			// key means one thing everywhere on this page.
			e.stopPropagation();
			if (!elSearchSuggest.hidden) hideSearch();
			else if (elSearch.value) clearSearch();
			else elSearch.blur();
		}
	});

	elSearchClear.addEventListener('click', () => {
		clearSearch();
		elSearch.focus();
	});

		// --- what Zotero's chrome looks like ----------------------------------

	/**
	 * The three properties this page cannot work out for itself.
	 *
	 * A content document's matchMedia only ever sees the OS, so Zotero's own
	 * View > Color Scheme override is invisible from here; and the font size
	 * and interface density are prefs, which is to say chrome. Core pushes all
	 * three onto its own documents through Zotero.UIProperties.registerRoot(),
	 * which cannot reach across the privilege boundary -- so chrome reads them
	 * and hands them over, and this sets the same three things registerRoot()
	 * would have.
	 *
	 * Everything here is optional. A page that is never told keeps following
	 * the OS, which is what it did before and is right more often than not.
	 */
	window.zgSetChrome = function (json) {
		let props;
		try {
			props = JSON.parse(json);
		}
		catch (e) {
			return;
		}
		let root = document.documentElement;
		// The attribute name is core's own, from the reader's stylesheet, and
		// so is the three-way CSS it selects: absent means "follow the OS".
		if (props.scheme === 'dark' || props.scheme === 'light') {
			root.setAttribute('data-color-scheme', props.scheme);
		}
		else {
			root.removeAttribute('data-color-scheme');
		}
		if (props.fontSize) root.style.setProperty('--zotero-font-size', props.fontSize + 'rem');
		if (props.density) root.setAttribute('zoteroUIDensity', props.density);
		// The canvas reads its background out of the stylesheet, so a scheme
		// arriving after the first paint has to be painted again.
		if (fg) repaint();
	};

	// The panel is a section of the sidebar, so collapsing it does not resize
	// the graph -- the pane keeps its width and the section folds inside it.
	function setCollapsed(on) {
		elPanel.classList.toggle('collapsed', on);
		elPanelToggle.setAttribute('aria-expanded', on ? 'false' : 'true');
		elPanelToggle.title = t(on ? 'panel-expand' : 'panel-collapse');
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
		elLegendToggle.title = t(on ? 'legend-expand' : 'legend-collapse');
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

	/**
	 * Repaint whatever was drawn before the strings landed.
	 *
	 * Almost nothing needs this: menus, tooltips, chips and the group card are
	 * built at the moment they are opened and ask for their strings then. What
	 * is left is the handful of things this file paints as it loads -- the two
	 * collapse tooltips, which depend on a state the markup cannot know -- and
	 * anything a payload that beat the strings across has already rendered.
	 *
	 * l10n.js runs this immediately if the strings are already in, so it is not
	 * a race either way.
	 */
	ZGL10n.onReady(() => {
		setCollapsed(elPanel.classList.contains('collapsed'));
		setLegendCollapsed(elLegend.classList.contains('collapsed'));
		// Same reason as the two above: the sidebar toggle's tooltip depends on
		// a state the markup cannot know, and a sidebar left open is the case
		// where setSideOpen() never ran to say so in the user's language.
		setSideOpen(!elFrame.classList.contains('side-closed'));
		if (raw) render();
	});

	window.addEventListener('resize', () => {
		if (fg) fg.width(elGraph.clientWidth).height(elGraph.clientHeight);
		// All of these were positioned against the viewport they opened in.
		hideMenu();
		hideAction();
		hideSuggest();
		hideSearch();
		closeGroup();
	});

	try {
		let saved = window.localStorage.getItem(PULL_KEY);
		// A stored value from a future build could be anything; the range input
		// silently drops one outside its own min/max, so read back what stuck.
		if (saved !== null) elLinkPull.value = saved;
	}
	catch (e) { /* see setCollapsed */ }
	applyLinkPull();

	try {
		let saved = window.localStorage.getItem(CENTER_KEY);
		if (saved !== null) elCenterPull.value = saved;
	}
	catch (e) { /* see setCollapsed */ }
	applyCenterPull();

	try {
		let saved = window.localStorage.getItem(DEPTH_KEY);
		if (saved !== null) elIsolateDepth.value = saved;
	}
	catch (e) { /* see setCollapsed */ }
	applyIsolateDepth();
	// A number box keeps a stored value its own min/max would reject, so the
	// clamp above has to be written back before it is ever read as the truth.
	elIsolateDepth.value = String(isolateDepth);

	syncEnabled();
}());
