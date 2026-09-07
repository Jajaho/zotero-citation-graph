/* global ForceGraph */

/**
 * Content-side renderer. Runs with an ordinary content principal inside a
 * <browser type="content">, so it has no Zotero/XPCOM access -- everything
 * arrives as a JSON string through window.zgSetData and goes back out as a
 * JSON string on a 'zg-event' CustomEvent.
 */

(function () {
	'use strict';

	let fg = null;
	let raw = null;

	let elGraph = document.getElementById('graph');
	let elStats = document.getElementById('stats');
	let elStatus = document.getElementById('status');
	let elName = document.getElementById('collection-name');
	let elMinConf = document.getElementById('min-conf');
	let elConfValue = document.getElementById('conf-value');

	function emit(msg) {
		window.dispatchEvent(new CustomEvent('zg-event', { detail: JSON.stringify(msg) }));
	}

	// Called from chrome via wrappedJSObject with a JSON string.
	window.zgSetData = function (json) {
		try {
			raw = JSON.parse(json);
		}
		catch (e) {
			elStatus.textContent = 'Bad payload: ' + e.message;
			return;
		}
		elName.textContent = (raw.collection && raw.collection.name) || '';
		elStatus.textContent = '';
		render();
	};

	function year(item) {
		let m = String(item.date || '').match(/\b(1[89]\d\d|20\d\d)\b/);
		return m ? Number(m[1]) : null;
	}

	function render() {
		if (!raw) return;
		let min = Number(elMinConf.value);
		elConfValue.textContent = min.toFixed(2);

		let inDegree = Object.create(null);
		let links = [];
		for (let e of raw.edges) {
			if (e.confidence < min) continue;
			links.push({
				source: e.from,
				target: e.to,
				confidence: e.confidence,
				via: e.via || [],
			});
			inDegree[e.to] = (inDegree[e.to] || 0) + 1;
		}

		let nodes = raw.items.map(it => ({
			id: it.key,
			name: it.title,
			itemID: it.itemID,
			year: year(it),
			inDeg: inDegree[it.key] || 0,
		}));

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
			.nodeLabel(n => n.name + (n.year ? ' (' + n.year + ')' : ''))
			.nodeRelSize(4)
			// In-degree = how many papers in this collection cite it. Sizing by it
			// is the whole reason the graph is directed.
			.nodeVal(n => 1 + n.inDeg * 2)
			.nodeAutoColorBy('year')
			.linkDirectionalArrowLength(4)
			.linkDirectionalArrowRelPos(1)
			.linkCurvature(0.08)
			// DOI-derived edges are publisher-asserted; title-derived ones are
			// inferred, so draw them lighter.
			.linkColor(l => (l.confidence >= 0.9 ? 'rgba(70,140,210,0.85)' : 'rgba(150,150,150,0.45)'))
			.linkWidth(l => (l.confidence >= 0.9 ? 1.4 : 0.8))
			.d3VelocityDecay(0.3);

		elStats.textContent = nodes.length + ' items · ' + links.length + ' edges';
	}

	elMinConf.addEventListener('input', render);
	document.getElementById('rebuild').addEventListener('click', () => {
		elStatus.textContent = 'Rebuilding…';
		emit({ type: 'rebuild' });
	});

	window.addEventListener('resize', () => {
		if (fg) fg.width(elGraph.clientWidth).height(elGraph.clientHeight);
	});
}());
