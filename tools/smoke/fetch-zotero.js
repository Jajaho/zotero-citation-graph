'use strict';

/**
 * Downloads Zotero's official build for a channel, unpacks it, and prints where
 * the binary is and which version it is.
 *
 * The smoke test (tools/smoke/run.js) needs a Zotero to load the XPI into, and
 * the point of running it on a schedule is to meet the next Zotero before our
 * users do: #26 broke when the 11 beta moved to a new Gecko, with no change on
 * our side. So this takes whatever zotero.org hands out today for the channel,
 * not a pinned version.
 *
 * Where it comes from. zotero.org/download/client/dl?channel=&platform= answers
 * with a 302 to download.zotero.org/client/<channel>/<version>/<file>, which is
 * how the download page's own buttons work. The version is read from that URL
 * before anything is downloaded, so a cached copy of the same build is reused.
 * Platforms used here (checked 2026-11-27):
 *   linux-x86_64  Zotero-<v>_linux-x86_64.tar.xz
 *   win-x64-zip   Zotero-<v>_win-x64.zip, the portable build: the same files
 *                 the setup .exe installs, without having to unpack an
 *                 installer with 7-Zip.
 * There is no macOS path: Zotero ships a .dmg there, and nothing here mounts
 * one. Pass a Zotero you have to the smoke test with --zotero instead.
 *
 * The download is untrusted data, and Zotero publishes no checksum to hold it
 * against. What it rests on is HTTPS to download.zotero.org and a redirect
 * whose every part is checked before it is followed. Nothing in it is executed
 * here. Before it is unpacked, its listing is checked: every entry must be a
 * plain file or a directory (no symlinks, no hard links), and no name may be
 * absolute, climb out with "..", or carry a component Windows would rewrite
 * (a trailing dot or space, a colon). Beyond that the system's own tar does the
 * unpacking, and only text files (application.ini, platform.ini) are read from
 * the result. The one thing from it that ever runs is the Zotero binary, and
 * that is the smoke test's business.
 *
 * Each build gets its own directory, created empty for it:
 *   <dir>/<file name without extension>/app/...   the unpacked build
 *   <dir>/<file name without extension>/fetched.json
 * It is unpacked into a fresh <name>.part-XXXXXX directory and renamed into
 * place only once complete, so an interrupted run never leaves something that
 * looks like a build. If another run finished the same build first, its copy
 * is used and this one is thrown away. .part- directories older than an hour
 * are a crashed run's and are removed. The archive is deleted after unpacking.
 */

const USAGE = `Usage: node tools/smoke/fetch-zotero.js --channel release|beta
         [--platform linux|win]   default, and the only one allowed: this machine's
         [--dir <cache>]          default: <tmp>/zg-zotero
         [--fresh]                download again even if this build is cached

Prints, on stdout, key=value lines a shell can read:
  binary=/.../Zotero_linux-x86_64/zotero
  version=11.0-beta.6+c672babc8
  gecko=153.7.0
  url=https://download.zotero.org/...
and appends the same lines to $GITHUB_OUTPUT when it is set, so a workflow
step with an id can use steps.<id>.outputs.binary. Progress goes to stderr.
macOS is not supported: pass your own Zotero to the smoke test with --zotero.`;

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt) => {
	const i = argv.indexOf('--' + name);
	if (i === -1) return dflt;
	const v = argv[i + 1];
	// "--dir --fresh" is a forgotten value, not a directory called --fresh.
	if (v === undefined || v.startsWith('--')) throw new Error('--' + name + ' needs a value');
	return v;
};

const CHANNELS = ['release', 'beta'];

// What zotero.org calls each platform, what it hands out, what the binary in
// it is called, and the only host that can unpack and run it.
const PLATFORMS = {
	linux: { param: 'linux-x86_64', suffix: '_linux-x86_64.tar.xz', binary: 'zotero', host: 'linux' },
	win: { param: 'win-x64-zip', suffix: '_win-x64.zip', binary: 'zotero.exe', host: 'win32' },
};

const ATTEMPTS = 3;
const STALE_MS = 60 * 60 * 1000;

const log = (s) => process.stderr.write(s + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs fn up to ATTEMPTS times, waiting 5 s, then 20 s. zotero.org and its CDN
 * fail now and then, and in release.yml a failed fetch blocks the attach.
 */
async function retry(what, fn) {
	for (let attempt = 1; ; attempt++) {
		try { return await fn(); }
		catch (e) {
			if (attempt >= ATTEMPTS || e.permanent) throw e;
			const wait = 5000 * 4 ** (attempt - 1);
			log(what + ' failed (' + e.message + '); trying again in ' + wait / 1000 + ' s');
			await sleep(wait);
		}
	}
}

/** An error no retry can fix: zotero.org answered, and the answer is wrong. */
function permanent(message) {
	const e = new Error(message);
	e.permanent = true;
	return e;
}

/**
 * Asks zotero.org where the channel's current build is, without following the
 * redirect, and checks the answer has the shape the download page uses. A
 * redirect anywhere else is refused rather than followed: the URL decides what
 * gets unpacked and later run.
 */
async function resolve(channel, platform) {
	const dl = 'https://www.zotero.org/download/client/dl?channel=' + channel
		+ '&platform=' + PLATFORMS[platform].param;
	const res = await fetch(dl, { method: 'HEAD', redirect: 'manual' });
	if (res.status >= 500) throw new Error(dl + ' answered ' + res.status);
	const location = res.headers.get('location');
	if (res.status < 300 || res.status > 399 || !location) {
		throw permanent(dl + ' answered ' + res.status + ' without a redirect; has zotero.org changed its download links?');
	}
	const url = new URL(location, dl);
	const parts = url.pathname.split('/').map(decodeURIComponent);
	// ['', 'client', channel, version, file]
	if (url.protocol !== 'https:' || url.hostname !== 'download.zotero.org' || url.port !== ''
		|| parts.length !== 5 || parts[1] !== 'client' || parts[2] !== channel) {
		throw permanent(dl + ' redirects to ' + url.href + ', which is not a download.zotero.org/client/' + channel + '/ build');
	}
	const [, , , version, file] = parts;
	if (!/^[\w.+-]+$/.test(version) || file !== 'Zotero-' + version + PLATFORMS[platform].suffix) {
		throw permanent('unexpected build name in ' + url.href);
	}
	return { url: url.href, version, file };
}

/** Streams the URL to a file and checks it got as many bytes as were announced. */
async function download(url, file) {
	const res = await fetch(url, { redirect: 'error' });
	if (!res.ok) {
		const msg = url + ' answered ' + res.status;
		throw res.status >= 500 || res.status === 429 ? new Error(msg) : permanent(msg);
	}
	const total = Number(res.headers.get('content-length')) || 0;
	let got = 0;
	let shown = -1;
	const body = Readable.fromWeb(res.body);
	body.on('data', (chunk) => {
		got += chunk.length;
		const pct = total ? Math.floor(got / total * 10) * 10 : -1;
		if (pct !== shown) { shown = pct; if (pct >= 0) process.stderr.write('  ' + pct + '%'); }
	});
	// createWriteStream truncates, so a retry starts the file over.
	await pipeline(body, fs.createWriteStream(file));
	process.stderr.write('\n');
	if (total && got !== total) throw new Error('download stopped at ' + got + ' of ' + total + ' bytes');
	return got;
}

/** The system's tar: GNU tar on Linux, bsdtar (libarchive) on Windows, which reads zip as well. */
function tar() {
	if (process.platform === 'win32') {
		return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
	}
	return 'tar';
}

const listing = (archive, verbose) => execFileSync(tar(), [verbose ? '-tvf' : '-tf', archive],
	{ encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);

/**
 * Refuses an archive with anything but plain files and directories, or with a
 * name that would land outside the directory it is unpacked into.
 *
 * Types come from the verbose listing, whose first character is the entry's
 * type in both tars ("-" file, "d" directory, "l" symlink, "h" hard link);
 * anything but "-" and "d" is refused, and so is a line naming a link target,
 * which is how bsdtar shows a hard link. Names come from the plain listing,
 * which has nothing but the name on each line. Both list the same entries in
 * the same order.
 */
function checkEntries(archive) {
	const names = listing(archive, false);
	const types = listing(archive, true);
	if (!names.length) throw new Error(archive + ' is empty');
	if (names.length !== types.length) {
		throw new Error(archive + ' lists ' + names.length + ' names but ' + types.length + ' entries');
	}
	names.forEach((n, i) => {
		const t = types[i];
		if (!/^[-d]/.test(t) || / -> | link to /.test(t)) {
			throw new Error(archive + ' has an entry that is not a plain file or directory: ' + t);
		}
		const bad = /^([/\\]|[A-Za-z]:)/.test(n) || n.split(/[/\\]/).some((c) =>
			c === '..' || c.includes(':') || (c !== '.' && /[. ]$/.test(c)));
		if (bad) throw new Error(archive + ' has an entry outside its own directory, or one Windows would rename: ' + n);
	});
	return names.length;
}

function unpack(archive, into) {
	fs.mkdirSync(into);
	const args = ['-xf', archive, '-C', into];
	// As root (a container), GNU tar would restore the archive's owners.
	if (process.platform !== 'win32') args.push('--no-same-owner');
	execFileSync(tar(), args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

/**
 * Zotero's application.ini, which sits in app/ beside the binary (Zotero 10
 * and 11, Linux and Windows alike) or, in older builds, beside it.
 */
function applicationIni(dir) {
	return [path.join(dir, 'app', 'application.ini'), path.join(dir, 'application.ini')]
		.find((f) => fs.existsSync(f)) || null;
}

/** The directory holding the binary and platform.ini: the top level, or one folder down. */
function findApp(root, binaryName) {
	const dirs = [root, ...fs.readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory()).map((d) => path.join(root, d.name))];
	for (const d of dirs) {
		const bin = path.join(d, binaryName);
		if (fs.existsSync(path.join(d, 'platform.ini')) && applicationIni(d)
			&& fs.statSync(bin, { throwIfNoEntry: false })?.isFile()) {
			return { dir: d, binary: bin };
		}
	}
	throw new Error('no ' + binaryName + ' with a platform.ini and an application.ini in ' + root);
}

/** One key from one [section] of an .ini file, or null. */
function ini(file, section, key) {
	if (!file || !fs.existsSync(file)) return null;
	let current = null;
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const s = line.match(/^\s*\[(.+)\]\s*$/);
		if (s) { current = s[1]; continue; }
		const kv = line.match(/^\s*([^=#;]+?)\s*=\s*(.*?)\s*$/);
		if (kv && current === section && kv[1] === key) return kv[2];
	}
	return null;
}

function describe(app) {
	const appIni = applicationIni(app.dir);
	return {
		version: ini(appIni, 'App', 'Version'),
		buildId: ini(appIni, 'App', 'BuildID'),
		// platform.ini is Gecko's own; Milestone is its version.
		gecko: ini(path.join(app.dir, 'platform.ini'), 'Build', 'Milestone'),
	};
}

/**
 * fs calls that Windows refuses for a moment while Defender scans a file that
 * was just written, or while another process still has it open.
 */
async function patiently(fn) {
	for (let i = 0; ; i++) {
		try { return fn(); }
		catch (e) {
			// ENOTEMPTY and EEXIST: a rename onto the directory another run
			// renamed into place first. The next try sees its marker.
			if (i >= 9 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e;
			await sleep(500);
		}
	}
}

/** Removes .part- directories that a crashed or killed run left behind. */
function removeStale(cache) {
	for (const d of fs.readdirSync(cache, { withFileTypes: true })) {
		if (!d.isDirectory() || !/\.part-[A-Za-z0-9]{6}$/.test(d.name)) continue;
		const p = path.join(cache, d.name);
		try {
			if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) {
				fs.rmSync(p, { recursive: true, force: true });
				log('removed a stale ' + d.name);
			}
		}
		catch (e) { /* another run got there first, or still holds it */ }
	}
}

async function fetchInto(cache, name, build, channel, platform) {
	const target = path.join(cache, name);
	const marker = path.join(target, 'fetched.json');
	const work = fs.mkdtempSync(path.join(cache, name + '.part-'));
	try {
		const archive = path.join(work, build.file);
		log('downloading to ' + work);
		const bytes = await retry('download', () => download(build.url, archive));
		log('checked ' + checkEntries(archive) + ' entries; unpacking');
		unpack(archive, path.join(work, 'app'));
		await patiently(() => fs.rmSync(archive));
		const app = findApp(path.join(work, 'app'), PLATFORMS[platform].binary);
		fs.writeFileSync(path.join(work, 'fetched.json'), JSON.stringify({
			channel, platform, url: build.url, bytes, fetched: new Date().toISOString(),
			binary: path.relative(work, app.binary), ...describe(app),
		}, null, '\t') + '\n');
		// The marker is written before the rename, so a directory of this
		// name without one was not finished by this script. It, or with
		// --fresh any copy, is ours to replace: the name is the build's.
		if (fs.existsSync(target) && (flag('fresh') || !fs.existsSync(marker))) {
			await patiently(() => fs.rmSync(target, { recursive: true, force: true }));
		}
		await patiently(() => {
			// Another run sharing the cache may finish the same build first;
			// a rename onto its directory then fails, and its copy is as good.
			if (fs.existsSync(marker)) {
				log('another run finished this build first; using its copy');
				fs.rmSync(work, { recursive: true, force: true });
				return;
			}
			fs.renameSync(work, target);
		});
	}
	catch (e) {
		fs.rmSync(work, { recursive: true, force: true });
		throw e;
	}
}

async function main() {
	if (flag('help') || argv.includes('-h')) { console.log(USAGE); return; }
	if (process.platform === 'darwin') {
		throw new Error('macOS is not supported: Zotero ships a .dmg there. Pass your own Zotero to the smoke test with --zotero.');
	}
	const channel = opt('channel', null);
	if (!CHANNELS.includes(channel)) throw new Error('--channel is ' + CHANNELS.join(' or ') + ', not ' + channel + '\n\n' + USAGE);
	const platform = opt('platform', process.platform === 'win32' ? 'win' : 'linux');
	if (!PLATFORMS[platform]) throw new Error('--platform is ' + Object.keys(PLATFORMS).join(' or ') + ', not ' + platform);
	// The build is unpacked with this machine's tar and then run here, so it
	// has to be this machine's: the Linux build's permissions do not survive
	// NTFS, and a zip of Windows executables is of no use on Linux.
	if (PLATFORMS[platform].host !== process.platform) {
		throw new Error('--platform ' + platform + ' only runs on ' + PLATFORMS[platform].host + ', and this is ' + process.platform);
	}
	const cache = path.resolve(opt('dir', path.join(os.tmpdir(), 'zg-zotero')));
	fs.mkdirSync(cache, { recursive: true });
	removeStale(cache);

	const build = await retry('asking zotero.org for the ' + channel + ' build', () => resolve(channel, platform));
	log(channel + ' (' + platform + '): ' + build.url);
	const name = build.file.replace(/\.(tar\.xz|zip)$/, '');
	const target = path.join(cache, name);
	const marker = path.join(target, 'fetched.json');

	if (fs.existsSync(marker) && !flag('fresh')) log('cached in ' + target);
	else await fetchInto(cache, name, build, channel, platform);

	const fetched = JSON.parse(fs.readFileSync(marker, 'utf8'));
	const binary = path.join(target, fetched.binary);
	if (!fs.existsSync(binary)) throw new Error(binary + ' is gone; run again with --fresh');
	const app = describe({ dir: path.dirname(binary) });
	if (app.version !== build.version) {
		log('note: application.ini says ' + app.version + ', the download URL ' + build.version);
	}
	log('Zotero ' + app.version + ' (Gecko ' + app.gecko + ', build ' + app.buildId + ')');

	const out = 'binary=' + binary + '\nversion=' + app.version + '\ngecko=' + app.gecko
		+ '\nurl=' + build.url + '\n';
	process.stdout.write(out);
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
}

main().catch((e) => {
	console.error('fetch-zotero: ' + e.message);
	process.exit(1);
});
