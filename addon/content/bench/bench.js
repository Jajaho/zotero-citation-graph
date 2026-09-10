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

function hookFrames() {
	if (rafReal) return;
	rafReal = W.requestAnimationFrame;
	W.requestAnimationFrame = function (cb) {
		return rafReal.call(W, function (ts) {
			if (!recording) return cb(ts);
			var t0 = W.performance.now();
			cb(ts);
			flush();
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
	await new Promise(function (done) {
		function tick() {
			if (frames.length >= count) return done();
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

function at(x, y, type, opts) {
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
	c.dispatchEvent(new Ctor(type, init));
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
			W.zgSetData(JSON.stringify(cx.data));
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
			var p = cx.node;
			if (!p) return null;
			at(p.x, p.y, 'pointermove');
			at(p.x, p.y, 'pointerdown');
			var f = await record(cx.frames, function (i) {
				var t = i / 30;
				at(p.x + Math.cos(t) * 140, p.y + Math.sin(t) * 90, 'pointermove', { buttons: 1 });
			});
			at(p.x, p.y, 'pointerup');
			return f;
		},
	},
	{
		id: 'pan',
		what: 'panning the background: no layout work, pure redraw at a new transform',
		async run(cx) {
			await settle(cx);
			at(6, 6, 'pointerdown');
			var f = await record(cx.frames, function (i) {
				at(6 + (i % 40) * 6, 6 + (i % 25) * 5, 'pointermove', { buttons: 1 });
			});
			at(6, 6, 'pointerup');
			return f;
		},
	},
	{
		id: 'zoom',
		what: 'wheel zoom: every screen-space size recomputed per frame',
		async run(cx) {
			await settle(cx);
			return await record(cx.frames, function (i) {
				at(cx.vw / 2, cx.vh / 2, 'wheel',
					{ deltaY: (i % 40) < 20 ? -110 : 110, deltaMode: 0 });
			});
		},
	},
	{
		id: 'isolate',
		what: 'isolating a neighbourhood: the whole graph repainted into a wash',
		async run(cx) {
			await settle(cx);
			var p = cx.node;
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

/** Anneal, then wait for the engine to stop, so a scenario about a settled
 *  graph is not silently measuring the tail of the layout. */
async function settle(cx) {
	W.zgSetData(JSON.stringify(cx.data));
	var quiet = 0;
	for (var i = 0; i < 900 && quiet < 12; i++) {
		var before = frames.length;
		await new Promise(function (r) { rafReal.call(W, r); });
		quiet = (frames.length === before) ? quiet + 1 : 0;
		await sleep(0);
	}
	await sleep(60);
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
		errors: [],
	};

	await attach(p.vw, p.vh);
	hookFrames();
	out.env.flushCost = calibrateFlush();

	var data = ZGFixture.collection({ n: p.n, seed: p.seed, edgeRatio: p.ratio });
	out.config.edges = data.edges.length;
	out.config.external = data.external.length;

	var cx = { data: data, n: p.n, vw: p.vw, vh: p.vh, frames: p.frames + p.warm, node: null };

	// One settle up front, so the node probe and every scenario after it start
	// from a graph that has finished moving.
	await settle(cx);
	cx.node = await findNode(p.vw, p.vh);
	if (!cx.node) out.errors.push('no node found under the probe — drag and isolate skipped');

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
	await settle(cx);
	var base = stats((await record(cx.frames)).slice(p.warm));
	var out = { baseline: base, parts: {} };
	var keys = Object.keys(ABLATE);
	for (var i = 0; i < keys.length; i++) {
		ablate(keys[i]);
		var off = stats((await record(cx.frames)).slice(p.warm));
		restore();
		out.parts[keys[i]] = {
			without: off.p50,
			cost: Math.max(0, base.p50 - off.p50),
			share: base.p50 > 0 ? Math.max(0, 1 - off.p50 / base.p50) : 0,
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
