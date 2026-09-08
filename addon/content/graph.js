/* global ForceGraph, ZGScale, ZGLinks, ZGFilters */

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
	/** Layout comfort, not a view of the data: how hard the user likes their
	 *  edges to pull. Worth remembering across windows for the same reason the
	 *  collapsed panel is -- it is a setting about this screen, not this graph. */
	const PULL_KEY = 'zg.link.pull';

	// Published by nodeScale.js, nodeLinks.js and nodeFilters.js, which
	// graph.html loads first.
	const Scale = ZGScale;
	const Links = ZGLinks;
	const Filters = ZGFilters;

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
	let elAction = el('action');
	let elMenu = el('menu');
	let elIsolate = el('isolate-clear');
	let elReframe = el('reframe');
	let elPanel = el('panel');
	let elPanelToggle = el('panel-toggle');
	let elLegend = el('legend');
	let elLegendToggle = el('legend-toggle');
	let elLegendTitle = el('legend-title');
	let elLegendBody = el('legend-body');
	let elFilterChips = el('filter-chips');
	let elFilterInput = el('filter-input');
	let elSuggest = el('filter-suggest');

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
		if (isPinned(n)) bits.push('pinned');
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
		if (isPinned(n)) bits.push('pinned');
		bits.push('double-click to select in Zotero · right-click for actions');
		return escapeHtml(n.name) + (n.year ? ' (' + n.year + ')' : '')
			+ '<br/>' + bits.join(' · ');
	}

	// --- colour -----------------------------------------------------------

	function colorKey(n) {
		switch (elColorBy.value) {
			case 'collection': return (n.collections || [])[0] || '(no collection)';
			case 'author': return (n.creators || [])[0] || '(no author)';
			case 'publication': return n.publication || '(no publication)';
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
		publication: 'publication',
		type: 'item type',
	};

	// Author and collection have long tails: a legend with two hundred rows is
	// a wall, and each row past this one explains a single node.
	const LEGEND_MAX = 12;

	function renderLegend(nodes) {
		let mode = elColorBy.value;
		// Titled as the sentence the user just made in the panel -- "coloured by
		// year" -- rather than the bare noun, so the legend says what it is a
		// legend FOR without the panel having to be open beside it.
		let title = 'Coloured by ' + (LEGEND_TITLE[mode] || mode);
		elLegendTitle.textContent = title;
		// One narrow line, and it ellipsises; the tooltip carries the rest.
		elLegendTitle.title = title;
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

	// --- filter masks -----------------------------------------------------

	/**
	 * The masks currently laid down, oldest first. AND commutes, so the order
	 * carries no meaning -- it is kept only so a chip does not jump around the
	 * panel when another one is removed.
	 */
	let filters = [];

	/**
	 * Which chip the box is currently authoring, or -1 for none.
	 *
	 * A mask holds several values that OR, so building one is not a single
	 * gesture: pick "Nature", then "Science", then "APL". Rather than make the
	 * user finish the list before seeing anything, the chip is committed on the
	 * first pick and then rewritten in place on every one after -- the graph
	 * widens under the pointer as the list grows. This index is what says
	 * "rewrite" instead of "add a second chip".
	 */
	let editing = -1;

	/** A raw item in the shape nodeFilters.js matches against. */
	function itemFacets(it) {
		return Filters.facets({
			creators: it.creators,
			year: year(it),
			itemType: it.itemType,
			publication: it.publication,
			collections: it.collections,
			title: it.title,
		});
	}

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

	/**
	 * Whatever is in the box becomes a mask: a new chip, or the one being
	 * edited rewritten in place.
	 */
	function commit() {
		let f = Filters.parse(elFilterInput.value);
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
		render();
	}

	/** The box is done with whatever it was authoring. The chip keeps every
	 *  term that was committed; a half-typed one was never part of it. */
	function endEdit() {
		editing = -1;
		elFilterInput.value = '';
	}

	function removeFilter(i) {
		filters.splice(i, 1);
		if (editing === i) endEdit();
		else if (editing > i) editing--;
		renderChips();
		render();
	}

	/**
	 * Put a chip back in the box with a trailing comma, ready for more values.
	 * This is the only way to reach a value that the chip's own width has
	 * clipped, and the only way to drop one value out of several.
	 */
	function editChip(i) {
		editing = i;
		elFilterInput.value = Filters.toInput(filters[i]) + ', ';
		elFilterInput.focus();
		refreshSuggest();
	}

	function renderChips() {
		elFilterChips.textContent = '';
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
			x.title = 'Lift this mask';
			x.addEventListener('click', () => removeFilter(i));
			chip.appendChild(text);
			chip.appendChild(x);
			elFilterChips.appendChild(chip);
		});
		elFilterChips.hidden = !filters.length;
	}

	/** The chip is clipped to the panel width, so the long form -- every value,
	 *  and which of them are exact -- has to be reachable on hover. */
	function chipHint(f) {
		let what = f.field || 'any field';
		let bits = f.terms.map((t) => {
			if (t.op === 'range') {
				if (t.lo != null && t.hi != null) {
					return t.lo === t.hi ? 'is ' + t.lo : 'is between ' + t.lo + ' and ' + t.hi;
				}
				return t.lo != null ? 'is ' + t.lo + ' or later' : 'is ' + t.hi + ' or earlier';
			}
			return (t.op === 'is' ? 'is exactly ' : 'contains ') + '"' + t.value + '"';
		});
		// "or", because terms widen. It is the chips between them that narrow.
		return what + ' ' + bits.join(', or ') + '\nClick to edit';
	}

	// --- the completion list ----------------------------------------------

	// A list taller than this is a wall, not a menu.
	const SUGGEST_MAX_PX = 240;

	let suggestions = [];
	// -1 means nothing is highlighted, which is a state in its own right:
	// Enter then commits whatever was typed rather than a row.
	let suggestIndex = -1;

	/**
	 * Rebuild the list under the box.
	 *
	 * The candidates come from the items that survive the other masks, never
	 * from the whole collection. That is what makes the list narrow as chips
	 * stack, and it means anything offered here is guaranteed to leave
	 * something on screen rather than emptying the graph.
	 */
	function refreshSuggest() {
		if (!raw) return;
		suggestions = Filters.suggest(elFilterInput.value, masked(editing).facets);
		suggestIndex = -1;
		elSuggest.textContent = '';
		for (let i = 0; i < suggestions.length; i++) {
			elSuggest.appendChild(suggestRow(suggestions[i], i));
		}
		let open = suggestions.length > 0;
		elSuggest.hidden = !open;
		elFilterInput.setAttribute('aria-expanded', open ? 'true' : 'false');
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
		let r = elFilterInput.getBoundingClientRect();
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
		elFilterInput.setAttribute('aria-expanded', 'false');
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
	 * so the chip and the graph both move on the first pick -- and the box is
	 * left with a trailing comma and the list still open, so the pick after it
	 * widens the same mask instead of starting a new one.
	 */
	function accept(i) {
		let s = suggestions[i];
		if (!s) return;
		// A field name is only half a filter. Put it in the box and let the
		// list come straight back with that field's values.
		if (s.insert) {
			elFilterInput.value = s.insert;
			refreshSuggest();
			return;
		}
		elFilterInput.value = Filters.spliceTerm(elFilterInput.value, s.field, s.term);
		commit();
		refreshSuggest();
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

	elFilterInput.addEventListener('input', refreshSuggest);
	// On focus too, and with an empty box: with nothing typed the list is the
	// only thing that says which fields exist at all.
	elFilterInput.addEventListener('focus', refreshSuggest);
	// After the row's own mousedown, which fires first and may have accepted.
	// Leaving the box ends the edit: everything committed is on the chip
	// already, so there is nothing in the text worth keeping.
	elFilterInput.addEventListener('blur', () => window.setTimeout(() => {
		hideSuggest();
		if (editing >= 0) {
			endEdit();
			renderChips();
		}
	}, 0));

	elFilterInput.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (elSuggest.hidden) refreshSuggest();
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
			// The window handler further down would clear the isolation. Inside
			// this box Escape belongs to the list first and then to the box, and
			// must not reach past either.
			e.stopPropagation();
			if (!elSuggest.hidden) hideSuggest();
			else if (editing >= 0) {
				endEdit();
				renderChips();
			}
			else elFilterInput.value = '';
			return;
		}
		// Backspace on an empty box lifts the last mask -- the gesture everyone
		// already has from every other chips-in-front-of-an-input there is.
		if (e.key === 'Backspace' && !elFilterInput.value && filters.length) {
			removeFilter(filters.length - 1);
		}
	});

	renderChips();

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
		let held = masked(-1).items;
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
		for (let it of held) {
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
			// force-graph registers 'link' itself, so this reaches in and
			// reprices it rather than replacing it -- the arrows, curvature and
			// endpoint resolution all belong to that force.
			fg.d3Force('link').strength(linkStrength);
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
			.nodeCanvasObject(drawNode)
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
		drawPin(node, ctx, globalScale);
		drawLabel(node, ctx, globalScale);
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
		return (n.fx != null || n.fy != null) && n !== heldNode;
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
		n.fx = n.x;
		n.fy = n.y;
		repaint();
	}

	function unpin(n) {
		// Released, but not thrown back into the layout: reheating would move
		// every other node too, and taking one pin out is no reason to reshuffle
		// a graph the user has spent time arranging. It rejoins the flow the
		// next time something else stirs the simulation.
		delete n.fx;
		delete n.fy;
		repaint();
	}

	/** force-graph stops redrawing once the simulation has cooled, so a change
	 *  that is purely visual has to announce itself. Re-setting a visual
	 *  accessor is what marks the canvas dirty. */
	function repaint() {
		if (fg) fg.nodeCanvasObject(drawNode);
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
		// A menu replaced rather than dismissed still owes the previous node
		// its freedom.
		release();
		elMenu.textContent = '';
		let entries = n.ghost ? ghostMenu(n) : itemMenu(n);
		// Last, and shared by both populations, because it is the one entry
		// about the picture rather than the paper: where a node sits is a fact
		// about this layout, and an outside reference has one as much as a held
		// item does.
		entries.push(pinEntry(n));
		for (let entry of entries) {
			elMenu.appendChild(menuItem(entry));
		}
		elMenu.hidden = false;
		positionAt(elMenu, event);
	}

	function hideMenu() {
		elMenu.hidden = true;
		// Every way out of the menu comes through here -- Escape, a click on
		// the canvas, picking an entry, a rebuild landing -- so this is the one
		// place the hold has to be given up. Picking "Pin node here" releases
		// and then re-fixes the node at coordinates nothing has had a chance to
		// change, which is the same spot.
		release();
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

	function pinEntry(n) {
		let pinned = isPinned(n);
		return {
			label: pinned ? 'Unpin node' : 'Pin node here',
			hint: pinned
				? 'let the layout move it again'
				: 'hold it at this spot; drag it to move the pin',
			run: () => (pinned ? unpin(n) : pin(n)),
		};
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
				// Chrome answers by opening a reader beside the graph, in this same
				// tab. Whether the item HAS a readable attachment is not knowable
				// here -- the payload carries items, not their files -- so this is
				// always offered, and chrome says so on the status line when there
				// is nothing to open.
				label: 'Open PDF beside the graph',
				hint: 'read it here, without leaving the graph',
				disabled: !n.itemID,
				run: () => emit({ type: 'open-pdf', itemID: n.itemID }),
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
	// Pure layout: no node or edge changes, so this reheats rather than renders.
	elLinkPull.addEventListener('input', () => {
		applyLinkPull();
		try {
			window.localStorage.setItem(PULL_KEY, elLinkPull.value);
		}
		catch (e) { /* no persistence, no problem */ }
	});
	elMinCites.addEventListener('input', render);
	elColorBy.addEventListener('change', render);
	// Size changes node radii, which the collision force sizes its grid from --
	// re-registering it is what makes it pick the new radii up.
	elSizeBy.addEventListener('change', () => {
		// Picking "global citations" IS the request for the counts it needs, so
		// it fetches them instead of refusing to be picked until someone finds
		// the checkbox that would have allowed it. The graph rescales itself
		// when the lookup lands; until then every node is the same unknown dot,
		// which is what the status line is reporting on.
		if (elSizeBy.value === 'global' && !elEnrich.checked) {
			elEnrich.checked = true;
			requestRebuild();
		}
		render();
		if (fg) fg.d3Force('collide', collide()).d3ReheatSimulation();
	});
	elHideIsolated.addEventListener('change', () => {
		elHideIsolated.dataset.touched = '1';
		render();
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
		// All three were positioned against the viewport they opened in.
		hideMenu();
		hideAction();
		hideSuggest();
	});

	try {
		let saved = window.localStorage.getItem(PULL_KEY);
		// A stored value from a future build could be anything; the range input
		// silently drops one outside its own min/max, so read back what stuck.
		if (saved !== null) elLinkPull.value = saved;
	}
	catch (e) { /* see setCollapsed */ }
	applyLinkPull();

	syncEnabled();
}());
