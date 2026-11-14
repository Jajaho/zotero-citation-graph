/**
 * The graph as a file: SVG for a figure, GraphML for another tool.
 *
 * Pure, for the reason nodeScale.js and labelLayout.js are: the page hands this
 * plain numbers and strings -- where each circle is, what it is filled with,
 * the outline of every edge -- and gets a document back. Nothing in here reads
 * the DOM, force-graph or the page's state, so tools/test-cjs-shim.js can run
 * the same file and parse what it writes.
 *
 * The SVG is written from the page's own geometry rather than captured from
 * the canvas, because the canvas is pixels and a figure has to be paths. Names
 * stay <text>, never outlines, so that `inkscape --export-latex` can hand them
 * to LaTeX to typeset in the paper's own font.
 *
 * Loaded as a plain <script> and published as a global; the content page has no
 * module loader.
 */
(function (global) {
	'use strict';

	var SVGNS = 'http://www.w3.org/2000/svg';

	// --- XML ------------------------------------------------------------

	/**
	 * Text and attribute values, escaped. Control characters are dropped rather
	 * than escaped: XML 1.0 has no way to carry most of them at all, and a title
	 * that came off the network or out of a PDF can hold one -- which would make
	 * the whole file unreadable to every tool it is written for.
	 */
	function esc(s) {
		return String(s == null ? '' : s)
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
			.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
			.replace(/[&<>"']/g, function (c) {
				return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
			});
	}

	var POW = [1, 10, 100, 1e3, 1e4, 1e5, 1e6];

	/** As many decimals as anything in here is ever written with, and what the
	 *  path recorder keeps: it traces before the figure's zoom is known. */
	var RAW = POW.length - 1;

	/** A coordinate, short: two decimals unless told otherwise, which keeps a
	 *  big graph's file from being mostly digits. Never "-0", which some
	 *  parsers read as a string. */
	function num(v, dp) {
		var f = POW[dp == null ? 2 : dp] || 100;
		var n = Math.round((Number(v) || 0) * f) / f;
		return n === 0 ? '0' : String(n);
	}

	/**
	 * How many decimals a graph-unit coordinate needs in a figure taken at this
	 * zoom.
	 *
	 * Two is a hundredth of a graph unit, and at zoom 1 that is a hundredth of
	 * a pixel: far below anything a figure can show. Zoomed in it is not. A
	 * line a pixel wide is 0.0025 units wide at 400x, and two decimals put
	 * both of its sides on the same coordinate -- an outline with nothing
	 * inside it, so the edge is simply not in the file, and every circle sits
	 * up to two pixels from where it was drawn. One more decimal for each
	 * factor of ten keeps what is written to a hundredth of a screen pixel at
	 * any zoom, and leaves a figure taken at zoom 1 or below exactly as short
	 * as it was.
	 */
	function decimals(scale) {
		if (!(scale > 1)) return 2;
		return Math.min(RAW, 2 + Math.ceil(Math.log10(scale) - 1e-9));
	}

	// --- paint ----------------------------------------------------------

	/**
	 * A CSS colour as SVG 1.1 can carry it: an opaque hex and a separate
	 * opacity. The page paints with rgba() -- that is how confidence and
	 * isolation are drawn -- and rgba() in a fill attribute is SVG 2, which
	 * Inkscape and most print pipelines read as black.
	 */
	function paint(color) {
		var s = String(color || '').trim();
		var m;
		if ((m = /^#([0-9a-f]{3,8})$/i.exec(s))) {
			var h = m[1];
			if (h.length === 3 || h.length === 4) {
				h = h.split('').map(function (c) { return c + c; }).join('');
			}
			if (h.length === 6) return { c: '#' + h.toLowerCase(), a: 1 };
			if (h.length === 8) {
				return { c: '#' + h.slice(0, 6).toLowerCase(), a: round3(parseInt(h.slice(6), 16) / 255) };
			}
		}
		if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(s))) {
			var a = m[4] == null ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
			return { c: hex(m[1], m[2], m[3]), a: round3(Math.max(0, Math.min(1, a))) };
		}
		return { c: s || '#000000', a: 1 };
	}

	function round3(v) {
		return Math.round(v * 1000) / 1000;
	}

	function hex(r, g, b) {
		return '#' + [r, g, b].map(function (v) {
			return Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, '0');
		}).join('');
	}

	/** fill="..." and, only when it is not opaque, fill-opacity="...". */
	function fillAttrs(color, which) {
		var p = paint(color);
		var attr = which || 'fill';
		return attr + '="' + esc(p.c) + '"' + (p.a < 1 ? ' ' + attr + '-opacity="' + p.a + '"' : '');
	}

	// --- path data ------------------------------------------------------

	/**
	 * A stand-in for a canvas context that writes SVG path data instead of
	 * drawing. The page traces each edge's outline with exactly the calls it
	 * makes on the canvas, into one of these -- so the figure's edges are the
	 * screen's edges, head and bow and all, from the one function that knows how
	 * they are shaped.
	 *
	 * Written at RAW decimals, not at the figure's: the tracer runs before
	 * svg() is handed the zoom, and svg() shortens each outline to what that
	 * zoom can show as it reads it -- see fitPath().
	 */
	function PathRecorder() {
		this.parts = [];
	}
	PathRecorder.prototype.moveTo = function (x, y) {
		this.parts.push('M' + num(x, RAW) + ' ' + num(y, RAW));
	};
	PathRecorder.prototype.lineTo = function (x, y) {
		this.parts.push('L' + num(x, RAW) + ' ' + num(y, RAW));
	};
	PathRecorder.prototype.quadraticCurveTo = function (cx, cy, x, y) {
		this.parts.push('Q' + num(cx, RAW) + ' ' + num(cy, RAW) + ' ' + num(x, RAW) + ' ' + num(y, RAW));
	};
	PathRecorder.prototype.closePath = function () {
		this.parts.push('Z');
	};
	/** What has been traced since the last take(), and a clean slate after it. */
	PathRecorder.prototype.take = function () {
		var d = this.parts.join('');
		this.parts = [];
		return d;
	};

	// Only what the recorder writes: absolute M, L, Q and Z over plain numbers.
	var PATH_OURS = /^[MLQZ\d\s,.eE+-]*$/;
	var PATH_STEP = /([MLQ])([^MLQZ]*)|Z/g;

	/** Where a quadratic from p0 past control c to p2 turns round on one axis,
	 *  or p0 when it does not turn between its ends. */
	function quadTurn(p0, c, p2) {
		var den = p0 - 2 * c + p2;
		if (den === 0) return p0;
		var t = (p0 - c) / den;
		if (!(t > 0 && t < 1)) return p0;
		var s = 1 - t;
		return s * s * p0 + 2 * s * t * c + t * t * p2;
	}

	/**
	 * A recorded outline, at `dp` decimals, with everywhere it reaches handed
	 * to grow(x0, y0, x1, y1).
	 *
	 * The reach is the curve's own, not its control point's: a bow's control
	 * point stands twice as far off the chord as the bow itself ever gets, and
	 * a figure sized to hold it would have a margin of nothing down one side.
	 *
	 * Anything that is not the recorder's own notation comes back untouched and
	 * unmeasured, rather than being read as something it is not.
	 */
	function fitPath(d, dp, grow) {
		d = String(d);
		if (!PATH_OURS.test(d)) return d;
		var out = '';
		var px = 0;
		var py = 0;
		var m;
		PATH_STEP.lastIndex = 0;
		while ((m = PATH_STEP.exec(d))) {
			if (!m[1]) {
				out += 'Z';
				continue;
			}
			var v = m[2].trim().split(/[\s,]+/).map(Number);
			if (v.length !== (m[1] === 'Q' ? 4 : 2) || v.some(isNaN)) return d;
			var x = v[v.length - 2];
			var y = v[v.length - 1];
			if (m[1] === 'Q') {
				var tx = quadTurn(px, v[0], x);
				var ty = quadTurn(py, v[1], y);
				grow(tx, ty, tx, ty);
			}
			grow(x, y, x, y);
			px = x;
			py = y;
			out += m[1] + v.map(function (n) { return num(n, dp); }).join(' ');
		}
		return out;
	}

	/** One wedge of a circle, clockwise from `from` to `to` (radians, 0 = three
	 *  o'clock, as on the canvas). */
	function wedge(x, y, r, from, to, dp) {
		var x0 = x + r * Math.cos(from);
		var y0 = y + r * Math.sin(from);
		var x1 = x + r * Math.cos(to);
		var y1 = y + r * Math.sin(to);
		var large = to - from > Math.PI ? 1 : 0;
		return 'M' + num(x, dp) + ' ' + num(y, dp) + 'L' + num(x0, dp) + ' ' + num(y0, dp)
			+ 'A' + num(r, dp) + ' ' + num(r, dp) + ' 0 ' + large + ' 1 ' + num(x1, dp) + ' ' + num(y1, dp) + 'Z';
	}

	// --- SVG ------------------------------------------------------------

	// The legend is laid out in screen pixels and scaled into the graph, so it
	// prints at the size it reads at on screen next to a graph at that zoom.
	var LEGEND = {
		font: 12,      // px
		row: 18,       // px from one row's baseline to the next
		dot: 5,        // swatch radius
		indent: 18,    // where a row's name starts
		gap: 12,       // between a name and its count
		block: 10,     // between the node legend and the edge legend
		ramp: 140,     // width of the year ramp
		rampH: 10,
		margin: 24,    // between the graph and the legend
	};

	var PAD = 16; // px of air round the whole figure

	/**
	 * The figure.
	 *
	 * @param {object} scene  graph units throughout unless a field says px:
	 *   scale   screen px per graph unit -- the zoom the picture was taken at
	 *   theme   { bg, fg, muted }
	 *   edges   [{ d, fill }]                      outlines, already traced
	 *   nodes   [{ x, y, r, fill, slices, ring, title }]
	 *           slices: [paint] or null, cut clockwise from twelve o'clock;
	 *           solid: whether the first slice is laid whole under the rest
	 *           ring: { r, width, color } or null
	 *   labels  [{ x, y, px, w, text, fill, halo }]  px and w in graph units
	 *   legend  { title, ramp, rows, more, edges } or null; see legendSvg()
	 *   title   what the document is called
	 * @param {function} measure  (text, px) -> width in px, for the legend
	 */
	function svg(scene, measure) {
		var s = scene.scale > 0 ? scene.scale : 1;
		var theme = scene.theme || {};
		measure = measure || function (text, px) { return String(text).length * px * 0.6; };
		// Graph units are written through g(); px -- the legend, the size of the
		// figure -- keep num()'s two decimals at any zoom.
		var dp = decimals(s);
		function g(v) { return num(v, dp); }

		// The extent of what is drawn: every circle, ring, name and edge.
		var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		function grow(ax, ay, bx, by) {
			if (ax < x0) x0 = ax;
			if (ay < y0) y0 = ay;
			if (bx > x1) x1 = bx;
			if (by > y1) y1 = by;
		}
		(scene.nodes || []).forEach(function (n) {
			var r = n.ring ? Math.max(n.r, n.ring.r + n.ring.width / 2) : n.r;
			grow(n.x - r, n.y - r, n.x + r, n.y + r);
		});
		(scene.labels || []).forEach(function (l) {
			grow(l.x - l.w / 2, l.y - l.px / 2, l.x + l.w / 2, l.y + l.px / 2);
		});
		// Edges too. A straight one never leaves the box its two circles span,
		// but a bow does: LINK_CURVE of its length to one side, which for a long
		// edge along the rim of the graph is further than the padding below, and
		// the root element clips what its viewBox does not hold.
		var edges = [];
		(scene.edges || []).forEach(function (e) {
			if (e.d) edges.push({ d: fitPath(e.d, dp, grow), fill: e.fill });
		});
		if (!(x1 >= x0)) {
			x0 = y0 = 0;
			x1 = y1 = 1;
		}
		var pad = PAD / s;
		x0 -= pad;
		y0 -= pad;
		x1 += pad;
		y1 += pad;

		var legend = scene.legend ? legendSvg(scene.legend, theme, measure) : null;
		var gw = x1 - x0;
		var gh = y1 - y0;
		var w = gw;
		var h = gh;
		if (legend) {
			w += (LEGEND.margin + legend.w + PAD) / s - pad;
			h = Math.max(gh, (legend.h + 2 * PAD) / s);
		}

		var out = [];
		out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
		out.push('<svg xmlns="' + SVGNS + '" version="1.1"'
			+ ' width="' + Math.ceil(w * s) + '" height="' + Math.ceil(h * s) + '"'
			+ ' viewBox="' + g(x0) + ' ' + g(y0) + ' ' + g(w) + ' ' + g(h) + '">');
		if (scene.title) out.push('<title>' + esc(scene.title) + '</title>');
		if (legend && legend.defs) out.push('<defs>' + legend.defs + '</defs>');
		if (theme.bg) {
			out.push('<rect id="background" x="' + g(x0) + '" y="' + g(y0)
				+ '" width="' + g(w) + '" height="' + g(h) + '" ' + fillAttrs(theme.bg) + '/>');
		}

		out.push('<g id="edges">');
		edges.forEach(function (e) {
			out.push('<path d="' + e.d + '" ' + fillAttrs(e.fill) + '/>');
		});
		out.push('</g>');

		out.push('<g id="nodes">');
		(scene.nodes || []).forEach(function (n) {
			var tip = n.title ? '<title>' + esc(n.title) + '</title>' : '';
			if (n.slices && n.slices.length > 1) {
				var parts = [];
				var step = 2 * Math.PI / n.slices.length;
				var first = 0;
				if (n.solid) {
					parts.push(circle(n.x, n.y, n.r, fillAttrs(n.slices[0]), dp));
					first = 1;
				}
				for (var i = first; i < n.slices.length; i++) {
					var from = -Math.PI / 2 + i * step;
					parts.push('<path d="' + wedge(n.x, n.y, n.r, from, from + step, dp) + '" '
						+ fillAttrs(n.slices[i]) + '/>');
				}
				out.push('<g>' + tip + parts.join('') + '</g>');
			}
			else if (tip) {
				out.push('<circle cx="' + g(n.x) + '" cy="' + g(n.y) + '" r="' + g(n.r) + '" '
					+ fillAttrs(n.fill) + '>' + tip + '</circle>');
			}
			else {
				out.push(circle(n.x, n.y, n.r, fillAttrs(n.fill), dp));
			}
			if (n.ring) {
				out.push('<circle cx="' + g(n.x) + '" cy="' + g(n.y) + '" r="' + g(n.ring.r)
					+ '" fill="none" ' + fillAttrs(n.ring.color, 'stroke')
					+ ' stroke-width="' + g(n.ring.width) + '"/>');
			}
		});
		out.push('</g>');

		// Names last, so no circle can bury one -- the canvas's own order. The
		// halo is the page background stroked under the glyphs; paint-order is
		// what keeps it under them in one element, and a reader that does not
		// know paint-order still draws the name, just without the halo.
		out.push('<g id="labels" font-family="sans-serif" text-anchor="middle" stroke-linejoin="round">');
		(scene.labels || []).forEach(function (l) {
			// The canvas centres a name on its node with textBaseline 'middle';
			// SVG 1.1 has only the baseline, which sits about a third of the type
			// size below that middle in any sans.
			var attrs = 'x="' + g(l.x) + '" y="' + g(l.y + l.px * 0.35) + '" font-size="' + g(l.px) + '" '
				+ fillAttrs(l.fill);
			if (l.halo && theme.bg) {
				attrs += ' ' + fillAttrs(theme.bg, 'stroke') + ' stroke-width="' + g(l.px * 0.3)
					+ '" paint-order="stroke"';
			}
			out.push('<text ' + attrs + '>' + esc(l.text) + '</text>');
		});
		out.push('</g>');

		if (legend) {
			var lx = x1 - pad + LEGEND.margin / s;
			var ly = y0 + pad;
			out.push('<g id="legend" transform="translate(' + g(lx) + ' ' + g(ly) + ') scale(' + (1 / s) + ')"'
				+ ' font-family="sans-serif" font-size="' + LEGEND.font + '">');
			out.push(legend.body);
			out.push('</g>');
		}

		out.push('</svg>');
		return out.join('\n') + '\n';
	}

	function circle(x, y, r, fill, dp) {
		return '<circle cx="' + num(x, dp) + '" cy="' + num(y, dp) + '" r="' + num(r, dp) + '" ' + fill + '/>';
	}

	/**
	 * The legend, laid out in px from its own top-left.
	 *
	 *   title  what the node colours are a legend for
	 *   ramp   { stops: [colour], lo, hi } for year, or null
	 *   rows   [{ color, label, count }]
	 *   more   the "and N more" line, or null
	 *   edges  { title, rows: [{ color, label }] } or null
	 */
	function legendSvg(legend, theme, measure) {
		var L = LEGEND;
		var fg = theme.fg || '#000000';
		var muted = theme.muted || fg;
		var body = [];
		var defs = '';
		var y = 0;
		var w = 0;

		function text(x, ty, s, extra) {
			body.push('<text x="' + num(x) + '" y="' + num(ty) + '"' + (extra || '') + '>' + esc(s) + '</text>');
		}

		function heading(s) {
			y += L.font;
			text(0, y, s, ' font-weight="bold" ' + fillAttrs(fg));
			w = Math.max(w, measure(s, L.font) * 1.1);
			y += L.row - L.font;
		}

		if (legend.title) heading(legend.title);

		if (legend.ramp && legend.ramp.stops && legend.ramp.stops.length) {
			var stops = legend.ramp.stops;
			defs = '<linearGradient id="legend-ramp" x1="0" y1="0" x2="1" y2="0">'
				+ stops.map(function (c, i) {
					var p = paint(c);
					return '<stop offset="' + num(stops.length > 1 ? i / (stops.length - 1) : 0)
						+ '" stop-color="' + esc(p.c) + '"' + (p.a < 1 ? ' stop-opacity="' + p.a + '"' : '') + '/>';
				}).join('')
				+ '</linearGradient>';
			y += 4;
			body.push('<rect x="0" y="' + num(y) + '" width="' + L.ramp + '" height="' + L.rampH
				+ '" fill="url(#legend-ramp)"/>');
			y += L.rampH + L.font + 2;
			text(0, y, legend.ramp.lo, ' ' + fillAttrs(muted));
			text(L.ramp, y, legend.ramp.hi, ' text-anchor="end" ' + fillAttrs(muted));
			w = Math.max(w, L.ramp);
			y += L.row - L.font;
		}

		var rows = legend.rows || [];
		var nameW = 0;
		var countW = 0;
		rows.forEach(function (r) {
			nameW = Math.max(nameW, measure(r.label, L.font));
			countW = Math.max(countW, measure(String(r.count), L.font));
		});
		var countX = L.indent + nameW + L.gap + countW;
		rows.forEach(function (r) {
			y += L.font;
			body.push('<circle cx="' + L.dot + '" cy="' + num(y - L.font * 0.35) + '" r="' + L.dot + '" '
				+ fillAttrs(r.color) + '/>');
			text(L.indent, y, r.label, ' ' + fillAttrs(fg));
			text(countX, y, r.count, ' text-anchor="end" ' + fillAttrs(muted));
			y += L.row - L.font;
		});
		if (rows.length) w = Math.max(w, countX);
		if (legend.more) {
			y += L.font;
			text(L.indent, y, legend.more, ' font-style="italic" ' + fillAttrs(muted));
			w = Math.max(w, L.indent + measure(legend.more, L.font));
			y += L.row - L.font;
		}

		var edges = legend.edges;
		if (edges && edges.rows && edges.rows.length) {
			if (y > 0) y += L.block;
			if (edges.title) heading(edges.title);
			edges.rows.forEach(function (r) {
				y += L.font;
				var my = y - L.font * 0.35;
				body.push('<line x1="0" y1="' + num(my) + '" x2="' + (L.indent - 4) + '" y2="' + num(my)
					+ '" stroke-width="2" ' + fillAttrs(r.color, 'stroke') + '/>');
				text(L.indent, y, r.label, ' ' + fillAttrs(fg));
				w = Math.max(w, L.indent + measure(r.label, L.font));
				y += L.row - L.font;
			});
		}

		if (!body.length) return null;
		return { body: body.join('\n'), defs: defs, w: w, h: y };
	}

	// --- GraphML --------------------------------------------------------

	/**
	 * Every attribute the file declares, in the order it declares them.
	 *
	 * The names are what Gephi recognises as well as what a person reads: it
	 * takes `label`, `x`, `y`, `size`, `r`, `g`, `b` and an edge's `weight` as
	 * the drawing rather than as data. yEd recognises none of them and reads its
	 * own yFiles graphics instead -- the `ng`/`eg` keys below -- so the layout
	 * and the colours are written twice, once for each.
	 */
	var NODE_KEYS = [
		['label', 'string'],
		['title', 'string'],
		['first_author', 'string'],
		['creators', 'string'],
		['year', 'int'],
		['collection', 'string'],
		['subfield', 'string'],
		['item_type', 'string'],
		['publication', 'string'],
		['doi', 'string'],
		['held', 'boolean'],
		['cited_here', 'int'],
		['cited_global', 'int'],
		['color', 'string'],
		['r', 'int'],
		['g', 'int'],
		['b', 'int'],
		['size', 'double'],
		['x', 'double'],
		['y', 'double'],
	];
	var EDGE_KEYS = [
		['strategies', 'string'],
		['confidence', 'double'],
		['weight', 'double'],
		['doi', 'string'],
		['color', 'string'],
	];

	/**
	 * The graph as data.
	 *
	 * @param {object} graph
	 *   description  what the graph is of
	 *   nodes  [{ id, label, title, firstAuthor, creators, year, collections,
	 *             subfield, itemType, publication, doi, held, citedHere,
	 *             citedGlobal, color, x, y, r }]
	 *   edges  [{ source, target, strategies, confidence, doi, color }]
	 */
	function graphml(graph) {
		var out = [];
		out.push('<?xml version="1.0" encoding="UTF-8"?>');
		out.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns"'
			+ ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
			+ ' xmlns:y="http://www.yworks.com/xml/graphml"'
			+ ' xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns'
			+ ' http://www.yworks.com/xml/schema/graphml/1.1/ygraphml.xsd">');
		out.push('  <key id="description" for="graph" attr.name="description" attr.type="string"/>');
		NODE_KEYS.forEach(function (k) {
			out.push('  <key id="n_' + k[0] + '" for="node" attr.name="' + k[0] + '" attr.type="' + k[1] + '"/>');
		});
		EDGE_KEYS.forEach(function (k) {
			out.push('  <key id="e_' + k[0] + '" for="edge" attr.name="' + k[0] + '" attr.type="' + k[1] + '"/>');
		});
		out.push('  <key id="ng" for="node" yfiles.type="nodegraphics"/>');
		out.push('  <key id="eg" for="edge" yfiles.type="edgegraphics"/>');
		out.push('  <graph id="G" edgedefault="directed">');
		if (graph.description) out.push('    <data key="description">' + esc(graph.description) + '</data>');

		(graph.nodes || []).forEach(function (n) {
			var p = paint(n.color || '#999999');
			var rgb = parseInt(p.c.slice(1), 16);
			var vals = {
				label: n.label,
				title: n.title,
				first_author: n.firstAuthor,
				creators: n.creators && n.creators.length ? n.creators.join('; ') : null,
				year: n.year,
				collection: n.collections && n.collections.length ? n.collections.join('; ') : null,
				subfield: n.subfield,
				item_type: n.itemType,
				publication: n.publication,
				doi: n.doi,
				held: n.held ? 'true' : 'false',
				cited_here: n.citedHere,
				cited_global: n.citedGlobal,
				color: p.c,
				r: isNaN(rgb) ? null : (rgb >> 16) & 255,
				g: isNaN(rgb) ? null : (rgb >> 8) & 255,
				b: isNaN(rgb) ? null : rgb & 255,
				size: n.r != null ? num(2 * n.r) : null,
				x: num(n.x),
				y: num(n.y),
			};
			out.push('    <node id="' + esc(n.id) + '">');
			NODE_KEYS.forEach(function (k) {
				var v = vals[k[0]];
				if (v == null || v === '') return;
				out.push('      <data key="n_' + k[0] + '">' + esc(v) + '</data>');
			});
			var d = 2 * (n.r || 1);
			out.push('      <data key="ng"><y:ShapeNode>'
				+ '<y:Geometry x="' + num(n.x - d / 2) + '" y="' + num(n.y - d / 2)
				+ '" width="' + num(d) + '" height="' + num(d) + '"/>'
				+ '<y:Fill color="' + esc(p.c.toUpperCase()) + '" transparent="false"/>'
				+ '<y:BorderStyle hasColor="false" type="line" width="1.0"/>'
				+ '<y:NodeLabel>' + esc(n.label || '') + '</y:NodeLabel>'
				+ '<y:Shape type="ellipse"/>'
				+ '</y:ShapeNode></data>');
			out.push('    </node>');
		});

		(graph.edges || []).forEach(function (e, i) {
			var p = paint(e.color || '#999999');
			var vals = {
				strategies: e.strategies && e.strategies.length ? e.strategies.join(', ') : null,
				confidence: e.confidence != null ? String(e.confidence) : null,
				weight: e.confidence != null ? String(e.confidence) : null,
				doi: e.doi,
				color: p.c,
			};
			out.push('    <edge id="e' + i + '" source="' + esc(e.source) + '" target="' + esc(e.target) + '">');
			EDGE_KEYS.forEach(function (k) {
				var v = vals[k[0]];
				if (v == null || v === '') return;
				out.push('      <data key="e_' + k[0] + '">' + esc(v) + '</data>');
			});
			out.push('      <data key="eg"><y:PolyLineEdge>'
				+ '<y:LineStyle color="' + esc(p.c.toUpperCase()) + '" type="line" width="1.0"/>'
				+ '<y:Arrows source="none" target="standard"/>'
				+ '</y:PolyLineEdge></data>');
			out.push('    </edge>');
		});

		out.push('  </graph>');
		out.push('</graphml>');
		return out.join('\n') + '\n';
	}

	global.ZGExport = {
		svg: svg,
		graphml: graphml,
		paint: paint,
		recorder: function () { return new PathRecorder(); },
		escapeXml: esc,
	};
}(typeof window !== 'undefined' ? window : globalThis));
