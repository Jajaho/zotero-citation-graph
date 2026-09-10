/**
 * Which names a crowded graph can actually show.
 *
 * Drawn naively, every node paints its own label and a collection of any size
 * becomes a field of overlapping text -- the names stop being readable exactly
 * at the zoom where you are trying to read them. The fix is to decide, once per
 * frame and for the whole picture at once, which labels get the room.
 *
 * The rule is greedy occlusion in a FIXED priority order: walk the nodes from
 * most important to least, and give each one its name only if the box that name
 * needs is still free. Two properties fall out of that, and both are the point:
 *
 *  - The most important name never loses. It is offered first, so it is placed
 *    into empty space every time.
 *  - Because the order does not depend on zoom or position, the set of visible
 *    names is roughly NESTED as you pull back: labels drop out from the bottom
 *    of the ranking upward, rather than churning. Rank by anything positional
 *    and that nesting is gone -- which is why the caller's ranking key must be
 *    a property of the node, never of where it happens to be sitting.
 *
 * A node alone in an empty region keeps its name even if it ranks low, since
 * nothing above it contests that space. That is local prominence, and it is
 * free -- there is no separate rule for it.
 *
 * Separate from graph.js for the same reason nodeScale.js is: it is pure, and
 * the first version of a placement rule is always subtly wrong in a way only a
 * test catches. Loaded as a plain <script> and published as a global; the
 * content page has no module loader.
 */
(function (global) {
	'use strict';

	/**
	 * Type size and width for one label, in screen pixels.
	 *
	 * The size follows the node's radius on screen, so a much-cited paper says
	 * its name loudly -- clamped at both ends, because below the floor a label
	 * is not worth drawing and above the ceiling one landmark shouts over the
	 * whole graph. A label wider than its own circle is then shrunk to fit, but
	 * never below the floor; past that it simply overhangs, which is what the
	 * halo is for.
	 *
	 * Width comes in as px-of-width-per-px-of-type rather than as a measured
	 * string, because measuring is the one expensive thing in the whole pass:
	 * canvas advance widths are linear in font size for a fixed family, so the
	 * caller measures each name once at a reference size and keeps the ratio.
	 * That turns a measureText per node per frame into a multiply.
	 *
	 * @param {number} radiusPx  the node's radius, on screen
	 * @param {number} widthPer  screen px of label width per px of type
	 * @param {{min:number,max:number,perRadius:number,fit:number}} o
	 * @param {object} [out]     written into rather than allocated, for the pass
	 */
	function size(radiusPx, widthPer, o, out) {
		out = out || {};
		var px = Math.max(o.min, Math.min(o.max, radiusPx * o.perRadius));
		var w = px * widthPer;
		var fit = 2 * radiusPx * o.fit;
		if (w > fit) {
			px = Math.max(o.min, px * (fit / w));
			w = px * widthPer;
		}
		out.px = px;
		out.w = w;
		return out;
	}

	/**
	 * Sort a node list into the order names are offered in, most important
	 * first.
	 *
	 * `keys` returns an array of numbers compared in turn, all descending -- so
	 * a caller can say "by radius, then by degree" without inventing a single
	 * number that mixes the two scales. Ties fall back to input order, which
	 * makes the result deterministic rather than merely stable: two renders of
	 * the same graph rank it identically, and that is what stops the visible
	 * names from shuffling between frames.
	 */
	function order(list, keys) {
		var n = list.length;
		var idx = new Array(n);
		var k = new Array(n);
		for (var i = 0; i < n; i++) {
			idx[i] = i;
			k[i] = keys(list[i]);
		}
		idx.sort(function (a, b) {
			var ka = k[a], kb = k[b];
			for (var j = 0; j < ka.length && j < kb.length; j++) {
				if (kb[j] !== ka[j]) return kb[j] - ka[j];
			}
			return a - b;
		});
		var out = new Array(n);
		for (var m = 0; m < n; m++) out[m] = list[idx[m]];
		return out;
	}

	/**
	 * The reservation itself: a uniform grid over the boxes already taken.
	 *
	 * A grid rather than a tree because the boxes are all roughly one size and
	 * arrive in a single batch that is thrown away at the end of the frame --
	 * the case a spatial hash is best at, and the case a balanced tree pays its
	 * rebuild cost for nothing.  A box touches a handful of cells and is tested
	 * only against what is already in them.
	 *
	 * Reused across frames rather than rebuilt: the box store is a growable
	 * Float64Array and the buckets carry a generation stamp, so a steady-state
	 * frame allocates nothing at all. Clearing a Map of arrays every frame
	 * would hand the collector one bucket per occupied cell, sixty times a
	 * second, forever.
	 */
	function Pass() {
		this.grid = new Map();
		this.boxes = new Float64Array(4 * 256);
		this.n = 0;           // boxes reserved this frame
		this.big = [];        // boxes too large to grid; see MAX_CELLS
		this.cell = 1;
		this.ox = 0;
		this.oy = 0;
		this.cap = 0;
		this.count = 0;
		this.tested = 0;
		this.gen = 0;
		// Scratch for span(), which is called too often to allocate. Declared
		// here rather than sprung on the object later, so the shape of a Pass
		// never changes and the engine keeps one hidden class for it.
		this.sx0 = this.sx1 = this.sy0 = this.sy1 = 0;
	}

	/** Past this a box goes on a linear list instead of into the buckets. */
	var MAX_CELLS = 64;

	/**
	 * Cells are indexed from an origin the caller supplies -- the top-left of
	 * the viewport -- rather than from the graph's own zero. At a deep zoom the
	 * cell is small and the coordinates are not, and an absolute index would
	 * run into the millions for a viewport a dozen cells wide.
	 *
	 * @param {number} cell  cell size, in the same units as the boxes
	 * @param {number} cap   stop accepting past this many names; see capacity()
	 */
	Pass.prototype.begin = function (cell, cap, ox, oy) {
		this.cell = cell > 0 ? cell : 1;
		this.ox = ox || 0;
		this.oy = oy || 0;
		this.cap = cap;
		this.count = 0;
		this.tested = 0;
		this.n = 0;
		this.big.length = 0;
		this.gen++;
	};

	/** Whether the frame already holds as many names as the viewport could. */
	Pass.prototype.full = function () {
		return this.count >= this.cap;
	};

	Pass.prototype.bucket = function (gx, gy) {
		var key = gx * 1048576 + gy;
		var b = this.grid.get(key);
		if (!b) {
			b = { gen: this.gen, items: [] };
			this.grid.set(key, b);
		} else if (b.gen !== this.gen) {
			// Left over from an earlier frame: stamp it and treat it as empty
			// rather than clearing every bucket up front. See Pass().
			b.gen = this.gen;
			b.items.length = 0;
		}
		return b.items;
	};

	/**
	 * The cells a box covers, left in fields rather than returned in an object.
	 *
	 * Called twice per candidate, and a candidate is every node on screen every
	 * frame -- an object literal here is tens of thousands of allocations a
	 * second handed to the collector for a result that dies four lines later.
	 * Returns the cell COUNT, which is the only thing both callers then ask of
	 * it. See Pass() for the same argument about the buckets.
	 */
	Pass.prototype.span = function (x0, y0, x1, y1) {
		var c = this.cell;
		this.sx0 = Math.floor((x0 - this.ox) / c);
		this.sx1 = Math.floor((x1 - this.ox) / c);
		this.sy0 = Math.floor((y0 - this.oy) / c);
		this.sy1 = Math.floor((y1 - this.oy) / c);
		return (this.sx1 - this.sx0 + 1) * (this.sy1 - this.sy0 + 1);
	};

	/** Take the space, no questions asked. What an always-drawn name uses. */
	Pass.prototype.claim = function (x0, y0, x1, y1) {
		var i = this.n * 4;
		if (i + 4 > this.boxes.length) {
			var bigger = new Float64Array(this.boxes.length * 2);
			bigger.set(this.boxes);
			this.boxes = bigger;
		}
		var b = this.boxes;
		b[i] = x0; b[i + 1] = y0; b[i + 2] = x1; b[i + 3] = y1;
		var at = this.n++;
		this.count++;
		// A box spanning half the grid would cost more to index than it saves.
		// That is a node circle at a deep zoom, and there are never many of
		// those on screen at once, so a linear list is the cheaper answer.
		if (this.span(x0, y0, x1, y1) > MAX_CELLS) {
			this.big.push(at);
			return;
		}
		for (var gx = this.sx0; gx <= this.sx1; gx++) {
			for (var gy = this.sy0; gy <= this.sy1; gy++) this.bucket(gx, gy).push(at);
		}
	};

	Pass.prototype.overlaps = function (at, x0, y0, x1, y1) {
		var b = this.boxes, i = at * 4;
		return x0 < b[i + 2] && x1 > b[i] && y0 < b[i + 3] && y1 > b[i + 1];
	};

	/** Whether anything already reserved would be written over. */
	Pass.prototype.hits = function (x0, y0, x1, y1) {
		this.tested++;
		var j;
		for (j = 0; j < this.big.length; j++) {
			if (this.overlaps(this.big[j], x0, y0, x1, y1)) return true;
		}
		if (this.span(x0, y0, x1, y1) > MAX_CELLS) {
			for (j = 0; j < this.n; j++) {
				if (this.overlaps(j, x0, y0, x1, y1)) return true;
			}
			return false;
		}
		for (var gx = this.sx0; gx <= this.sx1; gx++) {
			for (var gy = this.sy0; gy <= this.sy1; gy++) {
				var key = gx * 1048576 + gy;
				var b = this.grid.get(key);
				if (!b || b.gen !== this.gen) continue;
				for (j = 0; j < b.items.length; j++) {
					if (this.overlaps(b.items[j], x0, y0, x1, y1)) return true;
				}
			}
		}
		return false;
	};

	/** Test, and take the space if it is free. Returns whether it was. */
	Pass.prototype.offer = function (x0, y0, x1, y1) {
		if (this.full()) return false;
		if (this.hits(x0, y0, x1, y1)) return false;
		this.claim(x0, y0, x1, y1);
		return true;
	};

	/**
	 * How many names a viewport of this size could hold at all, given the
	 * smallest box one can occupy.
	 *
	 * A ceiling rather than a target: it exists so that a graph of fifty
	 * thousand nodes stops testing once no further answer can change, not to
	 * ration names on any graph a person is actually reading. On a graph small
	 * enough to read, the packing runs out of room long before this does.
	 */
	function capacity(w, h, minW, minH) {
		return Math.max(1, Math.ceil((w / minW) * (h / minH)));
	}

	global.ZGLabels = {
		size: size,
		order: order,
		capacity: capacity,
		pass: function () { return new Pass(); },
	};
}(typeof window !== 'undefined' ? window : globalThis));
