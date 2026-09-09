'use strict';

/**
 * Packs addon/ into a distributable .xpi -- a plain zip with manifest.json at
 * the archive ROOT, not inside a wrapper folder.
 *
 * Install it via Zotero: Tools -> Plugins -> gear icon -> "Install Plugin From
 * File". That path does not depend on the extensions-directory rescan at all,
 * so it is the reliable fallback when proxy-file development install misbehaves.
 *
 * Node, not PowerShell, so the same build runs on a developer's machine and on
 * a Linux CI runner. The zip is written by tools/zip.js rather than a
 * dependency, and is byte-identical across runs for identical input.
 *
 * Usage: node tools/build-xpi.js [--out <dir>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zip } = require('./zip.js');
const { readVersions } = require('./check-version.js');

const root = path.join(__dirname, '..');
const addonDir = path.join(root, 'addon');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outDir = outIdx === -1 ? path.join(root, 'dist') : path.resolve(argv[outIdx + 1]);

// The Node-only adapter requires node:sqlite/zlib/child_process and is never
// loaded inside Zotero -- only tools/cli.js uses it. Shipping it would put
// unreachable code in every install.
const EXCLUDE = ['citation-graph/adapters'];

/** Every file under dir, as archive-relative forward-slash paths, sorted. */
function walk(dir, prefix = '') {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
		else if (entry.isFile()) out.push(rel);
	}
	// Sorted so the archive's entry order does not depend on the filesystem.
	return out.sort();
}

/**
 * Zotero's schema rejects a manifest missing any of these, and the failure
 * surfaces as ERROR_CORRUPT_FILE / "may be incompatible with this version of
 * Zotero" -- which points nowhere near the real cause. Fail loudly here instead.
 */
function validateManifest(manifestPath) {
	const bytes = fs.readFileSync(manifestPath);
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw new Error(
			"manifest.json starts with a UTF-8 BOM. Zotero's parser rejects it. " +
				"(Windows PowerShell 5.1's 'Set-Content -Encoding utf8' adds one -- " +
				'use [IO.File]::WriteAllText with UTF8Encoding($false) instead.)'
		);
	}

	let manifest;
	try {
		manifest = JSON.parse(bytes.toString('utf8'));
	} catch (e) {
		throw new Error(`manifest.json is not valid JSON: ${e.message}`);
	}

	const z = (manifest.applications && manifest.applications.zotero) || {};
	const missing = [];
	// update_url is the non-obvious one: Zotero REQUIRES it even for a plugin
	// that will never auto-update. Omitting it cost hours once; don't repeat it.
	for (const f of ['id', 'update_url', 'strict_min_version']) {
		if (!z[f]) missing.push(`applications.zotero.${f}`);
	}
	for (const f of ['manifest_version', 'name', 'version']) {
		if (!manifest[f]) missing.push(f);
	}
	if (z.strict_min_version && z.strict_min_version.includes('*')) {
		missing.push("applications.zotero.strict_min_version must not contain '*'");
	}
	if (missing.length) {
		throw new Error('manifest.json is invalid for Zotero:\n  - ' + missing.join('\n  - '));
	}
	return manifest;
}

function main() {
	// A version mismatch must not reach an artifact -- the XPI is named for one
	// of the two numbers, so a disagreement ships silently.
	readVersions({ assert: true });

	const manifest = validateManifest(path.join(addonDir, 'manifest.json'));
	const version = manifest.version;
	const id = manifest.applications.zotero.id;

	const names = walk(addonDir).filter(n => !EXCLUDE.some(e => n.startsWith(e)));
	const entries = names.map(name => ({ name, data: fs.readFileSync(path.join(addonDir, name)) }));

	// Cheap to check, and the whole archive is worthless without them.
	for (const required of ['manifest.json', 'bootstrap.js']) {
		if (!names.includes(required)) {
			throw new Error(`addon/ has no ${required} at its root -- the XPI would not load`);
		}
	}

	const buf = zip(entries);

	fs.mkdirSync(outDir, { recursive: true });
	const xpi = path.join(outDir, `zotero-graph-${version}.xpi`);
	fs.writeFileSync(xpi, buf);

	const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

	console.log(`built  ${xpi}`);
	console.log(`       id=${id} version=${version}`);
	console.log(`       ${entries.length} entries, ${buf.length} bytes`);
	console.log(`       sha256:${sha256}`);
	console.log('');
	console.log('Install:  Zotero -> Tools -> Plugins -> gear icon -> Install Plugin From File');
	console.log(`          then pick ${xpi}`);
}

if (require.main === module) {
	try {
		main();
	} catch (e) {
		console.error(`build failed: ${e.message}`);
		process.exit(1);
	}
}
