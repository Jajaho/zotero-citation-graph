/* global Zotero, IOUtils, PathUtils */

'use strict';

/**
 * A lifecycle breadcrumb trail, for one question this plugin cannot answer any
 * other way: what happens to a graph tab between Zotero quitting and Zotero
 * starting again.
 *
 * Everything interesting there happens while nobody is watching -- the tab
 * strip is read by Zotero.Session from a quit observer, plugin shutdown runs
 * after it, and session restore runs before anything a user could click. A
 * breakpoint is not available and Zotero.debug() only survives if debug logging
 * happened to be switched on beforehand, so this writes to a file of its own
 * instead: <dataDir>/zotero-citation-graph/lifecycle.log, beside the two caches.
 *
 * Bounded to MAX_LINES and appended a line at a time, so it cannot grow without
 * limit. Every write is fire-and-forget and swallows its own errors: a
 * diagnostic that can break the thing it is diagnosing is worse than none.
 *
 * TEMPORARY. This exists to find one bug and should come out with it.
 */

const MAX_LINES = 300;

let queue_ = Promise.resolve();
let path_ = null;
let t0_ = null;

/** Start the clock the elapsed column counts from. Called from bootstrap as
 *  early as anything of this plugin's can run, so "+Nms" answers the only
 *  question that matters about restore latency: how much of it is ours. */
function start() {
	t0_ = Date.now();
}

function path() {
	if (!path_) {
		path_ = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-citation-graph', 'lifecycle.log');
	}
	return path_;
}

/**
 * Record one line. Returns the write, so a caller that is about to be shut down
 * can wait for it -- see flush().
 */
function log(line) {
	let now = new Date();
	let stamped = now.toISOString().replace('T', ' ').slice(0, 23)
		+ (t0_ === null ? '        ' : ('  +' + String(now - t0_).padStart(5) + 'ms'))
		+ '  ' + line;
	Zotero.debug('[zotero-citation-graph] ' + line);
	// Serialised behind one chain: two lines written concurrently would each
	// read the file before the other wrote it, and one would be lost.
	queue_ = queue_.then(() => append(stamped)).catch(() => {});
	return queue_;
}

async function append(line) {
	let p = path();
	let lines = [];
	try {
		lines = (await IOUtils.readUTF8(p)).split('\n').filter(Boolean);
	}
	catch (e) {
		// No file yet, or an unreadable one. Either way, start from here.
	}
	lines.push(line);
	if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
	await IOUtils.makeDirectory(PathUtils.parent(p), { ignoreExisting: true });
	await IOUtils.writeUTF8(p, lines.join('\n') + '\n', { tmpPath: p + '.tmp' });
}

/** Everything written so far, on disk. Awaited at shutdown, where the process
 *  is about to end and an unflushed write is a line that never existed. */
function flush() {
	return queue_.catch(() => {});
}

module.exports = { log, flush, start };
