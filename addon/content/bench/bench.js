/**
 * The benchmark's harness: it drives the real graph page and times it.
 *
 * A separate file rather than an inline <script>, and that is not a style
 * choice: served over resource:// into a privileged window, the CSP such a
 * window carries refuses inline script outright while allowing resource:
 * sources. Inlined, none of this would run and the page would come up blank --
 * which is exactly what the first version did.
 *
 * ---------------------------------------------------------------------------
 * How it measures
 *
 * The page under test is ../graph.html in an iframe, loaded unmodified and fed
 * through window.zgSetData -- the same string-in, event-out bridge chrome uses.
 * Nothing here re-implements the renderer, so nothing here can drift away from
 * it, which is the failure mode the label benchmark this replaces was built to
 * avoid and only half managed.
 *
 * Frames are timed by wrapping the frame's requestAnimationFrame. force-graph
 * reschedules itself through the bare global every cycle, so a wrapper
 * installed after load still catches every subsequent frame. The clock stops
 * after a one-pixel read-back, because canvas drawing is pipelined: fillText
 * queues work and returns long before a glyph reaches a pixel, and timing the
 * calls alone measures command submission and reports a flattering fiction.
 *
 * Cost is attributed to subsystems by ABLATION rather than by instrumenting
 * graph.js: the canvas primitives each subsystem paints through are turned
 * into no-ops in the frame's own realm, and the drop in frame time is that
 * subsystem's share. Labels are fillText and strokeText, the circles are arc
 * and fill, the edges are stroke. This needs no hooks in production code, and
 * therefore cannot rot when production code moves.
 * ---------------------------------------------------------------------------
 */
'use strict';

var el = function (id) { return document.getElementById(id); };
var frame = el('frame');
var results = null;

/** Everything the run reports about where it ran. Two machines' numbers are
 *  not comparable, and this is what says so. */
function env() {
	return {
		agent: navigator.userAgent,
		gecko: navigator.userAgent.indexOf('Firefox') > -1,
		dpr: window.devicePixelRatio || 1,
		// Zotero serves this page over resource://; a headless run serves it
		// over http from tools/bench/serve.js. The renderer is the same either
		// way, but which one produced a number is worth keeping.
		host: location.protocol,
		when: new Date().toISOString(),
	};
}

function stats(xs) {
	if (!xs.length) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
	var s = xs.slice().sort(function (a, b) { return a - b; });
	var q = function (p) { return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
	var sum = 0;
	for (var i = 0; i < s.length; i++) sum += s[i];
	return { n: s.length, mean: sum / s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
}

function sleep(ms) {
	return new Promise(function (r) { setTimeout(r, ms); });
}

/* ------------------------------------------------------------------ *
 * The page under test
 * ------------------------------------------------------------------ */

var W = null;   // the frame's window
var D = null;   // its document

/** Wait for the graph page to have parsed far enough to accept a payload.
 *  Chrome does exactly this poll -- see graphTab.js. */
async function attach(vw, vh) {
	frame.style.width = vw + 'px';
	frame.style.height = vh + 'px';
	// Scaled to fit the panel without changing the size the page believes it
	// is: layout, culling and the label pass all read clientWidth, so shrinking
	// the element would quietly benchmark a smaller graph.
	var room = Math.max(320, el('stagewrap').clientWidth);
	var k = Math.min(1, room / vw);
	frame.style.transform = 'scale(' + k + ')';
	el('stage').style.height = Math.round(vh * k) + 'px';
	el('stage').style.width = Math.round(vw * k) + 'px';

	await new Promise(function (done) {
		if (frame.contentWindow && frame.contentWindow.zgSetData
			&& frame.contentDocument.readyState === 'complete') return done();
		frame.addEventListener('load', function () { done(); }, { once: true });
		frame.src = '../graph.html';
	});
	W = frame.contentWindow;
	D = frame.contentDocument;
	for (var i = 0; i < 500 && !W.zgSetData; i++) await sleep(10);
	if (!W.zgSetData) throw new Error('graph page never published zgSetData');
	return W;
}

function canvas() {
	return D.querySelector('#graph canvas');
}

/**
 * Force the drawing pipeline to drain.
 *
 * Without this every figure below is command-submission time, which on a
 * pipelined canvas is roughly the cost of not drawing. One pixel is enough:
 * the read cannot be answered until the queue in front of it has been.
 */
var _flushCtx = null;
function flush() {
	var c = canvas();
	if (!c) return;
	if (!_flushCtx || _flushCtx.canvas !== c) _flushCtx = c.getContext('2d');
	_flushCtx.getImageData(0, 0, 1, 1);
}

/**
 * What a flush costs when there is nothing queued behind it.
 *
 * The read-back has to happen inside the timed region -- that is the whole
 * point of it -- but it also carries a fixed synchronisation cost of its own,
 * and charging that to the renderer would put several milliseconds on every
 * frame in the table. Measured against an idle canvas, where the queue is
 * already empty, so what is left is the overhead and not the drawing.
 *
 * Re-measured per run rather than cached across runs: it moves with the
 * canvas size and with whatever else the machine is doing.
 */
var flushCost = 0;

function calibrateFlush() {
	var i;
	for (i = 0; i < 12; i++) flush();
	var t = W.performance.now();
	for (i = 0; i < 60; i++) flush();
	flushCost = (W.performance.now() - t) / 60;
	return flushCost;
}

/* ------------------------------------------------------------------ *
 * Frame timing
 * ------------------------------------------------------------------ */

var rafReal = null;
var frames = [];
var recording = false;

/**
 * How many frames force-graph has actually painted.
 *
 * Needed because its animation cycle reschedules itself every frame whether or
 * not it draws -- so counting rAF callbacks cannot tell a live layout from a
 * cooled one. It does clear the canvas on every frame it does draw, so
 * counting that is the signal. Patched in the frame's own realm, the same way
 * the ablation is, and for the same reason: no hook in graph.js to rot.
 */
var paintCount = 0;

/** When the renderer last drew anything. What makes "how long until the graph
 *  stopped moving" answerable to the frame rather than to the polling loop that
 *  noticed -- see timeToQuiet(). */
var paintAt = 0;

function hookPaint() {
	var p = proto();
	if (p.__zgClear) return;
	var real = p.clearRect;
	p.__zgClear = real;
	p.clearRect = function () {
		paintCount++;
		paintAt = W.performance.now();
		return real.apply(this, arguments);
	};
}

function hookFrames() {
	if (rafReal) return;
	rafReal = W.requestAnimationFrame;
	W.requestAnimationFrame = function (cb) {
		return rafReal.call(W, function (ts) {
			if (!recording) return cb(ts);
			var painted = paintCount;
			var t0 = W.performance.now();
			cb(ts);
			flush();
			// Only frames on which the renderer actually drew.
			//
			// force-graph reschedules its animation cycle every frame whether
			// or not there is anything to redraw, and an idle cycle costs about
			// 0.8ms. Counting those, a scenario whose gesture failed to land
			// reported 0.82ms and 1220fps -- a beautifully consistent
			// measurement of not drawing a graph -- and because the headline is
			// the fastest repeat, one such repeat captured the whole result.
			if (paintCount === painted) return;
			// Minus the read-back's own fixed cost -- see calibrateFlush().
			frames.push(Math.max(0, W.performance.now() - t0 - flushCost));
		});
	};
}

/**
 * force-graph stops rendering once the layout cools, so a scenario about a
 * settled graph has to ask for frames. zgSetChrome ends in repaint(), which is
 * the page's own "something visual changed" path -- the same one a theme
 * switch uses -- so this drives real repaints rather than a private test hook.
 */
function poke() {
	if (W.zgSetChrome) W.zgSetChrome('{}');
}

/** Record `count` frames, driving repaints if `drive` is given. */
async function record(count, drive) {
	frames = [];
	recording = true;
	var i = 0;
	// Capped in FRAMES OFFERED, not frames kept: now that idle frames are
	// discarded, a scenario that draws nothing would otherwise never finish.
	// It ends up with an empty sample, which the caller reports as a skip --
	// the honest outcome, and a much louder one than 1220fps.
	var offered = 0;
	var limit = count * 12 + 600;
	await new Promise(function (done) {
		function tick() {
			if (frames.length >= count || offered++ > limit) return done();
			if (drive) drive(i++);
			else poke();
			rafReal.call(W, tick);
		}
		tick();
	});
	recording = false;
	return frames.slice();
}

/* ------------------------------------------------------------------ *
 * Ablation
 *
 * Turning a canvas primitive into a no-op removes exactly the work the
 * subsystem that calls it was doing, and nothing else. The drop in frame
 * time is that subsystem's share. No hooks in graph.js, so nothing here
 * breaks when graph.js is rewritten.
 * ------------------------------------------------------------------ */

var PROTO = null;
var saved = {};

function proto() {
	if (!PROTO) PROTO = W.CanvasRenderingContext2D.prototype;
	return PROTO;
}

var ABLATE = {
	labels: ['fillText', 'strokeText'],
	halo: ['strokeText'],
	// arc alone: killing fill() would take the pin, the flags and the arrow
	// heads with it and attribute all of them to the circles.
	circles: ['arc'],
	edges: ['stroke'],
};

function ablate(which) {
	restore();
	var names = ABLATE[which] || [];
	var p = proto();
	for (var i = 0; i < names.length; i++) {
		saved[names[i]] = p[names[i]];
		p[names[i]] = function () {};
	}
}

function restore() {
	var p = proto();
	for (var k in saved) if (Object.prototype.hasOwnProperty.call(saved, k)) p[k] = saved[k];
	saved = {};
}

/* ------------------------------------------------------------------ *
 * Gestures
 *
 * Real events on the real canvas, so these travel the same path a user's
 * do -- d3-zoom's listeners, force-graph's hit test, the page's own
 * handlers. Synthesising a call into a private function instead would
 * measure a function nobody calls.
 * ------------------------------------------------------------------ */

/**
 * @param {string} type   the event to send
 * @param {object} [opts] extra event init
 * @param {boolean} [toWindow] send it to the window rather than the canvas
 *
 * Two event families, and they are not interchangeable. force-graph tracks
 * which node is under the cursor with POINTER events, so hover and the node
 * probe use those. d3-zoom and d3-drag -- which are what actually pan the
 * view and carry a node -- bind mousedown on the canvas and then move,
 * mousemove and mouseup onto the VIEW for the rest of the gesture. Sent as
 * pointer events, or sent to the canvas after the press, the drag simply never
 * happens: the scenario then measures force-graph's idle animation loop and
 * reports a beautifully consistent 1220fps for not drawing a graph.
 */
function at(x, y, type, opts, toWindow) {
	var c = canvas();
	if (!c) return;
	var r = c.getBoundingClientRect();
	var init = {
		bubbles: true, cancelable: true, composed: true,
		clientX: r.left + x, clientY: r.top + y,
		screenX: r.left + x, screenY: r.top + y,
		view: W, button: 0, buttons: type === 'pointermove' ? 0 : 1,
		pointerId: 1, pointerType: 'mouse', isPrimary: true,
	};
	if (opts) for (var k in opts) init[k] = opts[k];
	var Ctor = type.indexOf('pointer') === 0 ? W.PointerEvent
		: type === 'wheel' ? W.WheelEvent : W.MouseEvent;
	(toWindow ? W : c).dispatchEvent(new Ctor(type, init));
}

/**
 * A point on the canvas that is over a node.
 *
 * force-graph puts a `clickable` class on the canvas whenever its hit test is
 * over something, so this asks the real hit test rather than guessing at the
 * middle and hoping. A scenario that says "drag a node" and actually pans the
 * background would be worse than no scenario.
 */
async function findNode(vw, vh) {
	var best = null;
	var c = canvas();
	if (!c) return null;
	for (var ring = 0; ring < 6 && !best; ring++) {
		var step = 40 + ring * 25;
		for (var y = vh * 0.25; y < vh * 0.75 && !best; y += step) {
			for (var x = vw * 0.25; x < vw * 0.75 && !best; x += step) {
				at(x, y, 'pointermove');
				await new Promise(function (r) { rafReal.call(W, r); });
				if (c.classList.contains('clickable')) best = { x: x, y: y };
			}
		}
	}
	at(vw * 0.02, vh * 0.02, 'pointermove');
	return best;
}

/* ------------------------------------------------------------------ *
 * Scenarios
 *
 * Each returns the frames it produced. They are ordered so that the ones
 * that disturb the layout come after the ones that measure it at rest.
 * ------------------------------------------------------------------ */

var SCENARIOS = [
	{
		id: 'settle',
		what: 'cold layout: a fresh payload annealed until the engine cools',
		async run(cx) {
			// A DIFFERENT collection each repeat, not the same one again.
			//
			// updateGraph() compares a signature of the node ids and every drawn
			// edge property, and re-sending an identical payload takes its
			// cheapest tier: repaint in place, no re-anneal. Which is correct,
			// and is why recolouring the graph does not move it -- but it means
			// a settle scenario that re-sends its own data measures a repaint
			// and calls it a cold layout. On the run that caught this it painted
			// nothing at all and had to be thrown away.
			//
			// Same size, same shape, same generator: a different draw from the
			// same distribution, which is a fair thing to average over.
			// In a matrix run every variant gets the SAME fresh collection
			// within a repeat, so two variants' cold layouts are two
			// measurements of one graph rather than of two draws. Outside one
			// there is nothing to line up with, so it simply moves on.
			var fresh = ZGFixture.collection({
				n: cx.n, seed: cx.seed + 1000 + freshRound(cx), edgeRatio: cx.ratio,
			});
			W.zgSetData(JSON.stringify(fresh));
			return await record(cx.frames, function () {});
		},
	},
	{
		id: 'steady',
		what: 'settled graph repainting — the floor every other number sits on',
		async run(cx) {
			await settle(cx);
			return await record(cx.frames);
		},
	},
	{
		id: 'drag-node',
		what: 'dragging a node: hit test, reheat and re-layout every frame',
		async run(cx) {
			await settle(cx);
			// Probed after this scenario's own settle, not once at the start: a
			// reframe moves every node, so a point that was over one before is
			// not after -- and a drag that misses is a pan wearing its name.
			var p = await findNode(cx.vw, cx.vh) || cx.node;
			if (!p) return null;
			at(p.x, p.y, 'pointermove');
			at(p.x, p.y, 'mousedown');
			var f = await record(cx.frames, function (i) {
				var t = i / 30;
				var x = p.x + Math.cos(t) * 140, y = p.y + Math.sin(t) * 90;
				at(x, y, 'mousemove', { buttons: 1 }, true);
				at(x, y, 'pointermove', { buttons: 1 });
			});
			at(p.x, p.y, 'mouseup', null, true);
			return f;
		},
	},
	{
		id: 'pan',
		what: 'panning the background: no layout work, pure redraw at a new transform',
		async run(cx) {
			await settle(cx);
			// About the middle and back again, not away in one direction: a pan
			// that accumulates walks the graph off screen and then measures the
			// cost of drawing nothing.
			var cxp = cx.vw / 2, cyp = cx.vh / 2;
			at(cxp, cyp, 'mousedown');
			var f = await record(cx.frames, function (i) {
				var t = i / 12;
				at(cxp + Math.sin(t) * 160, cyp + Math.cos(t) * 110,
					'mousemove', { buttons: 1 }, true);
			});
			at(cxp, cyp, 'mouseup', null, true);
			return f;
		},
	},
	{
		id: 'zoom',
		what: 'wheel zoom: every screen-space size recomputed per frame',
		async run(cx) {
			await settle(cx);
			// In and back out in equal measure, so the scenario ends at the
			// scale it started at and leaves the next one a graph to draw.
			return await record(cx.frames, function (i) {
				at(cx.vw / 2, cx.vh / 2, 'wheel',
					{ deltaY: (i % 20) < 10 ? -110 : 110, deltaMode: 0 });
			});
		},
	},
	{
		id: 'isolate',
		what: 'isolating a neighbourhood: the whole graph repainted into a wash',
		async run(cx) {
			await settle(cx);
			// Probed after this scenario's own settle, not once at the start: a
			// reframe moves every node, so a point that was over one before is
			// not after -- and a drag that misses is a pan wearing its name.
			var p = await findNode(cx.vw, cx.vh) || cx.node;
			if (!p) return null;
			at(p.x, p.y, 'pointermove');
			var f = await record(cx.frames, function (i) {
				// On and off, so the measurement covers entering the wash and
				// leaving it -- the second is a full-strength repaint of
				// everything the first dimmed.
				if (i % 20 === 0) {
					at(p.x, p.y, 'pointermove');
					at(p.x, p.y, 'dblclick');
				}
				else poke();
			});
			at(p.x, p.y, 'dblclick');
			return f;
		},
	},
	{
		id: 'add-papers',
		what: 'a build phase landing: a bigger payload over a settled graph',
		async run(cx) {
			await settle(cx);
			var grown = ZGFixture.grow(cx.data, Math.max(10, Math.round(cx.n * 0.1)), 3);
			return await record(cx.frames, function (i) {
				if (i === 0) W.zgSetData(JSON.stringify(grown));
			});
		},
	},
	{
		id: 'filter',
		what: 'moving the confidence slider: an already-built graph re-filtered',
		async run(cx) {
			await settle(cx);
			var slider = D.getElementById('min-conf');
			if (!slider) return null;
			return await record(cx.frames, function (i) {
				slider.value = String(0.3 + (i % 12) * 0.05);
				slider.dispatchEvent(new W.Event('input', { bubbles: true }));
			});
		},
	},
];

/**
 * How long a fresh collection takes to stop moving, in wall-clock ms.
 *
 * The one thing about a layout that a table of frame times cannot say. Every
 * scenario here measures a frame, and a frame is the right unit for "does this
 * feel smooth" -- but it is the wrong unit entirely for "how long do I look at
 * a graph flying into place before I can read it", which is what the force
 * engine actually costs a user opening a collection. Switching the engine off
 * turns that from force-graph's fifteen-second cooldown into one blocking
 * anneal and a single paint, and a frame-time benchmark scores that as a
 * scenario that painted nothing.
 *
 * Timed to the last frame the RENDERER drew, not to the poll that noticed --
 * quiesce() deliberately waits out twenty quiet frames before it believes the
 * graph has stopped, and charging that patience to the layout would put a third
 * of a second on every measurement.
 *
 * A different collection each repeat, for the reason the settle scenario uses
 * one: re-sending an identical payload takes updateGraph's cheapest tier and
 * measures a repaint.
 */
async function timeToQuiet(cx) {
	var fresh = ZGFixture.collection({
		n: cx.n, seed: cx.seed + 2000 + freshRound(cx), edgeRatio: cx.ratio,
	});
	var t0 = W.performance.now();
	paintAt = 0;
	W.zgSetData(JSON.stringify(fresh));
	await quiesce();
	// Nothing was ever drawn: no answer, rather than a wrong one.
	return paintAt ? paintAt - t0 : null;
}

/**
 * Which draw from the fixture's distribution a cold layout should get.
 *
 * A settle has to be handed a collection the renderer has not already got, or
 * updateGraph takes its cheapest tier and the "cold layout" scenario measures a
 * repaint -- so it cannot simply re-send. In a matrix run the round number
 * answers it: every variant in one repeat anneals the same graph, so their cold
 * layouts differ by the switch and not by the dice. Otherwise a counter, which
 * is the same guarantee with nothing to line up against.
 */
function freshRound(cx) {
	if (cx.round != null) return cx.round;
	return (cx.settleSeed = (cx.settleSeed || 0) + 1);
}

/** Anneal, then wait for the engine to stop, so a scenario about a settled
 *  graph is not silently measuring the tail of the layout. */
async function settle(cx) {
	W.zgSetData(JSON.stringify(cx.data));
	await quiesce();
	await reframe();
}

/**
 * Put the whole graph back in view.
 *
 * zgSetData replaces the data; it does not touch the zoom transform, which is
 * view state and rightly survives a rebuild. So a scenario that moves the view
 * leaves it moved for everything that runs after it -- and `pan` used to drag
 * in one direction until the graph was off screen, after which every later
 * repeat measured an empty canvas at 1163 fps and best-of-repeats faithfully
 * reported the emptiest one. Any scenario that touches the view has to hand it
 * back.
 *
 * Through the page's own reframe button, so this is the same zoom-to-fit a
 * user gets rather than a second implementation of it.
 */
async function reframe() {
	var btn = D.getElementById('reframe');
	if (!btn) return;
	btn.click();
	// zoomToFit animates; waiting for the paint to stop waits for it to land.
	await quiesce(300);
}

/**
 * Wait until the graph stops painting, which is when the layout has cooled.
 *
 * The first version watched the recorded-frame array, which only grows while a
 * measurement is running -- so during a settle it never grew, the loop read
 * that as "already quiet" and returned after a dozen frames. Every number that
 * called itself a settled-graph measurement was taken off a graph still flying
 * into place, and the attribution table it fed printed a subsystem costing
 * more than the superset it belongs to. Watch what the renderer does, not what
 * the harness is doing.
 */
async function quiesce(maxFrames) {
	var quiet = 0;
	var cap = maxFrames || 1800;
	for (var i = 0; i < cap && quiet < 20; i++) {
		var before = paintCount;
		await new Promise(function (r) { rafReal.call(W, r); });
		quiet = (paintCount === before) ? quiet + 1 : 0;
	}
	await sleep(50);
	return quiet >= 20;
}

/* ------------------------------------------------------------------ *
 * The matrix
 *
 * Every performance switch measured against a baseline -- in ONE
 * browser session, with the variants interleaved.
 *
 * The first version ran each variant as its own browser: a baseline,
 * then eleven more, one after another. It reported the edge tint at
 * -32% and the label halo at +13%, and the halo is 0.46ms of an 18.4ms
 * frame by ablation -- so +13% is not a slow halo, it is a busy machine.
 * Every variant after the fourth was measured on a machine progressively
 * more loaded than the one the baseline got, and best-of-repeats cannot
 * rescue a comparison in which every repeat of the later side is
 * contaminated and none of the earlier side is.
 *
 * bench.js already had the answer one level down: repeats are
 * interleaved rather than nested, so a machine that slows down halfway
 * through taxes every scenario equally instead of loading the whole
 * penalty onto whichever ran last. The variants needed the same
 * treatment, and they can have it, because a switch is only a zgPerf
 * call -- nothing about a variant requires a browser of its own.
 * ------------------------------------------------------------------ */

/** Every switch there is, so that a variant states its whole configuration
 *  rather than inheriting whatever the one before it left behind. */
var SWITCHES = ['physics', 'collide', 'arrows', 'curves', 'tint', 'labels',
	'halo', 'fade', 'memo'];

/** Everything that costs the picture something to turn off -- which is every
 *  switch except the colour cache, whose whole point is that it costs nothing.
 *  Turning THAT off in a variant called "everything off" would make the fastest
 *  row slower than the ones above it. */
var PICTURE = SWITCHES.filter(function (k) { return k !== 'memo'; });

/** Scenarios that repaint a layout which is not moving -- all a drawing switch
 *  can touch. Naming them is a claim, not a saving: a switch that changes only
 *  what is painted cannot move what a layout costs, and running it against a
 *  layout scenario spends fifteen seconds a repeat to measure the noise floor. */
var MX_DRAW = ['steady', 'pan', 'zoom', 'isolate'];

/** Scenarios that disturb the layout, and so pay for the engine. */
var MX_LAYOUT = ['settle', 'drag-node', 'filter', 'add-papers'];

/** A full switch set with the named ones off. */
function offOnly() {
	var patch = {};
	for (var i = 0; i < SWITCHES.length; i++) patch[SWITCHES[i]] = true;
	for (var j = 0; j < arguments.length; j++) patch[arguments[j]] = false;
	return patch;
}

var MATRIX = [
	// The build every other row is a delta from.
	{ name: 'baseline', perf: offOnly(), only: null, wall: true },

	// One switch at a time. Switched together they cannot be told apart, and a
	// mode assembled out of switches nobody measured gives away parts of the
	// picture for nothing.
	{ name: 'no-arrows', perf: offOnly('arrows'), only: MX_DRAW },
	{ name: 'no-curves', perf: offOnly('curves'), only: MX_DRAW },
	{ name: 'no-tint', perf: offOnly('tint'), only: MX_DRAW },
	{ name: 'no-labels', perf: offOnly('labels'), only: MX_DRAW },
	{ name: 'no-halo', perf: offOnly('halo'), only: MX_DRAW },
	{ name: 'no-fade', perf: offOnly('fade'), only: MX_DRAW },
	// Not a feature: what the colours cost when they are worked out per node
	// and per link per frame instead of once per change. The only row here
	// whose switch nobody should ever turn off on purpose -- an optimisation
	// that cannot be turned off is one that cannot be measured, and this is
	// how it stays honest.
	{ name: 'no-memo', perf: offOnly('memo'), only: MX_DRAW },
	{ name: 'no-collide', perf: offOnly('collide'), only: MX_LAYOUT, wall: true },
	{ name: 'no-physics', perf: offOnly('physics'), only: MX_LAYOUT, wall: true },

	// Every drawing switch, engine untouched: what a big graph gains without
	// giving up the physics at all.
	{
		name: 'draw-only',
		perf: offOnly('arrows', 'curves', 'tint', 'labels', 'halo', 'fade'),
		only: MX_DRAW,
	},

	// The mode as the panel's checkbox sets it -- asked of the page rather than
	// restated here. The first version of this row named the switches itself
	// and drifted from PERF_MODE the moment either changed: it set four of the
	// six and published the answer as the mode's. A table about a mode has to
	// get the mode from whatever defines it.
	{ name: 'perf-mode', mode: true, only: null, wall: true },

	// And everything that costs the picture something, for the ceiling.
	{
		name: 'everything-off',
		perf: offOnly.apply(null, PICTURE),
		only: null, wall: true,
	},
];

/**
 * Run the whole matrix, variants interleaved inside each repeat.
 *
 * Every variant once, then every variant again -- never all the repeats of one
 * variant before starting the next, which is the nesting this exists to avoid.
 */
async function runMatrix(cx, p) {
	var out = { variants: {}, order: [], errors: [] };
	var list = MATRIX.filter(function (v) {
		return v.name === 'baseline' || !p.only
			|| p.only.split(',').indexOf(v.name) > -1;
	});
	for (var i = 0; i < list.length; i++) {
		out.order.push(list[i].name);
		out.variants[list[i].name] = {
			perf: list[i].perf || null, scenarios: {},
			_pooled: {}, _perRepeat: {}, _waits: [],
		};
	}

	var total = p.repeat * list.length;
	var step = 0;
	for (var rep = 0; rep < p.repeat; rep++) {
		cx.round = rep;
		for (var v = 0; v < list.length; v++) {
			var variant = list[v];
			var slot = out.variants[variant.name];
			step++;
			// Everything back on first, then this variant's switches. A variant
			// that named only what it turned off would inherit the switches of
			// the one before it, and the last row would be measuring all the
			// others.
			W.zgPerf(JSON.stringify(offOnly()));
			// zgPerf hands back what the switches ended up as, which is how the
			// perf-mode row learns what the mode is instead of asserting it.
			var applied = variant.mode
				? W.zgPerf('true')
				: W.zgPerf(JSON.stringify(variant.perf));
			try { slot.perf = JSON.parse(applied); }
			catch (e) { /* an older page: the declared patch is the best we have */ }

			var ids = SCENARIOS.filter(function (s) {
				return !variant.only || variant.only.indexOf(s.id) > -1;
			});
			for (var k = 0; k < ids.length; k++) {
				var s = ids[k];
				log('repeat ' + (rep + 1) + '/' + p.repeat + ' — ' + variant.name
					+ ' — ' + s.id + '  (' + step + '/' + total + ')');
				try {
					var f = await s.run(cx);
					var kept = f ? f.slice(p.warm) : [];
					if (!kept.length) {
						// A scenario that painted nothing is a fact about the
						// variant rather than a failure of the run: with the
						// engine off there is no cold layout to anneal, which is
						// the whole point of switching it off. Noted once, and
						// left as a gap in the table.
						if (rep === 0) {
							out.errors.push(variant.name + '/' + s.id
								+ ' painted nothing — nothing there to measure');
						}
						continue;
					}
					(slot._pooled[s.id] || (slot._pooled[s.id] = []))
						.push.apply(slot._pooled[s.id], kept);
					(slot._perRepeat[s.id] || (slot._perRepeat[s.id] = []))
						.push(stats(kept).p50);
				}
				catch (e) {
					out.errors.push(variant.name + '/' + s.id + ' (repeat '
						+ (rep + 1) + '): ' + (e && e.message ? e.message : String(e)));
				}
			}

			if (variant.wall) {
				log('repeat ' + (rep + 1) + '/' + p.repeat + ' — ' + variant.name
					+ ' — time to a settled graph');
				var w = await timeToQuiet(cx);
				if (w != null) slot._waits.push(w);
			}
		}
	}

	// Put every switch back the way the page ships, so that whatever runs after
	// this -- the attribution, or a person poking at the page by hand -- is
	// looking at the real renderer.
	W.zgPerf(JSON.stringify(offOnly()));

	for (var n = 0; n < list.length; n++) {
		var slotB = out.variants[list[n].name];
		for (var id in slotB._pooled) {
			var reps = slotB._perRepeat[id];
			var lo = Math.min.apply(null, reps);
			var hi = Math.max.apply(null, reps);
			slotB.scenarios[id] = Object.assign(stats(slotB._pooled[id]), {
				repeats: reps.length,
				repeatP50s: reps,
				best: lo,
				spread: hi - lo,
				spreadPct: lo > 0 ? (hi - lo) / lo : 0,
			});
		}
		if (slotB._waits.length) {
			slotB.settleWall = {
				best: Math.min.apply(null, slotB._waits),
				worst: Math.max.apply(null, slotB._waits),
				repeats: slotB._waits,
			};
		}
		delete slotB._pooled;
		delete slotB._perRepeat;
		delete slotB._waits;
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

function params() {
	var q = new URLSearchParams(location.search);
	var num = function (k, id, dflt) {
		var v = q.get(k);
		if (v != null && el(id)) el(id).value = v;
		return Number(v != null ? v : (el(id) ? el(id).value : dflt));
	};
	return {
		n: num('n', 'n', 1500),
		ratio: num('ratio', 'ratio', 1.4),
		seed: num('seed', 'seed', 7),
		vw: num('vw', 'vw', 1400),
		vh: num('vh', 'vh', 900),
		frames: num('frames', 'frames', 90),
		warm: num('warm', 'warm', 15),
		repeat: Number(q.get('repeat') || (el('repeat') ? el('repeat').value : 3)),
		ablate: q.get('ablate') != null ? q.get('ablate') !== '0' : el('ablate').checked,
		only: q.get('only'),
		// Every performance switch against a baseline, interleaved in one
		// session. Replaces the scenario table rather than adding to it: the
		// baseline variant IS that table, measured alongside its comparisons.
		matrix: q.get('matrix') != null,
		// The renderer's performance switches, as the JSON window.zgPerf takes.
		// A build variant rather than a scenario: the whole run is measured
		// with these on, so every scenario reports what they cost IT, and a
		// --baseline comparison against the default build reads them off
		// against each other. See PERF in graph.js.
		perf: q.get('perf'),
		// The settle timing replaces the graph and waits out a full anneal per
		// repeat, which is most of a minute -- worth it for a switch that touches
		// the layout, wasted for one that only changes what is painted.
		wall: q.get('wall') !== '0',
		auto: q.get('auto') != null,
	};
}

async function runAll(which) {
	var p = params();
	busy(true);
	var out = {
		env: env(),
		config: { n: p.n, ratio: p.ratio, seed: p.seed, vw: p.vw, vh: p.vh, frames: p.frames, repeat: p.repeat },
		scenarios: {},
		attribution: null,
		matrix: null,
		timings: null,
		errors: [],
	};

	await attach(p.vw, p.vh);
	// Before anything is measured and before the first payload, so no scenario
	// ever straddles the switch. A page too old to have zgPerf is a real answer
	// too -- it says the numbers describe the default build, and saying so in
	// the notes beats reporting them as if the switches had taken.
	if (p.perf) {
		out.config.perf = p.perf;
		if (W.zgPerf) W.zgPerf(p.perf);
		else out.errors.push('page has no zgPerf — --perf was ignored');
	}
	hookFrames();
	hookPaint();
	out.env.flushCost = calibrateFlush();

	var data = ZGFixture.collection({ n: p.n, seed: p.seed, edgeRatio: p.ratio });
	out.config.edges = data.edges.length;
	out.config.external = data.external.length;

	var cx = { data: data, n: p.n, seed: p.seed, ratio: p.ratio,
		vw: p.vw, vh: p.vh, frames: p.frames + p.warm, node: null };

	// One settle up front, so the node probe and every scenario after it start
	// from a graph that has finished moving.
	await settle(cx);
	cx.node = await findNode(p.vw, p.vh);
	if (!cx.node) out.errors.push('no node found under the probe — drag and isolate skipped');

	if (p.matrix) {
		out.matrix = await runMatrix(cx, p);
		out.errors = out.errors.concat(out.matrix.errors);
		// The baseline variant is the ordinary scenario table, measured
		// alongside everything it is a baseline FOR -- so it is published under
		// the name the rest of the tooling already reads.
		var b = out.matrix.variants.baseline;
		if (b) {
			out.scenarios = b.scenarios;
			for (var q3 = 0; q3 < SCENARIOS.length; q3++) {
				var sc = out.scenarios[SCENARIOS[q3].id];
				if (sc) sc.what = SCENARIOS[q3].what;
			}
			if (b.settleWall) out.timings = { settleWall: b.settleWall };
		}
		results = out;
		render(out);
		busy(false);
		if (p.auto) await report(out);
		return out;
	}

	var list = SCENARIOS.filter(function (s) {
		if (p.only) return p.only.split(',').indexOf(s.id) > -1;
		if (which === 'quick') return s.id === 'settle' || s.id === 'steady';
		return true;
	});

	// Repeats interleaved rather than nested: run every scenario once, then
	// every scenario again. A machine that slows down halfway through -- a
	// background job, a thermal cap -- then taxes all of them equally instead
	// of loading the whole penalty onto whichever ran last.
	var pooled = {};
	var perRepeat = {};
	for (var rep = 0; rep < p.repeat; rep++) {
		for (var i = 0; i < list.length; i++) {
			var s = list[i];
			log('repeat ' + (rep + 1) + '/' + p.repeat + ' — ' + s.id
				+ ' (' + (i + 1) + '/' + list.length + ')');
			try {
				var f = await s.run(cx);
				if (!f) {
					if (rep === 0) out.errors.push(s.id + ' skipped');
					continue;
				}
				var kept = f.slice(p.warm);
				if (!kept.length) {
					// No painted frames at all: the gesture never reached the
					// renderer. Silence beats a number that describes an idle loop.
					out.errors.push(s.id + ' painted nothing on repeat ' + (rep + 1)
						+ ' — nothing reached the renderer');
					continue;
				}
				(pooled[s.id] || (pooled[s.id] = [])).push.apply(pooled[s.id], kept);
				(perRepeat[s.id] || (perRepeat[s.id] = [])).push(stats(kept).p50);
			}
			catch (e) {
				out.errors.push(s.id + ' (repeat ' + (rep + 1) + '): '
					+ (e && e.message ? e.message : String(e)));
			}
			restore();
		}
	}
	for (var id in pooled) {
		var reps = perRepeat[id];
		var lo = Math.min.apply(null, reps);
		var hi = Math.max.apply(null, reps);
		var what = '';
		for (var q2 = 0; q2 < SCENARIOS.length; q2++) {
			if (SCENARIOS[q2].id === id) what = SCENARIOS[q2].what;
		}
		out.scenarios[id] = Object.assign(stats(pooled[id]), {
			what: what,
			repeats: reps.length,
			repeatP50s: reps,
			// The headline, and deliberately not the pooled median.
			//
			// Every source of noise on a desktop machine -- another process, a
			// GC, the compositor picking that moment to do something -- can
			// only ADD time to a frame. None of them can make the renderer
			// faster than it is. So the fastest repeat is the one least
			// contaminated, and the cleanest estimate of what the code costs;
			// a median over repeats averages the interference in instead.
			// Pooled p50 across all repeats moved by up to 63% run to run,
			// which made a real 10% win indistinguishable from a background
			// job. Best-of-repeats is the standard answer and it is why.
			best: lo,
			spread: hi - lo,
			spreadPct: lo > 0 ? (hi - lo) / lo : 0,
		});
	}

	// Last, because it replaces the graph every repeat and leaves a different
	// one behind. Best of the repeats for the reason every other headline here
	// is: interference can only add time.
	var waits = [];
	if (p.wall) log('timing how long a fresh collection takes to settle');
	for (var w = 0; p.wall && w < p.repeat; w++) {
		var el0 = await timeToQuiet(cx);
		if (el0 != null) waits.push(el0);
	}
	if (waits.length) {
		out.timings = {
			settleWall: {
				best: Math.min.apply(null, waits),
				worst: Math.max.apply(null, waits),
				repeats: waits,
			},
		};
	}
	else if (p.wall) out.errors.push('the graph never painted a fresh collection — no settle time');

	if (p.ablate && which !== 'quick') {
		log('attributing cost per subsystem');
		out.attribution = await attribute(cx, p);
	}

	results = out;
	render(out);
	busy(false);
	if (p.auto) await report(out);
	return out;
}

/**
 * What each subsystem costs, as the frame time that disappears when it stops
 * painting. Measured against the steady state rather than a moving layout, so
 * the difference is drawing and not the simulation.
 */
async function attribute(cx, p) {
	// Repeated and taken at its best, for the same reason the scenarios are.
	// Measured once each, this table printed the halo costing twice what
	// labels cost -- and the halo is a strict SUBSET of labels, so that is not
	// a surprising result, it is an arithmetically impossible one. A single
	// sample of a noisy quantity is how you print an impossible number with a
	// straight face.
	// Settled once, and left alone. Re-annealing between repeats lays the graph
	// out differently each time -- a different number of nodes on screen, a
	// different amount to draw -- and differences between subsystems measured
	// across different pictures are not differences between subsystems.
	await settle(cx);
	var best = async function (label) {
		var lo = Infinity, hi = 0;
		for (var r = 0; r < p.repeat; r++) {
			log('attributing ' + label + ' (' + (r + 1) + '/' + p.repeat + ')');
			var v = stats((await record(cx.frames)).slice(p.warm)).p50;
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		return { best: lo, spread: hi - lo };
	};

	var base = await best('everything');
	// The floor this table can resolve at all. A subsystem whose whole cost is
	// smaller than the spread between repeats of the SAME measurement has not
	// been measured as cheap -- it has not been measured. Reporting it as "0%"
	// would be a claim; reporting it as below the floor is the fact.
	var out = { baseline: { p50: base.best, spread: base.spread }, parts: {} };
	var keys = Object.keys(ABLATE);
	for (var i = 0; i < keys.length; i++) {
		ablate(keys[i]);
		var off = await best(keys[i]);
		restore();
		var cost = base.best - off.best;
		var floor = Math.max(base.spread, off.spread);
		out.parts[keys[i]] = {
			without: off.best,
			cost: cost,
			floor: floor,
			resolved: Math.abs(cost) > floor,
			share: base.best > 0 ? cost / base.best : 0,
		};
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

function ms(x) { return (Math.round(x * 1000) / 1000).toFixed(3); }
function cell(v, over) {
	return over && v > over ? '<td class="hi">' + ms(v) + '</td>' : '<td>' + ms(v) + '</td>';
}

function render(o) {
	var h = '<h2>Frame cost by scenario</h2>';
	h += '<table><tr><th>scenario</th><th>frames</th><th>p50</th><th>p95</th>'
		+ '<th>p99</th><th>noise</th><th>fps @ p95</th></tr>';
	for (var id in o.scenarios) {
		var s = o.scenarios[id];
		h += '<tr><td class="name" title="' + s.what + '">' + id + '</td>'
			+ '<td>' + s.n + '</td>'
			+ cell(s.p50, 16.7) + cell(s.p95, 16.7) + cell(s.p99, 16.7)
			+ '<td>±' + Math.round((s.spreadPct || 0) * 100) + '%</td>'
			+ '<td>' + (s.p95 > 0 ? Math.round(1000 / s.p95) : '—') + '</td></tr>';
	}
	h += '</table><p class="sub">Amber is past the 16.7 ms a 60 Hz frame allows. '
		+ 'Hover a scenario name for what it does. <strong>noise</strong> is the '
		+ 'spread between repeats of this same build — a difference smaller than '
		+ 'that between two builds has not been measured.</p>';

	if (o.attribution) {
		h += '<h2>What each subsystem costs</h2><table><tr><th>subsystem</th>'
			+ '<th>frame without it</th><th>its cost</th><th>share</th></tr>';
		h += '<tr><td class="name">everything</td><td>' + ms(o.attribution.baseline.p50)
			+ '</td><td>—</td><td>100%</td></tr>';
		for (var k in o.attribution.parts) {
			var a = o.attribution.parts[k];
			h += '<tr><td class="name">' + k + '</td><td>' + ms(a.without) + '</td><td>'
				+ ms(a.cost) + '</td><td>' + Math.round(a.share * 100) + '%</td></tr>';
		}
		h += '</table><p class="sub">Measured by ablation: the canvas calls that '
			+ 'subsystem paints through are made no-ops, and the frame time that '
			+ 'disappears is its share. Shares do not sum to 100% — some work is '
			+ 'shared, and some is neither drawing nor attributable.</p>';
	}

	if (o.errors.length) {
		h += '<p class="sub"><strong>Notes:</strong> ' + o.errors.join(' · ') + '</p>';
	}
	el('out').innerHTML = h;
}

function log(t) { el('log').textContent = t || ''; }

function busy(on) {
	el('run').disabled = on; el('quick').disabled = on;
	if (!on) log('');
}

/**
 * Hand the run back to whoever started it.
 *
 * Posted to the server that served this page when there is one -- that is how
 * a headless run gets its numbers out without a browser-driver dependency. In
 * Zotero there is no server, so the JSON goes to the clipboard and the title
 * says the run is done, which is what a person needs.
 */
async function report(o) {
	var body = JSON.stringify(o, null, '\t');
	if (location.protocol === 'http:' || location.protocol === 'https:') {
		try {
			await fetch('/results', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: body,
			});
			document.title = 'benchmark done';
			return;
		}
		catch (e) { /* fall through to the clipboard */ }
	}
	try { await navigator.clipboard.writeText(body); }
	catch (e) { /* a page without clipboard permission still rendered the table */ }
	document.title = 'benchmark done';
}

el('run').onclick = function () { runAll('all'); };
el('quick').onclick = function () { runAll('quick'); };
el('copy').onclick = function () {
	if (!results) return;
	navigator.clipboard.writeText(JSON.stringify(results, null, '\t'));
	log('copied');
};

el('env').textContent = 'devicePixelRatio ' + (window.devicePixelRatio || 1)
	+ ' · ' + (navigator.userAgent.indexOf('Firefox') > -1
		? 'Gecko' : 'non-Gecko engine — these numbers will not match Zotero')
	+ ' · ' + navigator.userAgent;

// Proof of life in the page rather than only in a console nobody has open
// here: a blank window is the failure this file's own header is about.
document.title = 'Graph rendering benchmark — ready';

if (params().auto) {
	window.addEventListener('load', function () {
		runAll(new URLSearchParams(location.search).get('quick') != null ? 'quick' : 'all')
			.catch(async function (e) {
				await report({ env: env(), scenarios: {}, attribution: null,
					errors: ['fatal: ' + (e && e.message ? e.message : String(e))] });
			});
	});
}
