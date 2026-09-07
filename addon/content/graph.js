/* global ForceGraph */

/**
 * Content-side renderer. Runs with an ordinary content principal inside a
 * <browser type="content">, so it has no Zotero/XPCOM access -- everything
 * arrives as a JSON string through window.zgSetData / window.zgSetStatus and
 * goes back out as a JSON string on a 'zg-event' CustomEvent.
 *
 * Every control here filters an already-built graph. Nothing in this file can
 * trigger a re-derivation except the Rebuild button, so toggling a strategy is
 * instant no matter how expensive it was to compute.
 */

(function () {
	'use strict';

	// Confidence at which an edge counts as publisher-asserted (a DOI the
	// typesetter embedded) rather than inferred from a title match.
	const ASSERTED = 0.9;

	let fg = null;
	let raw = null;
	let nodeCache = new Map(); // id -> node object, so x/y survive a re-render
	let disabledVia = new Set();

	let elGraph = document.getElementById('graph');
	let elStats = document.getElementById('stats');
	let elStatus = document.getElementById('status');
	let elName = document.getElementById('collection-name');
	let elMinConf = document.getElementById('min-conf');
	let elConfValue = document.getElementById('conf-value');
	let elStrategies = document.getElementById('strategies');
	let elHideIsolated = document.getElementById('hide-isolated');

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
		elName.textContent = (raw.collection && raw.collection.name) || '';
		renderStrategyToggles();
		// Only auto-hide unconnected nodes the first time edges show up; after
		// that the checkbox belongs to the user.
		if (firstEdges && !elHideIsolated.dataset.touched) {
			elHideIsolated.checked = true;
		}
		render();
	};

	window.zgSetStatus = function (text) {
		elStatus.textContent = text || '';
	};

	// --- strategy toggles -------------------------------------------------

	function viasPresent() {
		let seen = new Set();
		for (let e of (raw ? raw.edges : [])) {
			for (let v of e.via) seen.add(v);
		}
		return [...seen].sort();
	}

	let renderedVias = '';

	function renderStrategyToggles() {
		let vias = viasPresent();
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

	// --- rendering --------------------------------------------------------

	function year(item) {
		let m = String(item.date || '').match(/\b(1[89]\d\d|20\d\d)\b/);
		return m ? Number(m[1]) : null;
	}

	function render() {
		if (!raw) return;
		let min = Number(elMinConf.value);
		elConfValue.textContent = min.toFixed(2);

		let inDegree = Object.create(null);
		let outDegree = Object.create(null);
		let links = [];
		for (let e of raw.edges) {
			if (e.confidence < min) continue;
			// An edge survives if any strategy that produced it is still enabled.
			let via = e.via.filter(v => !disabledVia.has(v));
			if (!via.length) continue;
			links.push({
				source: e.from,
				target: e.to,
				confidence: e.confidence,
				via,
				doi: e.doi,
			});
			inDegree[e.to] = (inDegree[e.to] || 0) + 1;
			outDegree[e.from] = (outDegree[e.from] || 0) + 1;
		}

		let nodes = [];
		for (let it of raw.items) {
			let deg = (inDegree[it.key] || 0) + (outDegree[it.key] || 0);
			if (elHideIsolated.checked && !deg) continue;
			// Reuse the object so force-graph keeps the simulated position: later
			// build phases then add edges to a settled layout instead of
			// restarting it from scratch.
			let n = nodeCache.get(it.key);
			if (!n) {
				n = { id: it.key };
				nodeCache.set(it.key, n);
			}
			n.name = it.title;
			n.itemID = it.itemID;
			n.year = year(it);
			n.inDeg = inDegree[it.key] || 0;
			nodes.push(n);
		}

		if (!fg) {
			fg = ForceGraph()(elGraph);
			fg.onNodeClick(n => {
				if (n.itemID) emit({ type: 'open-item', itemID: n.itemID });
			});
		}

		fg.width(elGraph.clientWidth)
			.height(elGraph.clientHeight)
			.graphData({ nodes, links })
			.nodeId('id')
			.nodeLabel(n => escapeHtml(n.name)
				+ (n.year ? ' (' + n.year + ')' : '')
				+ (n.inDeg ? ' — cited by ' + n.inDeg + ' here' : ''))
			.nodeRelSize(4)
			// In-degree = how many papers in this collection cite it. Sizing by it
			// is the whole reason the graph is directed.
			.nodeVal(n => 1 + n.inDeg * 2)
			.nodeAutoColorBy('year')
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
		elStats.textContent = nodes.length + ' / ' + raw.items.length + ' items · '
			+ links.length + ' edges'
			+ (phase && phase !== 'done' ? ' · building…' : '');
	}

	const VIA_RANK = ['pdf-links', 'text-doi', 'title-match'];

	function bestVia(via) {
		for (let v of VIA_RANK) if (via.includes(v)) return v;
		return via[0];
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

	elMinConf.addEventListener('input', render);
	elHideIsolated.addEventListener('change', () => {
		elHideIsolated.dataset.touched = '1';
		render();
	});
	document.getElementById('rebuild').addEventListener('click', () => {
		elStatus.textContent = 'Rebuilding…';
		emit({ type: 'rebuild' });
	});

	window.addEventListener('resize', () => {
		if (fg) fg.width(elGraph.clientWidth).height(elGraph.clientHeight);
	});
}());
