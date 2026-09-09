'use strict';

/**
 * A minimal ZIP writer, because an XPI is a zip and Node ships no way to make
 * one. The alternative was a dependency; this project has none, and a build
 * tool is the last place worth starting.
 *
 * Only the subset an XPI needs is implemented: no zip64 (the addon is well
 * under 4 GB and 65535 entries), no encryption, no data descriptors. Entries
 * are stored deflated, or uncompressed when deflating would make them bigger.
 *
 * Every entry gets the same fixed DOS timestamp, so building the same source
 * twice produces byte-identical output. That turns "did this XPI come from
 * that commit?" into a question a hash can answer.
 */

const zlib = require('zlib');

// 1980-01-01 00:00:00, the zero of DOS time. Real mtimes would make the
// archive differ run to run for no gain -- nothing reads these dates.
const DOS_DATE = (1 << 5) | 1; // year 1980, month 1, day 1
const DOS_TIME = 0;

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

/**
 * entries: [{ name, data }] -- name uses forward slashes and is relative to the
 * archive root. Returns the complete archive as a Buffer.
 */
function zip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;

	for (const { name, data } of entries) {
		const nameBuf = Buffer.from(name, 'utf8');
		// Bit 11 tells the reader the name is UTF-8. Harmless for pure ASCII,
		// required the moment a filename is not.
		const flags = nameBuf.equals(Buffer.from(name, 'latin1')) ? 0 : 0x800;

		const deflated = zlib.deflateRawSync(data, { level: 9 });
		const stored = deflated.length >= data.length;
		const method = stored ? 0 : 8;
		const body = stored ? data : deflated;
		const crc = crc32(data);

		const local = Buffer.alloc(30 + nameBuf.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28); // extra length
		nameBuf.copy(local, 30);

		const central = Buffer.alloc(46 + nameBuf.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk number start
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0, 38); // external attrs
		central.writeUInt32LE(offset, 42); // offset of local header
		nameBuf.copy(central, 46);

		locals.push(local, body);
		centrals.push(central);
		offset += local.length + body.length;
	}

	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4); // this disk
	eocd.writeUInt16LE(0, 6); // disk with central directory
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16); // central directory offset
	eocd.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { zip, crc32 };
