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
 *
 * The download is untrusted data. Nothing in it is executed here: it is fetched
 * over HTTPS from download.zotero.org only, its entry names are listed and
 * checked before it is unpacked by the system's own tar, and only text files
 * (application.ini, platform.ini) are read from it. The one thing from it that
 * ever runs is the Zotero binary, and that is the smoke test's business.
 *
 * Each build gets its own directory, created empty for it:
 *   <dir>/<file name without extension>/app/...   the unpacked build
 *   <dir>/<file name without extension>/fetched.json
 * It is unpacked into a fresh <name>.part-XXXXXX directory and renamed into
 * place only once complete, so an interrupted run never leaves something that
 * looks like a build. The archive is deleted after unpacking.
 *
 * Usage: node tools/smoke/fetch-zotero.js --channel release|beta
 *          [--platform linux|win]   default: the platform this runs on
 *          [--dir <cache>]          default: <tmp>/zg-zotero
 *          [--fresh]                download again even if this build is cached
 *
 * Prints, on stdout, key=value lines a shell can read:
 *   binary=/…/Zotero_linux-x86_64/zotero
 *   version=11.0-beta.6+c672babc8
 *   gecko=153.0
 *   url=https://download.zotero.org/…
 * and appends the same lines to $GITHUB_OUTPUT when it is set, so a workflow
 * step with an id can use steps.<id>.outputs.binary. Progress goes to stderr.
 */

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
	return i === -1 || i === argv.length - 1 ? dflt : argv[i + 1];
};

const CHANNELS = ['release', 'beta'];

// What zotero.org calls each platform, what it hands out, and what the binary
// in it is called.
const PLATFORMS = {
	linux: { param: 'linux-x86_64', suffix: '_linux-x86_64.tar.xz', binary: 'zotero' },
	win: { param: 'win-x64-zip', suffix: '_win-x64.zip', binary: 'zotero.exe' },
};

const log = (s) => process.stderr.write(s + '\n');

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
	const location = res.headers.get('location');
	if (res.status < 300 || res.status > 399 || !location) {
		throw new Error(dl + ' answered ' + res.status + ' without a redirect; has zotero.org changed its download links?');
	}
	const url = new URL(location, dl);
	const parts = url.pathname.split('/').map(decodeURIComponent);
	// ['', 'client', channel, version, file]
	if (url.protocol !== 'https:' || url.hostname !== 'download.zotero.org'
		|| parts.length !== 5 || parts[1] !== 'client' || parts[2] !== channel) {
		throw new Error(dl + ' redirects to ' + url.href + ', which is not a download.zotero.org/client/' + channel + '/ build');
	}
	const [, , , version, file] = parts;
	if (!/^[\w.+-]+$/.test(version) || file !== 'Zotero-' + version + PLATFORMS[platform].suffix) {
		throw new Error('unexpected build name in ' + url.href);
	}
	return { url: url.href, version, file };
}

/** Streams the URL to a file and checks it got as many bytes as were announced. */
async function download(url, file) {
	const res = await fetch(url, { redirect: 'error' });
	if (!res.ok) throw new Error(url + ' answered ' + res.status);
	const total = Number(res.headers.get('content-length')) || 0;
	let got = 0;
	let shown = -1;
	const body = Readable.fromWeb(res.body);
	body.on('data', (chunk) => {
		got += chunk.length;
		const pct = total ? Math.floor(got / total * 10) * 10 : -1;
		if (pct !== shown) { shown = pct; if (pct >= 0) process.stderr.write('  ' + pct + '%'); }
	});
	await pipeline(body, fs.createWriteStream(file));
	process.stderr.write('\n');
	if (total && got !== total) throw new Error('download stopped at ' + got + ' of ' + total + ' bytes');
	return got;
}

/**
 * The system's tar: GNU tar on Linux, bsdtar (libarchive) on Windows, which
 * reads zip as well. Both refuse absolute and ".." entries on their own, and
 * neither writes through a symlink the archive itself created; the listing
 * below is a second, explicit check before anything is written.
 */
function tar() {
	if (process.platform === 'win32') {
		return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
	}
	return 'tar';
}

function checkEntries(archive) {
	const names = execFileSync(tar(), ['-tf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
		.split(/\r?\n/).filter(Boolean);
	if (!names.length) throw new Error(archive + ' is empty');
	for (const n of names) {
		if (/^([/\\]|[A-Za-z]:)/.test(n) || n.split(/[/\\]/).includes('..')) {
			throw new Error(archive + ' has an entry outside its own directory: ' + n);
		}
	}
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

async function main() {
	const channel = opt('channel', null);
	if (!CHANNELS.includes(channel)) throw new Error('--channel is ' + CHANNELS.join(' or ') + ', not ' + channel);
	const platform = opt('platform', process.platform === 'win32' ? 'win' : 'linux');
	if (!PLATFORMS[platform]) throw new Error('--platform is ' + Object.keys(PLATFORMS).join(' or ') + ', not ' + platform);
	const cache = path.resolve(opt('dir', path.join(os.tmpdir(), 'zg-zotero')));
	fs.mkdirSync(cache, { recursive: true });

	const build = await resolve(channel, platform);
	log(channel + ' (' + platform + '): ' + build.url);
	const name = build.file.replace(/\.(tar\.xz|zip)$/, '');
	const target = path.join(cache, name);
	const marker = path.join(target, 'fetched.json');

	if (fs.existsSync(marker) && !flag('fresh')) {
		log('cached in ' + target);
	}
	else {
		const work = fs.mkdtempSync(path.join(cache, name + '.part-'));
		try {
			const archive = path.join(work, build.file);
			log('downloading to ' + work);
			const bytes = await download(build.url, archive);
			log('checked ' + checkEntries(archive) + ' entries; unpacking');
			unpack(archive, path.join(work, 'app'));
			fs.rmSync(archive);
			const app = findApp(path.join(work, 'app'), PLATFORMS[platform].binary);
			fs.writeFileSync(path.join(work, 'fetched.json'), JSON.stringify({
				channel, platform, url: build.url, bytes, fetched: new Date().toISOString(),
				binary: path.relative(work, app.binary), ...describe(app),
			}, null, '\t') + '\n');
			// A stale copy of the same build (--fresh, or a run that died
			// after renaming) is ours to replace: the name is the build's.
			fs.rmSync(target, { recursive: true, force: true });
			fs.renameSync(work, target);
		}
		catch (e) {
			fs.rmSync(work, { recursive: true, force: true });
			throw e;
		}
	}

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
