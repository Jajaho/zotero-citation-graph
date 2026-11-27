'use strict';

/**
 * Just enough Marionette to run code in a Gecko app's chrome context, over one
 * session that stays open.
 *
 * The benchmark asks Firefox one question (which renderer drew the canvas) and
 * the smoke test drives Zotero's menus through a dozen steps. A driver library
 * for that would be the dependency this repository has gone without, and the
 * protocol is small: length-prefixed JSON over TCP.
 *
 * Frames are length-prefixed in BYTES, so the buffer is kept as bytes: a reply
 * carrying "Barabási" is one byte longer than its string, and a reader that
 * counted characters would misframe on it.
 *
 * The app has to be started with --marionette, marionette.port set in the
 * profile, and MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 in its environment (Gecko 140
 * and later also want --remote-allow-system-access). Without those the chrome
 * context is refused. Zotero also needs tools/smoke/helper/ installed: a
 * session waits for an "idle startup finished" notice only Firefox sends.
 */

const net = require('net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectOnce(port) {
	return new Promise((resolve, reject) => {
		const s = net.connect(port, '127.0.0.1');
		s.once('connect', () => resolve(s));
		s.once('error', (e) => { s.destroy(); reject(e); });
	});
}

/**
 * Connect, retrying until `timeoutMs` while the app is still starting, and
 * open a chrome-context session.
 *
 * Resolves to { send, run, exec, close }.
 */
async function connect(port, { timeoutMs = 60000, scriptTimeoutMs = 120000, capabilities = {} } = {}) {
	const t0 = Date.now();
	let sock;
	for (;;) {
		try {
			sock = await connectOnce(port);
			break;
		}
		catch (e) {
			if (Date.now() - t0 > timeoutMs) {
				throw new Error('no Marionette on 127.0.0.1:' + port + ' after ' + timeoutMs + ' ms (' + e.message + ')');
			}
			await sleep(300);
		}
	}
	return open(sock, { scriptTimeoutMs, capabilities, deadline: t0 + timeoutMs });
}

async function open(sock, { scriptTimeoutMs, capabilities, deadline }) {
	let buf = Buffer.alloc(0);
	const waiting = new Map();
	let nextId = 1;
	let handshake;
	const greeted = new Promise((r) => { handshake = r; });
	let closed = null;

	sock.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		for (;;) {
			const colon = buf.indexOf(0x3a);
			if (colon < 0) return;
			const len = Number(buf.subarray(0, colon).toString('ascii'));
			if (buf.length < colon + 1 + len) return;
			const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString('utf8'));
			buf = buf.subarray(colon + 1 + len);
			if (!Array.isArray(msg)) { handshake(msg); continue; }
			const [, id, err, res] = msg;
			const w = waiting.get(id);
			waiting.delete(id);
			if (!w) continue;
			if (err) {
				const e = new Error(w.name + ': ' + (err.error || 'error') + ': ' + (err.message || JSON.stringify(err)));
				if (err.stacktrace) e.remoteStack = err.stacktrace;
				w.reject(e);
			}
			else w.resolve(res);
		}
	});
	const onGone = () => {
		if (closed) return;
		closed = new Error('Marionette connection closed');
		for (const w of waiting.values()) w.reject(closed);
		waiting.clear();
	};
	sock.on('close', onGone);
	sock.on('error', onGone);

	function send(name, params = {}) {
		if (closed) return Promise.reject(closed);
		return new Promise((resolve, reject) => {
			const id = nextId++;
			waiting.set(id, { resolve, reject, name });
			const body = Buffer.from(JSON.stringify([0, id, name, params]), 'utf8');
			sock.write(Buffer.concat([Buffer.from(body.length + ':', 'ascii'), body]));
		});
	}

	const session = {
		send,
		/** Run a script body (sync or returning a promise) in chrome; resolve to its value. */
		async exec(script, args = []) {
			const res = await send('WebDriver:ExecuteScript', { script, args });
			return res && typeof res === 'object' && 'value' in res ? res.value : res;
		},
		/**
		 * Run a function in chrome and resolve to what it returns or resolves
		 * to. It is shipped as source, so it closes over nothing on this side:
		 * pass what it needs as arguments, which must be JSON.
		 */
		run(fn, ...args) {
			return session.exec('return (' + fn.toString() + ').apply(this, arguments);', args);
		},
		async close() {
			if (!closed) await send('WebDriver:DeleteSession').catch(() => {});
			sock.destroy();
		},
	};

	let timer;
	try {
		const left = Math.max(1000, deadline - Date.now());
		await Promise.race([greeted, new Promise((resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Marionette never said hello')), left);
		})]);
		clearTimeout(timer);
		await send('WebDriver:NewSession', { capabilities });
		await send('Marionette:SetContext', { value: 'chrome' });
		await send('WebDriver:SetTimeouts', { script: scriptTimeoutMs });
	}
	catch (e) {
		clearTimeout(timer);
		sock.destroy();
		throw e;
	}
	return session;
}

/**
 * One script in chrome, one answer, session closed: what the benchmark needs
 * from Firefox. `script` is a function body that `return`s its answer. Waits up
 * to `waitMs` for the app to listen.
 */
async function chromeEval(port, script, waitMs = 30000) {
	const m = await connect(port, { timeoutMs: waitMs });
	try {
		return await m.exec(script);
	}
	finally {
		await m.close();
	}
}

module.exports = { connect, chromeEval };
