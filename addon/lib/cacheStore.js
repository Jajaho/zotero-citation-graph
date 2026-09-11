/* global Zotero, IOUtils, PathUtils */

'use strict';

/**
 * Where the plugin's caches live, and the one way to throw them all away.
 *
 * Three JSON files in <dataDir>/zotero-citation-graph/: the PDF link scans
 * (pdfLinkCache.js), the metadata looked up for outside references, and the
 * OpenAlex reference lists (both metadataCache.js). Every one of them is
 * reproducible -- a scan run again, a lookup asked again -- which is what makes
 * deleting them a safe thing to put behind a button. lifecycle.log shares the
 * directory and is not a cache; it is left alone.
 *
 * The names live here rather than beside each cache so that clear() cannot miss
 * a file added later: a cache has to take its name from this list to exist.
 *
 * The generation is what keeps a clear from being undone. A build loads its
 * caches when it starts and writes them back whole when it ends, so one that
 * was already running when the button was pressed would put every entry it
 * loaded straight back. Each cache notes the generation it was loaded in, and
 * one loaded before the last clear() drops its write instead -- see flush() in
 * both. The price is that build's own new entries, which the next build finds
 * missing and fetches again: the same thing the clear asked for.
 */

const DIR = 'zotero-citation-graph';

const FILES = {
	pdfLinks: 'pdf-links.json',
	metadata: 'metadata.json',
	references: 'openalex-references.json',
};

let _generation = 0;

function dir() {
	return PathUtils.join(Zotero.DataDirectory.dir, DIR);
}

function generation() {
	return _generation;
}

async function fileSize(path) {
	try {
		return (await IOUtils.stat(path)).size || 0;
	}
	catch (e) {
		// Absent is the ordinary state of a cache nothing has written yet.
		return 0;
	}
}

/** Bytes on disk across every cache file. */
async function size() {
	let sizes = await Promise.all(Object.values(FILES).map(f => fileSize(PathUtils.join(dir(), f))));
	return sizes.reduce((a, b) => a + b, 0);
}

/**
 * Delete every cache file, and the half-written .tmp a flush interrupted by a
 * crash can leave beside one. Throws if a file is there and will not go -- the
 * caller has a user to tell.
 *
 * @returns {Promise<number>} bytes freed
 */
async function clear() {
	// First, so that a build finishing while the files are being removed is
	// already one that will not write them back.
	_generation++;
	let freed = 0;
	for (let name of Object.values(FILES)) {
		let path = PathUtils.join(dir(), name);
		freed += await fileSize(path);
		await IOUtils.remove(path, { ignoreAbsent: true });
		await IOUtils.remove(path + '.tmp', { ignoreAbsent: true });
	}
	return freed;
}

module.exports = { FILES, dir, generation, size, clear };
