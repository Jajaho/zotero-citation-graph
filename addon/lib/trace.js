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
 * OFF unless someone switches it on -- see on(). A line costs a read and a
 * rewrite of the whole file, and the node menu alone spends nine of them on one
 * right-click and a pick, which is not a bill to hand a profile that is not
 * being debugged.
 *
 * TEMPORARY. This exists to find one bug and should come out with it.
 */

const MAX_LINES = 300;

// Zotero.Prefs auto-prefixes 'extensions.zotero.'; see addon/prefs.js.
const PREF = 'zoteroCitationGraph.trace';

let queue_ = Promise.resolve();
let path_ = null;
let t0_ = null;

/** Start the clock the elapsed column counts from. Called from bootstrap as
 *  early as anything of this plugin's can run, so "+Nms" answers the only
 *  question that matters about restore latency: how much of it is ours. */
function start() {
	t0_ = Date.now();
}

/**
 * Is the trail being kept?
 *
 * Asked per line rather than once at load, because a switch on a diagnostic is
 * only worth having if it can be thrown while the thing being diagnosed is
 * going on -- a value read at startup could only be changed by a restart, which
 * is the very event most of these lines are about. The read itself is a lookup
 * in a branch Zotero holds in memory, and an absent default (this file's own
 * prefs.js not loaded yet, which is possible at the very first line bootstrap
 * writes) reads as off, which is what it should be.
 */
function on() {
	try {
		return Zotero.Prefs.get(PREF) === true;
	}
	catch (e) {
		return false;
	}
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
	// Nothing at all when it is off: no file, no Zotero.debug, no work beyond
	// the string the caller has already built. The queue is still what comes
	// back, so a caller that waits on a line waits on the same thing either way.
	if (!on()) return queue_;
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
