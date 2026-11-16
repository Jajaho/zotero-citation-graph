#!/usr/bin/env node
'use strict';

/**
 * Run the graph rendering benchmark and print the numbers: in headless Firefox
 * by default, in a real Firefox window with --gpu, or inside Zotero itself with
 * --app zotero.
 *
 * Firefox rather than a browser that is easier to automate: Zotero is built on
 * Gecko (Zotero 10 on Gecko 140 ESR), so this is the same rasteriser, the same
 * text shaping and the same compositor. Numbers from Chromium would be a real
 * measurement of the wrong renderer, which is worse than none because it looks
 * like an answer.
 *
 * Headless Firefox answers the question asked most often -- did that change make
 * it faster, and by how much -- because both runs are measured the same way on
 * the same machine minutes apart. It draws in software, though, so its absolute
 * figures are not a user's. --app zotero gives those: the same page in Zotero,
 * on the GPU. See the README beside this file.
 *
 * No browser-driver dependency. The page is served over http by serve.js and
 * posts its results back to it, which is all the channel a benchmark needs.
 * The one question a page cannot answer -- was the canvas on the GPU -- goes to
 * Firefox over marionette.js, sixty lines of our own, and to Zotero through
 * the runner add-on in zotero-runner/.
 *
 * Usage:
 *   node tools/bench/rendering/run.js [options]
 *     --n <count>          items in the synthetic collection (default 1500)
 *     --frames <count>     measured frames per scenario (default 90)
 *     --repeat <count>     interleaved repeats, for a noise floor (default 3)
 *     --only <a,b>         run only these scenarios
 *     --perf <json>        renderer performance switches, e.g. '{"physics":false}'
 *     --quick              settle and steady only
 *     --no-ablate          skip the per-subsystem attribution
 *     --no-wall            skip the time-to-a-settled-graph timing
 *     --matrix             every performance switch against a baseline, in one run
 *     --json <file>        write the full run to a file
 *     --md [file]          write a markdown report (default docs/performance.md)
 *     --baseline <file>    compare against an earlier --json and show deltas
 *     --firefox <path>     override the browser binary
 *     --headed             show the browser (for watching a scenario misbehave)
 *     --timeout <seconds>  give up after this long (default 240, 2400 in Zotero,
 *                          7200 with --matrix)
 *
 *   Where it runs, and on what:
 *     --gpu                draw on the GPU: a real window instead of headless,
 *                          and the run fails loudly if the canvas was not on
 *                          the GPU after all
 *     --app zotero         run inside Zotero instead of Firefox: a throwaway
 *                          profile and data directory, never your own. The
 *                          figures a user would see. Always a real window.
 *     --zotero <path>      override the Zotero binary
 *     --canvas software    turn Gecko's accelerated canvas off. Against a --gpu
 *                          run this is the check that the GPU did the drawing
 *     --ref <git-ref>      measure that version's graph page (e.g. v0.74.1) with
 *                          today's harness, so two versions run the same test
 *     --addon <dir>        measure the addon/ tree in <dir> instead
 *     --timing <how>       readback (default for headless) or interval (default
 *                          with --gpu and --app zotero). See TIMING in bench.js:
 *                          a read-back stalls a GPU canvas, so GPU runs time
 *                          the interval between frames, with vsync off
 *
 * Every run records which renderer drew it (zotero-runner/gfx-probe.js): the
 * report says GPU or CPU, compositor and adapter, so a fallback to software
 * cannot pass for a GPU number.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { serve } = require('./serve.js');
const { chromeEval } = require('./marionette.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt) => {
	const i = argv.indexOf('--' + name);
	return i === -1 || i === argv.length - 1 ? dflt : argv[i + 1];
};

/* ------------------------------------------------------------------ *
 * Finding Firefox
 * ------------------------------------------------------------------ */

const CANDIDATES = {
	win32: [
		'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
		'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
		path.join(os.homedir(), 'AppData\\Local\\Mozilla Firefox\\firefox.exe'),
	],
	darwin: [
		'/Applications/Firefox.app/Contents/MacOS/firefox',
		'/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
	],
	linux: ['/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox'],
};

function findFirefox() {
	const override = opt('firefox', process.env.FIREFOX_BIN);
	if (override) {
		if (!fs.existsSync(override)) throw new Error('no Firefox at ' + override);
		return override;
	}
	for (const p of CANDIDATES[process.platform] || []) {
		if (fs.existsSync(p)) return p;
	}
	// A PATH lookup last: on Windows this can find the Microsoft Store alias,
	// which is a launcher stub that does not take our arguments the way a real
	// binary does, so a genuine install is always preferred over it.
	try {
		const which = process.platform === 'win32' ? 'where' : 'which';
		const found = execFileSync(which, ['firefox'], { encoding: 'utf8' })
			.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
		for (const f of found) if (!/WindowsApps/i.test(f) && fs.existsSync(f)) return f;
		if (found.length) return found[0];
	}
	catch (e) { /* nothing on PATH */ }
	throw new Error(
		'could not find Firefox. Install it, or pass --firefox <path>, or set '
		+ 'FIREFOX_BIN. Zotero is built on Gecko, so Firefox is what makes '
		+ 'these numbers comparable to Zotero.');
}

/**
 * A throwaway profile.
 *
 * A fresh one per run so an extension, a stale cache or a leftover pref from
 * the user's own browsing cannot move a number -- and so that running this
 * never touches the profile they actually browse with.
 */
function makeProfile(extra = []) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-bench-'));
	fs.writeFileSync(path.join(dir, 'user.js'), [
		'user_pref("browser.shell.checkDefaultBrowser", false);',
		'user_pref("browser.startup.homepage_override.mstone", "ignore");',
		'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
		'user_pref("toolkit.telemetry.enabled", false);',
		'user_pref("app.update.enabled", false);',
		'user_pref("browser.sessionstore.resume_from_crash", false);',
		// The benchmark measures frames. A tab that is throttled because the
		// window is not focused would measure the throttling.
		'user_pref("dom.min_background_timeout_value", 4);',
		'user_pref("privacy.reduceTimerPrecision", false);',
		'user_pref("dom.animations.mainthread-synchronization-with-geometric-animations", true);',
		// A real window that something else covers is "occluded", and Gecko
		// stops painting it. A forty-minute sweep in a window you then work
		// over would measure the throttle. Off, it paints regardless.
		'user_pref("widget.windows.window_occlusion_tracking.enabled", false);',
		...gfxPrefs(),
		...extra,
	].join('\n') + '\n');
	return dir;
}

/** --canvas software: Gecko's accelerated canvas off, everything else as it
 *  ships. Compositing stays on the GPU, so what changes is only who rasterises
 *  the canvas -- which is the question a --gpu run has to be checked against. */
function gfxPrefs() {
	const out = [];
	const canvas = opt('canvas', null);
	if (canvas != null) {
		if (canvas !== 'software') throw new Error('--canvas takes "software", not ' + canvas);
		out.push('user_pref("gfx.canvas.accelerated", false);');
	}
	// Interval timing measures how fast frames come, so the display must not
	// set the pace: at 60 Hz anything under 16.7 ms reads as 16.7. Zero is
	// Gecko's "as fast as possible" refresh driver.
	if (timing() === 'interval') out.push('user_pref("layout.frame_rate", 0);');
	return out;
}

/** How bench.js times a frame. A GPU canvas is timed by interval, because a
 *  read-back stalls it; see TIMING in bench.js. */
function timing() {
	const t = opt('timing', null);
	if (t != null) {
		if (t !== 'readback' && t !== 'interval') throw new Error('--timing is readback or interval, not ' + t);
		return t;
	}
	return flag('gpu') || opt('app', 'firefox') === 'zotero' ? 'interval' : 'readback';
}

const pstr = (s) => JSON.stringify(String(s));

/** A free loopback port, for Marionette. */
function freePort() {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.unref();
		s.on('error', reject);
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

/**
 * End every process started with this profile, and only those.
 *
 * child.kill() is not enough. The Microsoft Store's firefox.exe is a launcher
 * that starts the real browser and exits, and Zotero on Windows runs a launcher
 * process above the browser process. Either way the PID we hold is not the
 * process holding the window. The profile path is unique to this run, so a
 * browser process that has it on its command line is ours.
 *
 * A browser process, by name, and never the PowerShell doing the stopping. Its
 * own command line carries the profile path too, being the filter, and the
 * first version matched itself: depending on process order it ended itself
 * before it reached the browser, and a Zotero from one run went on
 * benchmarking for half an hour under the next.
 *
 * Content processes do not carry the profile path; they exit with the parent.
 * Afterwards the browser is asked for again, and a survivor is reported.
 */
function stopByProfile(child, profile) {
	try { child.kill(); } catch (e) { /* already gone */ }
	if (process.platform !== 'win32') return;
	const marker = path.basename(profile).replace(/'/g, "''");
	const ours = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID"
		+ " -and $_.Name -match '^(firefox|zotero)\\.exe$' -and $_.CommandLine -like '*" + marker + "*' }";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const left = execFileSync('powershell', ['-NoProfile', '-Command',
				ours + " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };"
				+ ' Start-Sleep -Milliseconds 500; @(' + ours + ').Count'],
			{ encoding: 'utf8', timeout: 60000 }).trim();
			if (left === '0') return;
		}
		catch (e) { /* try again */ }
	}
	console.error('\n  could not stop the browser started with ' + profile
		+ ' -- end it by hand before the next run, or it will compete with it');
}

/** rmSync, a few times: Windows keeps a dead process's files locked a moment. */
async function removeDir(dir) {
	for (let i = 0; i < 10; i++) {
		try { fs.rmSync(dir, { recursive: true, force: true }); return; }
		catch (e) { await new Promise((r) => setTimeout(r, 500)); }
	}
}

/* ------------------------------------------------------------------ *
 * Which page: this checkout's, or an older version's
 * ------------------------------------------------------------------ */

/**
 * The addon/ tree to measure.
 *
 * --ref writes that version's addon/ to a temp directory and puts today's
 * harness (content/bench/) over it. Not the version's own harness: the
 * benchmark has changed under it. Until 0.75.1 the fixture's outside references
 * carried their key under the wrong name and the page drew none of them, so an
 * old harness measures a smaller graph than a new one, and the comparison would
 * be of two different tests.
 *
 * Written out file by file with git show, not git archive: extracting a tar
 * from node means either a dependency or whichever tar is on PATH, and on
 * Windows the Git-for-Windows one reads "C:\..." as a remote host.
 */
function prepareAddon() {
	const here = path.join(__dirname, '..', '..', '..');
	const dir = opt('addon', null);
	if (dir) {
		const root = path.resolve(dir);
		if (!fs.existsSync(path.join(root, 'manifest.json'))) throw new Error('no manifest.json in ' + root);
		return { root, label: root, cleanup: null };
	}
	const ref = opt('ref', null);
	if (!ref) return { root: path.join(here, 'addon'), label: 'working tree', cleanup: null };

	const git = (args, enc = 'utf8') => execFileSync('git', args,
		{ cwd: here, encoding: enc, maxBuffer: 256 * 1024 * 1024 });
	const sha = git(['rev-parse', '--short', ref + '^{commit}']).trim();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-bench-ref-'));
	const root = path.join(tmp, 'addon');
	const files = git(['ls-tree', '-r', '--name-only', ref, '--', 'addon/'])
		.split('\n').filter(Boolean);
	for (const f of files) {
		const out = path.join(tmp, f);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, git(['show', ref + ':' + f], 'buffer'));
	}
	const bench = path.join(here, 'addon', 'content', 'bench');
	fs.rmSync(path.join(root, 'content', 'bench'), { recursive: true, force: true });
	fs.cpSync(bench, path.join(root, 'content', 'bench'), { recursive: true });
	return { root, label: ref + ' (' + sha + ') with today\'s harness', cleanup: tmp };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/**
 * How far two runs of the SAME build drift, and therefore the bar a delta has
 * to clear before it means anything.
 *
 * Not a guess: two identical builds measured back to back with --repeat 3
 * agreed to within 0.0% on five scenarios and drifted 4.3% and 5.9% on two, so
 * a 5% bar reported that drift as a real regression. Eight clears it. Raise
 * --repeat to tighten the floor and lower this with it -- more repeats means a
 * better chance that one of them ran clean.
 */
const NOISE_PCT = Number(opt('noise-pct', 8));

const ms = (x) => (Math.round(x * 1000) / 1000).toFixed(3);

function pad(s, w, right) {
	s = String(s);
	return right ? s.padStart(w) : s.padEnd(w);
}

function table(head, rows) {
	const w = head.map((h, i) => Math.max(String(h).length,
		...rows.map((r) => String(r[i]).length)));
	const line = (cells) => '  ' + cells
		.map((c, i) => pad(c, w[i], i > 0)).join('  ');
	const out = [line(head), '  ' + w.map((n) => '-'.repeat(n)).join('  ')];
	for (const r of rows) out.push(line(r));
	return out.join('\n');
}

/** One line on what drew the run. A run from before the probe existed, or one
 *  whose probe failed, says so rather than letting a reader assume. */
function rendererLine(run) {
	const g = run.gfx;
	if (!g) return 'not recorded';
	if (g.error) return 'probe failed: ' + g.error;
	let s = g.summary || (g.canvas + ' canvas');
	if (g.prefs && g.prefs['gfx.canvas.accelerated'] === false) s += ' (accelerated canvas switched off)';
	return s;
}

function timingLine(run) {
	return run.env && run.env.timing === 'interval'
		? 'interval between painted frames, vsync off (no read-back)'
		: 'frame start to a one-pixel read-back';
}

function report(run, baseline) {
	const lines = [];
	const c = run.config || {};
	lines.push('');
	lines.push('  ' + (c.n || '?') + ' items, ' + (c.edges || '?') + ' edges, '
		+ (c.external || 0) + ' outside refs · viewport ' + c.vw + '×' + c.vh
		+ ' · dpr ' + (run.env && run.env.dpr));
	lines.push('  ' + ((run.env && run.env.agent) || '').replace(/^Mozilla\/5\.0 /, ''));
	if (run.page) lines.push('  page: ' + run.page);
	lines.push('  renderer: ' + rendererLine(run));
	lines.push('  timing: ' + timingLine(run));
	lines.push('');

	const ids = Object.keys(run.scenarios || {});
	if (ids.length) {
		const head = ['scenario', 'best', 'p50', 'p95', 'noise', 'fps@best'];
		if (baseline) head.push('was p50', 'delta', 'verdict');
		const rows = ids.map((id) => {
			const s = run.scenarios[id];
			const noise = (s.spreadPct || 0) * 100;
			const best = s.best != null ? s.best : s.p50;
			const row = [id, ms(best), ms(s.p50), ms(s.p95),
				'±' + noise.toFixed(0) + '%',
				best > 0 ? Math.round(1000 / best) : '-'];
			if (baseline) {
				const b = (baseline.scenarios || {})[id];
				if (!b) { row.push('-', '-', '-'); }
				else {
					const wasBest = b.best != null ? b.best : b.p50;
					const d = best - wasBest;
					const pct = wasBest > 0 ? (d / wasBest) * 100 : 0;
					// Best-of-repeats is stable to a few percent, so the bar for
					// "measured" is a few percent -- not the raw spread, which
					// describes the noisy statistic this replaced.
					const verdict = Math.abs(pct) <= NOISE_PCT ? 'noise'
						: (pct < 0 ? 'FASTER' : 'SLOWER');
					row.push(ms(wasBest),
						(d >= 0 ? '+' : '') + ms(d) + ' (' + (pct >= 0 ? '+' : '')
						+ pct.toFixed(1) + '%)', verdict);
				}
			}
			return row;
		});
		lines.push(table(head, rows));
		lines.push('');
		lines.push('  best = the fastest repeat, which is the least contaminated:');
		lines.push('  interference can only add time to a frame, never remove it.');
		lines.push('  Deltas compare best against best; inside ±' + NOISE_PCT
			+ '% is reported as noise.');
		lines.push('');
	}

	if (run.matrix) lines.push(matrixReport(run.matrix));

	const wall = run.timings && run.timings.settleWall;
	if (wall) {
		const bw = baseline && baseline.timings && baseline.timings.settleWall;
		let l = '  time to a settled graph: ' + ms(wall.best) + ' ms';
		if (bw) {
			const pct = bw.best > 0 ? ((wall.best - bw.best) / bw.best) * 100 : 0;
			l += '  (was ' + ms(bw.best) + ' ms, '
				+ (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%)';
		}
		lines.push(l);
		lines.push('  wall clock from the payload to the last frame drawn — the one thing');
		lines.push('  a table of frame times cannot say.');
		lines.push('');
	}

	if (run.attribution) {
		lines.push('  where the time goes (steady state, by ablation)');
		lines.push('');
		const rows = [['everything', ms(run.attribution.baseline.p50), '-', '100%']];
		for (const k of Object.keys(run.attribution.parts)) {
			const a = run.attribution.parts[k];
			rows.push([k, ms(a.without),
				a.resolved === false ? '< ' + ms(a.floor) : ms(a.cost),
				a.resolved === false ? 'under noise' : Math.round(a.share * 100) + '%']);
		}
		lines.push(table(['subsystem', 'frame without', 'its cost', 'share'], rows));
		lines.push('');
	}

	if (run.errors && run.errors.length) {
		lines.push('  notes: ' + run.errors.join('; '));
		lines.push('');
	}
	return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * The markdown report
 *
 * A committed file rather than only a console table, so that a number
 * can be pointed at in a review and so a regression has something to be
 * a regression FROM. Regenerated wholesale by --md; nothing in it is
 * meant to be edited by hand, which is what the header says.
 * ------------------------------------------------------------------ */

/** The build these numbers describe. A performance report that cannot say
 *  which commit it measured is a report about nothing in particular. */
function commit() {
	try {
		const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'],
			{ encoding: 'utf8' }).trim();
		const dirty = execFileSync('git', ['status', '--porcelain'],
			{ encoding: 'utf8' }).trim().length > 0;
		return sha + (dirty ? ' (working tree dirty)' : '');
	}
	catch (e) { return 'unknown'; }
}

function mdTable(head, rows) {
	const out = ['| ' + head.join(' | ') + ' |'];
	out.push('|' + head.map((h, i) => (i ? '---:' : '---')).join('|') + '|');
	for (const r of rows) out.push('| ' + r.join(' | ') + ' |');
	return out.join('\n');
}

function markdown(run, baseline, basePath) {
	const c = run.config || {};
	const e = run.env || {};
	const L = [];

	L.push('# Rendering performance');
	L.push('');
	L.push('Generated by `npm run bench:report`. Do not edit by hand — the next');
	L.push('run overwrites it. What the numbers mean and how they are taken:');
	L.push('[tools/bench/rendering/README.md](../tools/bench/rendering/README.md).');
	L.push('');
	L.push('| | |');
	L.push('|---|---|');
	L.push('| measured | ' + (e.when || 'unknown') + ' |');
	L.push('| commit | `' + commit() + '` |');
	L.push('| collection | ' + (c.n || '?') + ' items, ' + (c.edges || '?')
		+ ' edges, ' + (c.external || 0) + ' outside refs (seed ' + c.seed + ') |');
	L.push('| viewport | ' + c.vw + ' x ' + c.vh + ' at dpr ' + e.dpr + ' |');
	L.push('| sampling | ' + c.frames + ' frames x ' + (c.repeat || 1) + ' repeats per scenario |');
	L.push('| engine | ' + String(e.agent || '').replace(/^Mozilla\/5\.0 /, '') + ' |');
	if (run.page) L.push('| page | ' + run.page + ' |');
	L.push('| renderer | ' + rendererLine(run) + ' |');
	L.push('| timing | ' + timingLine(run) + ' |');
	L.push('');
	if (!run.gfx || run.gfx.canvas !== 'gpu') {
		L.push('> This run drew the canvas in **software**, so these absolute times are');
		L.push('> slower than a GPU-composited Zotero. They are here to be compared with');
		L.push('> each other, not quoted as what a user sees. `--gpu` measures on the');
		L.push('> GPU, and `--app zotero` inside Zotero itself.');
		L.push('');
	}

	const ids = Object.keys(run.scenarios || {});
	if (ids.length) {
		L.push('## Frame cost by scenario');
		L.push('');
		const head = ['scenario', 'best ms', 'p50 ms', 'p95 ms', 'noise', 'fps'];
		if (baseline) head.push('was', 'delta');
		const rows = ids.map((id) => {
			const s = run.scenarios[id];
			const best = s.best != null ? s.best : s.p50;
			const row = [id, ms(best), ms(s.p50), ms(s.p95),
				'±' + ((s.spreadPct || 0) * 100).toFixed(0) + '%',
				best > 0 ? Math.round(1000 / best) : '-'];
			if (baseline) {
				const b = (baseline.scenarios || {})[id];
				if (!b) row.push('-', 'new');
				else {
					const was = b.best != null ? b.best : b.p50;
					const pct = was > 0 ? ((best - was) / was) * 100 : 0;
					row.push(ms(was), (Math.abs(pct) <= NOISE_PCT ? 'noise'
						: (pct < 0 ? '**' : '') + (pct >= 0 ? '+' : '')
						+ pct.toFixed(1) + '%' + (pct < 0 ? '**' : '')));
				}
			}
			return row;
		});
		L.push(mdTable(head, rows));
		L.push('');
		for (const id of ids) {
			const s = run.scenarios[id];
			if (s.what) L.push('- **' + id + '** — ' + s.what);
		}
		L.push('');
		L.push('**best** is the fastest repeat, not the median: interference can only');
		L.push('add time to a frame, never remove it, so the fastest run is the least');
		L.push('contaminated. **noise** is the spread across repeats of this same');
		L.push('build — a delta smaller than ±' + NOISE_PCT + '% has not been measured.');
		L.push('');
		L.push('A scenario whose own behaviour varies frame to frame carries high');
		L.push('noise honestly: `isolate` toggles the wash on and off, and a dimmed');
		L.push('graph draws no labels at all, so how many frames of a repeat');
		L.push('were dimmed moves its median. Compare it only against itself.');
		L.push('');
	}

	if (run.matrix) L.push.apply(L, matrixMarkdown(run.matrix));

	const wall = run.timings && run.timings.settleWall;
	if (wall) {
		L.push('## Time to a settled graph');
		L.push('');
		L.push('Wall clock from handing the page a fresh collection to the last frame');
		L.push('the renderer drew. Frame times say whether the picture is smooth; this');
		L.push('says how long it moves before it can be read, which is the other half');
		L.push('of what the layout costs and the half a frame cannot express.');
		L.push('');
		const bw = baseline && baseline.timings && baseline.timings.settleWall;
		const row = [ms(wall.best) + ' ms', ms(wall.worst) + ' ms'];
		const head = ['best', 'worst'];
		if (bw) {
			head.push('was', 'delta');
			const pct = bw.best > 0 ? ((wall.best - bw.best) / bw.best) * 100 : 0;
			row.push(ms(bw.best) + ' ms',
				(pct >= 0 ? '+' : '') + pct.toFixed(1) + '%');
		}
		L.push(mdTable(head, [row]));
		L.push('');
	}

	if (run.attribution) {
		L.push('## Where the time goes');
		L.push('');
		L.push('Steady state, measured by ablation: the canvas primitives a subsystem');
		L.push('paints through are made no-ops, and the frame time that disappears is');
		L.push('its share. Shares do not sum to 100% — some work is shared, and some is');
		L.push('neither drawing nor attributable to one subsystem.');
		L.push('');
		const rows = [['everything', ms(run.attribution.baseline.p50), '—', '100%']];
		for (const k of Object.keys(run.attribution.parts)) {
			const a = run.attribution.parts[k];
			rows.push([k, ms(a.without),
				a.resolved === false ? '< ' + ms(a.floor) : ms(a.cost),
				a.resolved === false ? '_under noise_' : Math.round(a.share * 100) + '%']);
		}
		L.push(mdTable(['subsystem', 'frame without it', 'its cost', 'share'], rows));
		L.push('');
	}

	if (baseline && basePath) {
		L.push('Compared against `' + basePath + '`'
			+ (baseline.env && baseline.env.when ? ', measured ' + baseline.env.when : '') + '.');
		L.push('');
	}

	if (run.errors && run.errors.length) {
		L.push('## Notes from the run');
		L.push('');
		for (const n of run.errors) L.push('- ' + n);
		L.push('');
	}
	return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * The matrix table
 *
 * What each performance switch bought, against a baseline measured in
 * the same session and interleaved with it. Percentages rather than
 * milliseconds: the absolute figures are already in the scenario table
 * above, and what this table is for is the comparison.
 * ------------------------------------------------------------------ */

const SCEN_ORDER = ['settle', 'steady', 'drag-node', 'pan', 'zoom', 'isolate',
	'add-papers', 'filter'];

/** Shorter than the ids, because twelve rows of eight columns has to fit on a
 *  terminal. The scenario table above says what each one means in full. */
const SCEN_SHORT = {
	settle: 'settl', steady: 'stead', 'drag-node': 'drag', pan: 'pan',
	zoom: 'zoom', isolate: 'isol', 'add-papers': 'add', filter: 'filt',
};

const vBest = (s) => (s && (s.best != null ? s.best : s.p50)) || null;

/** A variant's frame time against the baseline's. Negative is faster, which is
 *  the direction a switch is for. */
function vDelta(variant, base, id) {
	const a = vBest((variant.scenarios || {})[id]);
	const b = vBest((base.scenarios || {})[id]);
	if (a == null || b == null || !b) return null;
	return ((a - b) / b) * 100;
}

/**
 * How a percentage reads.
 *
 * Inside the noise floor it reads as noise rather than as a small number,
 * because a small number there is a claim the measurement cannot support --
 * the same rule the verdict column uses. A gap is a scenario the variant never
 * ran, which is a claim of its own: a switch that only changes what is painted
 * cannot move what a layout costs.
 */
function vPct(v) {
	if (v == null) return '·';
	if (Math.abs(v) <= NOISE_PCT) return '~';
	return (v > 0 ? '+' : '') + v.toFixed(0) + '%';
}

function vWall(variant) {
	const w = variant.settleWall;
	if (!w) return '·';
	return w.best < 1000 ? Math.round(w.best) + ' ms' : (w.best / 1000).toFixed(1) + ' s';
}

/** Which switches a variant turned off, for the row that says what it was. */
function vOff(variant) {
	const p = variant.perf || {};
	const out = Object.keys(p).filter((k) => !p[k]);
	return out.length ? out.join(' ') : '—';
}

function matrixRows(m) {
	const base = m.variants.baseline;
	const rows = [];
	for (const name of m.order) {
		if (name === 'baseline') continue;
		const v = m.variants[name];
		if (!v) continue;
		const row = [name];
		for (const id of SCEN_ORDER) row.push(vPct(vDelta(v, base, id)));
		row.push(vWall(v));
		rows.push(row);
	}
	return rows;
}

function matrixReport(m) {
	const base = m.variants.baseline;
	if (!base) return '';
	const lines = [];
	lines.push('  what each performance switch bought');
	lines.push('');
	const head = ['variant'].concat(SCEN_ORDER.map((id) => SCEN_SHORT[id]),
		['settled']);
	lines.push(table(head, matrixRows(m)));
	lines.push('');
	lines.push('  Change in frame time against the baseline row, which is the scenario');
	lines.push('  table above. Negative is faster. `~` is inside the ±' + NOISE_PCT
		+ '% two runs of');
	lines.push('  the same build drift by, so it means the switch was not measured to do');
	lines.push('  anything; `·` is a scenario the switch cannot touch and did not run.');
	lines.push('  Variants are interleaved with the baseline inside each repeat, so a');
	lines.push('  machine that gets busier taxes all of them rather than the later ones.');
	lines.push('');
	lines.push('  "settled" is wall clock from a fresh collection to the last frame drawn.');
	lines.push('');
	return lines.join('\n');
}

function matrixMarkdown(m) {
	const base = m.variants.baseline;
	if (!base) return [];
	const L = [];
	L.push('## What each performance switch bought');
	L.push('');
	L.push('Change in frame time against the baseline — which is the scenario table');
	L.push('above, measured in the same session and **interleaved** with every variant');
	L.push('below it, so a machine that gets busier partway through taxes all of them');
	L.push('equally instead of only the ones that ran late.');
	L.push('');
	L.push('`~` is inside the ±' + NOISE_PCT + '% two runs of the same build drift by: the switch');
	L.push('was not measured to do anything. `·` is a scenario the switch cannot touch');
	L.push('and did not run — a switch that changes only what is *painted* cannot move');
	L.push('what a layout costs, and running it there would spend fifteen seconds a');
	L.push('repeat to measure the noise floor.');
	L.push('');
	const head = ['variant'].concat(SCEN_ORDER, ['to settled']);
	L.push(mdTable(head, matrixRows(m)));
	L.push('');
	L.push('**to settled** is wall clock from handing the page a fresh collection to the');
	L.push('last frame the renderer drew: how long the graph moves before it can be');
	L.push('read. The baseline is ' + vWall(base) + ', which is force-graph\'s `cooldownTime`');
	L.push('rather than the time the layout needs — it runs the clock out whether or not');
	L.push('it has converged.');
	L.push('');
	L.push('What each variant turned off:');
	L.push('');
	const offRows = m.order.map((n) => [n, '`' + vOff(m.variants[n]) + '`']);
	L.push(mdTable(['variant', 'switches off'], offRows));
	L.push('');
	return L;
}

/* ------------------------------------------------------------------ *
 * Launching: Firefox, or Zotero
 * ------------------------------------------------------------------ */

/** The page's query string, shared by both apps. */
function benchQuery() {
	const q = new URLSearchParams({ auto: '1' });
	q.set('n', opt('n', '1500'));
	q.set('frames', opt('frames', '90'));
	q.set('repeat', opt('repeat', '3'));
	if (opt('seed', null)) q.set('seed', opt('seed'));
	if (opt('ratio', null)) q.set('ratio', opt('ratio'));
	if (opt('only', null)) q.set('only', opt('only'));
	// A build variant for the whole run: every scenario is measured with these
	// renderer switches applied. Compare one against a --baseline taken without
	// it and the delta column is what that switch is worth. See PERF in graph.js.
	if (opt('perf', null)) q.set('perf', opt('perf'));
	if (flag('quick')) q.set('quick', '1');
	if (flag('no-ablate')) q.set('ablate', '0');
	if (flag('no-wall')) q.set('wall', '0');
	// Every performance switch against a baseline, interleaved inside one
	// browser session. Not one run per variant: see the header of the matrix
	// section in bench.js for what that measured instead.
	if (flag('matrix')) q.set('matrix', '1');
	q.set('timing', timing());
	return q;
}

const PROBE = fs.readFileSync(path.join(__dirname, 'zotero-runner', 'gfx-probe.js'), 'utf8');

/**
 * Firefox: the page over http from serve.js, results posted back to it, and
 * the renderer asked over Marionette once the run is over -- after, so that a
 * GPU that gave up halfway through is reported as having given up.
 */
async function launchFirefox(server, q) {
	const binary = findFirefox();
	const mport = await freePort();
	const profile = makeProfile(['user_pref("marionette.port", ' + mport + ');']);
	const url = 'http://127.0.0.1:' + server.port + '/content/bench/bench.html?' + q;
	const args = ['--profile', profile, '--no-remote', '--new-instance', '--marionette'];
	if (!flag('headed') && !flag('gpu')) args.push('--headless');
	args.push(url);

	console.log('\n  ' + binary);
	console.log('  ' + url);

	const child = spawn(binary, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: Object.assign({}, process.env, { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }),
	});
	let stderr = '';
	child.stderr.on('data', (d) => { stderr += d; });
	return {
		stderr: () => stderr,
		async gfx() {
			try {
				return await chromeEval(mport, PROBE + '\nreturn zgGfxProbe();', 15000);
			}
			catch (e) { return { error: 'Marionette: ' + e.message }; }
		},
		async stop() {
			stopByProfile(child, profile);
			await removeDir(profile);
		},
	};
}

function findZotero() {
	const override = opt('zotero', process.env.ZOTERO_BIN);
	if (override) {
		if (!fs.existsSync(override)) throw new Error('no Zotero at ' + override);
		return override;
	}
	const candidates = {
		win32: ['C:\\Program Files\\Zotero\\zotero.exe', 'C:\\Program Files (x86)\\Zotero\\zotero.exe',
			path.join(os.homedir(), 'AppData\\Local\\Zotero\\zotero.exe')],
		darwin: ['/Applications/Zotero.app/Contents/MacOS/zotero'],
		linux: ['/usr/lib/zotero/zotero', '/opt/zotero/zotero', path.join(os.homedir(), 'Zotero_linux-x86_64/zotero')],
	}[process.platform] || [];
	for (const p of candidates) if (fs.existsSync(p)) return p;
	throw new Error('could not find Zotero. Pass --zotero <path> or set ZOTERO_BIN.');
}

/**
 * Zotero: a second, separate Zotero with a throwaway profile AND a throwaway
 * data directory. Your own Zotero can stay open; it is never touched. Zotero
 * locks its database, so a second copy pointed at the same data directory
 * would refuse to start -- or worse -- and the data directory is the thing
 * the profile would otherwise default to.
 *
 * The plugin under test and the runner add-on are installed as proxy files
 * (see tools/install-dev.ps1 for why each detail is the way it is): a file
 * named for the add-on id whose first line is the directory, UTF-8, no BOM.
 * A fresh profile has no extensions.lastAppBuildId, so Zotero scans them.
 */
async function launchZotero(server, q, addonRoot) {
	const binary = findZotero();
	const pluginId = JSON.parse(fs.readFileSync(path.join(addonRoot, 'manifest.json'), 'utf8'))
		.applications.zotero.id;
	const runnerDir = path.join(__dirname, 'zotero-runner');
	const runnerId = JSON.parse(fs.readFileSync(path.join(runnerDir, 'manifest.json'), 'utf8'))
		.applications.zotero.id;

	q.set('report', 'window');
	const page = 'resource://zotero-citation-graph/content/bench/bench.html?' + q;
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-bench-data-'));
	const profile = makeProfile([
		'user_pref("extensions.zotero.useDataDir", true);',
		'user_pref("extensions.zotero.dataDir", ' + pstr(dataDir) + ');',
		'user_pref("extensions.zotero.firstRun2", false);',
		'user_pref("extensions.zotero.firstRunGuidance", false);',
		'user_pref("extensions.zotero.sync.autoSync", false);',
		'user_pref("extensions.zotero.automaticScraperUpdates", false);',
		'user_pref("extensions.autoDisableScopes", 0);',
		'user_pref("extensions.zgbench.page", ' + pstr(page) + ');',
		'user_pref("extensions.zgbench.sink", ' + pstr('http://127.0.0.1:' + server.port) + ');',
	]);
	const ext = path.join(profile, 'extensions');
	fs.mkdirSync(ext);
	fs.writeFileSync(path.join(ext, pluginId), addonRoot, { encoding: 'utf8' });
	fs.writeFileSync(path.join(ext, runnerId), runnerDir, { encoding: 'utf8' });

	console.log('\n  ' + binary);
	console.log('  ' + page);

	const child = spawn(binary, ['-no-remote', '-profile', profile], { stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	child.stderr.on('data', (d) => { stderr += d; });
	return {
		stderr: () => stderr,
		// Posted by the runner before it opens the page; see zotero-runner/.
		async gfx() { return null; },
		async stop() {
			stopByProfile(child, profile);
			await removeDir(profile);
			await removeDir(dataDir);
		},
	};
}

/* ------------------------------------------------------------------ *
 * Driving it
 * ------------------------------------------------------------------ */

async function main() {
	const app = opt('app', 'firefox');
	if (app !== 'firefox' && app !== 'zotero') throw new Error('--app is firefox or zotero, not ' + app);
	// The matrix is fourteen variants three times over, about fifty minutes at
	// 1,500 items on a software rasteriser -- a limit sized for the single run
	// throws all of it away at the end. In Zotero one repeat of every scenario
	// takes about four minutes, and Zotero takes a while to start.
	const timeout = Number(opt('timeout', flag('matrix') ? 7200 : (app === 'zotero' ? 2400 : 240))) * 1000;

	const addon = prepareAddon();
	let resolveResults;
	const got = new Promise((r) => { resolveResults = r; });
	let posted = null;
	const server = await serve({
		root: addon.root,
		onResults: resolveResults,
		onGfx: (g) => { posted = g; },
	});

	const q = benchQuery();
	const runner = app === 'zotero'
		? await launchZotero(server, q, addon.root)
		: await launchFirefox(server, q);

	const timer = setTimeout(() => {
		const err = runner.stderr();
		resolveResults({ errors: ['timed out after ' + (timeout / 1000) + 's'
			+ (err ? ' — browser said: ' + err.trim().split('\n').slice(-3).join(' / ') : '')] });
	}, timeout);

	const run = await got;
	clearTimeout(timer);

	run.gfx = (await runner.gfx()) || posted || null;
	run.page = addon.label;
	run.app = app;
	await runner.stop();
	await server.close();
	if (addon.cleanup) await removeDir(addon.cleanup);

	// A --gpu run that was not on the GPU is not a slower GPU run, it is a
	// software run with the wrong name on it. Say so where it cannot be missed.
	run.errors = run.errors || [];
	if ((flag('gpu') || app === 'zotero') && opt('canvas', null) == null
		&& (!run.gfx || run.gfx.canvas !== 'gpu')) {
		const msg = 'NOT ON THE GPU: the canvas was drawn in software (' + rendererLine(run)
			+ '). These are not GPU numbers.';
		run.errors.unshift(msg);
		if (flag('gpu')) console.error('\n  ' + msg);
	}

	let baseline = null;
	const basePath = opt('baseline', null);
	if (basePath) {
		try { baseline = JSON.parse(fs.readFileSync(basePath, 'utf8')); }
		catch (e) { console.error('  could not read baseline: ' + e.message); }
	}

	console.log(report(run, baseline));

	const mdArg = argv.indexOf('--md');
	if (mdArg !== -1) {
		const next = argv[mdArg + 1];
		const mdPath = (next && !next.startsWith('--')) ? next
			: path.join(__dirname, '..', '..', '..', 'docs', 'performance.md');
		fs.mkdirSync(path.dirname(mdPath), { recursive: true });
		fs.writeFileSync(mdPath, markdown(run, baseline, basePath) + '\n');
		console.log('  report written to ' + mdPath + '\n');
	}

	const jsonPath = opt('json', null);
	if (jsonPath) {
		fs.writeFileSync(jsonPath, JSON.stringify(run, null, '\t'));
		console.log('  written to ' + jsonPath + '\n');
	}

	const fatal = (run.errors || []).some((e) => /^fatal|timed out/.test(e));
	process.exit(fatal ? 1 : 0);
}

main().catch((e) => {
	console.error('\n  ' + e.message + '\n');
	process.exit(1);
});
