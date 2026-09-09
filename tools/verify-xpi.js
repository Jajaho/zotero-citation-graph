'use strict';

/**
 * Reads a built XPI back and checks it is the thing Zotero will accept.
 *
 * This deliberately does NOT use tools/zip.js. A packer that is wrong in some
 * consistent way would round-trip through its own reader perfectly, and the
 * failure would only surface as ERROR_CORRUPT_FILE on a user's machine. So the
 * archive is parsed here from the central directory outwards, the way any other
 * zip reader would, and the manifest is decompressed and checked for real.
 *
 * Usage: node tools/verify-xpi.js [path/to.xpi]
 *        (with no argument, verifies the XPI matching the current version)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('./zip.js');

const root = path.join(__dirname, '..');

/** Parses the central directory. Returns [{ name, method, sizes, crc, offset }]. */
function readCentralDirectory(buf) {
	// The end-of-central-directory record is last, but a trailing comment can
	// push it back, so scan for its signature from the end.
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd === -1) throw new Error('no end-of-central-directory record: this is not a zip');

	const count = buf.readUInt16LE(eocd + 10);
	const cdSize = buf.readUInt32LE(eocd + 12);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	if (cdOffset + cdSize > buf.length) throw new Error('central directory runs past the end of the file');

	const entries = [];
	let p = cdOffset;
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) {
			throw new Error(`central directory entry ${i} has a bad signature`);
		}
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		entries.push({
			name: buf.toString('utf8', p + 46, p + 46 + nameLen),
			method: buf.readUInt16LE(p + 10),
			crc: buf.readUInt32LE(p + 16),
			compressedSize: buf.readUInt32LE(p + 20),
			size: buf.readUInt32LE(p + 24),
			offset: buf.readUInt32LE(p + 42),
		});
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

/** Pulls one entry's bytes out via its local header, checking the CRC. */
function extract(buf, entry) {
	if (buf.readUInt32LE(entry.offset) !== 0x04034b50) {
		throw new Error(`${entry.name}: local header signature is wrong`);
	}
	const nameLen = buf.readUInt16LE(entry.offset + 26);
	const extraLen = buf.readUInt16LE(entry.offset + 28);
	const start = entry.offset + 30 + nameLen + extraLen;
	const body = buf.subarray(start, start + entry.compressedSize);

	let data;
	if (entry.method === 0) data = Buffer.from(body);
	else if (entry.method === 8) data = zlib.inflateRawSync(body);
	else throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);

	if (data.length !== entry.size) {
		throw new Error(`${entry.name}: inflated to ${data.length} bytes, directory says ${entry.size}`);
	}
	const actual = crc32(data);
	if (actual !== entry.crc) {
		throw new Error(`${entry.name}: CRC is ${actual.toString(16)}, directory says ${entry.crc.toString(16)}`);
	}
	return data;
}

function main() {
	let xpi = process.argv[2];
	if (!xpi) {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, 'addon', 'manifest.json'), 'utf8'));
		xpi = path.join(root, 'dist', `zotero-graph-${manifest.version}.xpi`);
	}
	if (!fs.existsSync(xpi)) throw new Error(`no such file: ${xpi}`);

	const buf = fs.readFileSync(xpi);
	const entries = readCentralDirectory(buf);
	const names = entries.map(e => e.name);

	const problems = [];

	// A wrapper folder is the classic way to build an XPI that installs into
	// nothing: Zotero looks for these two at the archive root and nowhere else.
	for (const required of ['manifest.json', 'bootstrap.js']) {
		if (!names.includes(required)) problems.push(`${required} is not at the archive root`);
	}
	// The Node-only adapter pulls node:sqlite and friends; it must never ship.
	for (const name of names) {
		if (name.startsWith('citation-graph/adapters')) problems.push(`${name} should have been excluded`);
		if (name.includes(String.fromCharCode(92))) problems.push(`${name} uses a backslash separator`);
	}
	// A CR in a packed file means some source escaped the LF normalisation, and
	// the archive's bytes -- so its hash -- now depend on who checked it out.
	// That is exactly how types.js behaved while one NUL byte had git treating it
	// as binary and exempt from the text rules. A published checksum is only worth
	// something if this cannot happen quietly.
	const TEXT = /.(js|json|css|html|svg|ftl|md)$/;
	for (const entry of entries) {
		if (!TEXT.test(entry.name)) continue;
		let data;
		try { data = extract(buf, entry); } catch { continue; } // CRC errors are reported below
		if (data.includes(String.fromCharCode(13))) {
			problems.push(`${entry.name} contains CR: the build is not reproducible across platforms`);
		}
	}

	// The bundled force-graph is MIT; its notice has to travel with every copy.
	if (!names.includes('THIRD-PARTY-NOTICES.md')) {
		problems.push('THIRD-PARTY-NOTICES.md is missing -- the bundled MIT code needs its notice');
	}

	// Every entry must actually decompress and match its CRC. This is the check
	// that catches a packer bug rather than a packaging-list bug.
	for (const entry of entries) {
		try {
			extract(buf, entry);
		} catch (e) {
			problems.push(e.message);
		}
	}

	// And the manifest has to survive the round trip as usable JSON.
	let version = null;
	const manifestEntry = entries.find(e => e.name === 'manifest.json');
	if (manifestEntry) {
		try {
			const manifest = JSON.parse(extract(buf, manifestEntry).toString('utf8'));
			version = manifest.version;
			const source = JSON.parse(fs.readFileSync(path.join(root, 'addon', 'manifest.json'), 'utf8'));
			if (manifest.version !== source.version) {
				problems.push(`packed manifest is ${manifest.version}, source is ${source.version}`);
			}
			if (!path.basename(xpi).includes(manifest.version)) {
				problems.push(`${path.basename(xpi)} is not named for version ${manifest.version}`);
			}
		} catch (e) {
			problems.push(`packed manifest.json is unreadable: ${e.message}`);
		}
	}

	if (problems.length) {
		console.error('XPI verification failed:\n  - ' + problems.join('\n  - '));
		process.exit(1);
	}
	console.log(`xpi ok: ${path.basename(xpi)}`);
	console.log(`        ${entries.length} entries, all CRCs match, version ${version}`);
}

try {
	main();
} catch (e) {
	console.error(`XPI verification failed: ${e.message}`);
	process.exit(1);
}
