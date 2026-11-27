'use strict';

/**
 * Starting and stopping a throwaway Gecko app -- Zotero, or Firefox for the
 * benchmark -- without touching the user's own.
 *
 * Shared by the rendering benchmark (tools/bench/rendering/run.js) and the
 * smoke test (tools/smoke/run.js). Every run gets a fresh profile, and for
 * Zotero a fresh data directory, under the OS temp directory, and every
 * process is stopped by something only this run's processes have: on Windows
 * the profile path on their command line, elsewhere the process group they
 * were started in. Never by name: the user's own Zotero may be running beside
 * this one, and it is never ours to end.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

/**
 * A throwaway profile, holding a user.js with the prefs every run wants plus
 * `extra` (whole user_pref lines).
 *
 * A fresh one per run so an extension, a stale cache or a leftover pref from
 * the user's own browsing cannot move a number -- and so that running this
 * never touches the profile they actually use.
 */
function makeProfile(extra = [], prefix = 'zg-') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
		...extra,
	].join('\n') + '\n');
	return dir;
}

/** A JSON string, which is also a valid user.js string literal. */
const pstr = (s) => JSON.stringify(String(s));

/**
 * The prefs that make a second Zotero safe to run beside the user's: its own
 * data directory, no first-run dialogs, nothing that syncs or updates.
 *
 * The data directory is the important one. Zotero locks its database, so a
 * second copy pointed at the user's would refuse to start -- or worse -- and
 * the user's is what a profile without this pref defaults to.
 *
 * Add-ons in the profile's extensions directory are sideloads, and Zotero, like
 * Firefox, installs those disabled unless autoDisableScopes says otherwise.
 */
function zoteroPrefs(dataDir) {
	return [
		'user_pref("extensions.zotero.useDataDir", true);',
		'user_pref("extensions.zotero.dataDir", ' + pstr(dataDir) + ');',
		'user_pref("extensions.zotero.firstRun2", false);',
		'user_pref("extensions.zotero.firstRunGuidance", false);',
		'user_pref("extensions.zotero.sync.autoSync", false);',
		'user_pref("extensions.zotero.automaticScraperUpdates", false);',
		'user_pref("extensions.autoDisableScopes", 0);',
	];
}

/**
 * Install an add-on directory as a proxy file: a file named for the add-on id
 * in the profile's extensions directory whose content is the directory's path,
 * UTF-8 and no BOM (tools/install-dev.ps1 says why each detail matters). A
 * fresh profile has no extensions.lastAppBuildId, so Zotero scans for it.
 */
function installProxy(profile, dir) {
	const id = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).applications.zotero.id;
	const ext = path.join(profile, 'extensions');
	fs.mkdirSync(ext, { recursive: true });
	fs.writeFileSync(path.join(ext, id), dir, { encoding: 'utf8' });
	return id;
}

/** Zotero's binary: `override` if given, else the usual install locations. */
function findZotero(override) {
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
 * A free loopback port, for Marionette. Asked of the OS rather than fixed,
 * because another run -- or the user's own Marionette on 2828 -- may be
 * listening at the same time.
 */
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
 * Start the app so that stopByProfile() can end it and everything it started.
 *
 * Off Windows it gets a process group of its own (detached), which is the
 * handle stopByProfile() kills by: a Gecko app forks content processes, a
 * forkserver and a socket process, and Zotero's Linux `zotero` is a bash
 * wrapper that starts zotero-bin as a child rather than exec'ing it, so the
 * PID we hold is the wrapper's. Killing that alone leaves Zotero running.
 * Being detached also
 * means a Ctrl+C in the terminal no longer reaches it, so a caller has to stop
 * it on SIGINT itself. On Windows it stays attached, as it always was there:
 * stopByProfile() finds it by its command line instead.
 */
function spawnApp(binary, args, { env = {}, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
	return spawn(binary, args, {
		stdio,
		env: Object.assign({}, process.env, env),
		detached: process.platform !== 'win32',
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 *
 * Elsewhere the whole process group spawnApp() made goes: SIGTERM, a few
 * seconds to go quietly, then SIGKILL.
 */
async function stopByProfile(child, profile) {
	if (process.platform !== 'win32') return stopGroup(child, profile);
	try { child.kill(); } catch (e) { /* already gone */ }
	const marker = path.basename(profile).replace(/'/g, "''");
	const ours = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID"
		+ " -and $_.Name -match '^(firefox|zotero)\\.exe$' -and $_.CommandLine -like '*" + marker + "*' }";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const left = execFileSync('powershell', ['-NoProfile', '-Command',
				ours + " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };"
				+ ' Start-Sleep -Milliseconds 500; @(' + ours + ').Count'],
			{ encoding: 'utf8', timeout: 60000 }).trim();
			if (left === '0') return true;
		}
		catch (e) { /* try again */ }
	}
	console.error('\n  could not stop the app started with ' + profile
		+ ' -- end it by hand before the next run, or it will compete with it');
	return false;
}

async function stopGroup(child, profile) {
	const pid = child && child.pid;
	if (!pid) return true;
	// A negative pid is the process group. Only a detached child leads one.
	const alive = () => {
		try { process.kill(-pid, 0); return true; }
		catch (e) { return e.code === 'EPERM'; }
	};
	const signal = (sig) => {
		try { process.kill(-pid, sig); }
		catch (e) { /* the group is gone */ }
	};
	if (!alive()) return true;
	signal('SIGTERM');
	for (let i = 0; i < 50 && alive(); i++) await sleep(100);
	if (!alive()) return true;
	signal('SIGKILL');
	for (let i = 0; i < 50 && alive(); i++) await sleep(100);
	if (!alive()) return true;
	console.error('\n  could not stop process group ' + pid + ' (profile ' + profile + ')'
		+ ' -- end it by hand before the next run');
	return false;
}

/** rmSync, a few times: Windows keeps a dead process's files locked a moment. */
async function removeDir(dir) {
	if (!dir) return;
	for (let i = 0; i < 10; i++) {
		try { fs.rmSync(dir, { recursive: true, force: true }); return; }
		catch (e) { await sleep(500); }
	}
	console.error('  could not delete ' + dir);
}

module.exports = {
	makeProfile, zoteroPrefs, installProxy, findZotero, freePort, spawnApp,
	stopByProfile, removeDir, pstr,
};
