'use strict';

/**
 * The version gate.
 *
 * The version lives in two files that nothing forces to agree: package.json and
 * addon/manifest.json. Zotero reads the manifest; the XPI is named for it; the
 * release tag is a third copy. A disagreement between them does not fail
 * loudly, it ships -- so this makes it fail loudly.
 *
 * Usage:
 *   node tools/check-version.js              # the two files must agree
 *   node tools/check-version.js --tag v1.2.3 # ...and the tag must name them
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Zotero's version comparator accepts more than this, but the release flow
// assumes a plain three-part version it can put in a tag and a filename.
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Reads the version from both files. With { assert: true } a disagreement,
 * a malformed version, or a missing field throws instead of returning.
 */
function readVersions({ assert = false, tag = null } = {}) {
	const pkgPath = path.join(root, 'package.json');
	const manifestPath = path.join(root, 'addon', 'manifest.json');

	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

	const problems = [];
	if (!pkg.version) problems.push('package.json has no "version"');
	if (!manifest.version) problems.push('addon/manifest.json has no "version"');

	if (pkg.version && manifest.version && pkg.version !== manifest.version) {
		problems.push(
			`version mismatch: package.json is ${pkg.version}, ` +
				`addon/manifest.json is ${manifest.version}`
		);
	}
	if (manifest.version && !VERSION_RE.test(manifest.version)) {
		problems.push(`addon/manifest.json version "${manifest.version}" is not MAJOR.MINOR.PATCH`);
	}

	if (tag) {
		// Accept the tag with or without its leading v, so a release run is not
		// wrecked by the one character everyone disagrees about.
		const bare = tag.replace(/^v/, '');
		if (bare !== manifest.version) {
			problems.push(`tag ${tag} does not name version ${manifest.version}`);
		}
	}

	// updates.json is what Zotero fetches to decide an update is available. It
	// is not required to exist, but if it does it must not lag the manifest.
	const updatesPath = path.join(root, 'updates.json');
	if (fs.existsSync(updatesPath)) {
		try {
			const updates = JSON.parse(fs.readFileSync(updatesPath, 'utf8'));
			const id = manifest.applications && manifest.applications.zotero
				? manifest.applications.zotero.id
				: null;
			const list = (updates.addons && id && updates.addons[id] && updates.addons[id].updates) || [];
			if (!list.some(u => u.version === manifest.version)) {
				problems.push(`updates.json has no entry for version ${manifest.version}`);
			}
		} catch (e) {
			problems.push(`updates.json is not valid JSON: ${e.message}`);
		}
	}

	if (assert && problems.length) {
		throw new Error(problems.join('\n  - '));
	}
	return { version: manifest.version, pkg: pkg.version, manifest: manifest.version, problems };
}

if (require.main === module) {
	const argv = process.argv.slice(2);
	const tagIdx = argv.indexOf('--tag');
	const tag = tagIdx === -1 ? null : argv[tagIdx + 1];

	const { version, problems } = readVersions({ tag });
	if (problems.length) {
		console.error('version check failed:\n  - ' + problems.join('\n  - '));
		process.exit(1);
	}
	console.log(`version ok: ${version}${tag ? ` (tag ${tag})` : ''}`);
}

/**
 * The distributable's filename, in one place.
 *
 * It is derived from package.json's name rather than written out, so the
 * archive, the release asset and the update_link in updates.json cannot drift
 * apart from the repository -- which is exactly what happened when the project
 * was renamed and the XPI kept its old name.
 *
 * NOTE: this is not the addon id. The id in addon/manifest.json identifies an
 * installed plugin to Zotero and cannot change without orphaning every install.
 */
function xpiName(version) {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	return `${pkg.name}-${version}.xpi`;
}

/**
 * The name the XPI is attached to a GitHub release under, which is also the
 * last part of its update_link in updates.json.
 *
 * Upper-case .XPI on purpose. GitHub sets an asset's Content-Type from its name
 * and ignores the one the upload sends: a name ending in .xpi is served as
 * application/x-xpinstall, and Firefox answers that by trying to install the
 * plugin into itself instead of saving it. The match is case-sensitive, so
 * .XPI is served as application/octet-stream and simply downloads. Zotero does
 * not care about either the case or the type. Releases up to v0.76.5 were
 * attached as .xpi and keep that name, because their links must not move.
 */
function assetName(version) {
	return xpiName(version).replace(/\.xpi$/, '.XPI');
}

module.exports = { readVersions, xpiName, assetName };
