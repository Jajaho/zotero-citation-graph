#!/usr/bin/env node
'use strict';

/**
 * Run the graph rendering benchmark in headless Firefox and print the numbers.
 *
 * Firefox rather than a browser that is easier to automate: Zotero 7 is Firefox
 * 115 ESR, so this is the same rasteriser, the same text shaping and the same
 * compositor. Numbers from Chromium would be a real measurement of the wrong
 * renderer, which is worse than none because it looks like an answer.
 *
 * Absolute figures still belong to Zotero itself -- see tools/bench/README.md
 * for opening the same page there. What this is for is the other question, and
 * the one asked far more often: did that change make it faster, and by how
 * much. For a comparison, both runs measured the same way on the same machine
 * minutes apart, Firefox is exactly right.
 *
 * No browser-driver dependency. The page is served over http by serve.js and
 * posts its results back to it, which is all the channel a benchmark needs.
 *
 * Usage:
 *   node tools/bench/run.js [options]
 *     --n <count>          items in the synthetic collection (default 1500)
 *     --frames <count>     measured frames per scenario (default 90)
 *     --repeat <count>     interleaved repeats, for a noise floor (default 3)
 *     --only <a,b>         run only these scenarios
 *     --quick              settle and steady only
 *     --no-ablate          skip the per-subsystem attribution
 *     --json <file>        write the full run to a file
 *     --md [file]          write a markdown report (default docs/performance.md)
 *     --baseline <file>    compare against an earlier --json and show deltas
 *     --firefox <path>     override the browser binary
 *     --headed             show the browser (for watching a scenario misbehave)
 *     --timeout <seconds>  give up after this long (default 240)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { serve } = require('./serve.js');

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
		+ 'FIREFOX_BIN. Zotero 7 is Firefox 115 ESR, so Firefox is what makes '
		+ 'these numbers comparable to Zotero.');
}

/**
 * A throwaway profile.
 *
 * A fresh one per run so an extension, a stale cache or a leftover pref from
 * the user's own browsing cannot move a number -- and so that running this
 * never touches the profile they actually browse with.
 */
function makeProfile() {
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
	].join('\n'));
	return dir;
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

function report(run, baseline) {
	const lines = [];
	const c = run.config || {};
	lines.push('');
	lines.push('  ' + (c.n || '?') + ' items, ' + (c.edges || '?') + ' edges, '
		+ (c.external || 0) + ' outside refs · viewport ' + c.vw + '×' + c.vh
		+ ' · dpr ' + (run.env && run.env.dpr));
	lines.push('  ' + ((run.env && run.env.agent) || '').replace(/^Mozilla\/5\.0 /, ''));
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
	L.push('[tools/bench/README.md](../tools/bench/README.md).');
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
	L.push('');
	L.push('> Headless Firefox renders in **software**, so these absolute times are');
	L.push('> slower than a GPU-composited Zotero. They are here to be compared with');
	L.push('> each other, not quoted as what a user sees. Zotero 7 is Firefox 115 ESR,');
	L.push('> so the renderer is the same family; `npm run bench:open` takes the same');
	L.push('> measurements inside Zotero itself.');
	L.push('');

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
 * Driving it
 * ------------------------------------------------------------------ */

async function main() {
	const binary = findFirefox();
	const timeout = Number(opt('timeout', 240)) * 1000;

	let resolveResults;
	const got = new Promise((r) => { resolveResults = r; });
	const server = await serve({ onResults: resolveResults });

	const q = new URLSearchParams({ auto: '1' });
	q.set('n', opt('n', '1500'));
	q.set('frames', opt('frames', '90'));
	q.set('repeat', opt('repeat', '3'));
	if (opt('seed', null)) q.set('seed', opt('seed'));
	if (opt('ratio', null)) q.set('ratio', opt('ratio'));
	if (opt('only', null)) q.set('only', opt('only'));
	if (flag('quick')) q.set('quick', '1');
	if (flag('no-ablate')) q.set('ablate', '0');
	const url = 'http://127.0.0.1:' + server.port + '/content/bench/bench.html?' + q;

	const profile = makeProfile();
	const args = ['--profile', profile, '--no-remote', '--new-instance'];
	if (!flag('headed')) args.push('--headless');
	args.push(url);

	console.log('\n  ' + binary);
	console.log('  ' + url);

	const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	child.stderr.on('data', (d) => { stderr += d; });

	const timer = setTimeout(() => {
		resolveResults({ errors: ['timed out after ' + (timeout / 1000) + 's'
			+ (stderr ? ' — browser said: ' + stderr.trim().split('\n').slice(-3).join(' / ') : '')] });
	}, timeout);

	const run = await got;
	clearTimeout(timer);

	try { child.kill(); } catch (e) { /* already gone */ }
	await server.close();
	try { fs.rmSync(profile, { recursive: true, force: true }); }
	catch (e) { /* a locked profile dir is not worth failing the run over */ }

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
			: path.join(__dirname, '..', '..', 'docs', 'performance.md');
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
