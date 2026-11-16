'use strict';

/**
 * Just enough Marionette to run one script in Firefox's chrome context.
 *
 * The benchmark needs exactly one answer from chrome: which renderer drew the
 * canvas (zotero-runner/gfx-probe.js). A web page cannot find that out, and a
 * driver library to ask one question would be the dependency this harness has
 * gone without. The protocol is length-prefixed JSON over TCP; this is the
 * whole client.
 *
 * Firefox has to be started with --marionette, marionette.port set in the
 * profile, and MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 in its environment. Without the
 * variable the chrome context is refused, and the command-line flag of the same
 * name is not enough on its own.
 */

const net = require('net');

function connect(port, deadline) {
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const s = net.connect(port, '127.0.0.1');
			s.once('connect', () => resolve(s));
			s.once('error', (e) => {
				s.destroy();
				if (Date.now() > deadline) reject(e);
				else setTimeout(attempt, 300);
			});
		};
		attempt();
	});
}

/**
 * Run `script` (a function body, sync, `return`s its answer) in chrome and
 * resolve to what it returned. Waits up to `waitMs` for Firefox to listen.
 */
async function chromeEval(port, script, waitMs = 30000) {
	const sock = await connect(port, Date.now() + waitMs);
	let buf = Buffer.alloc(0);
	const waiting = new Map();
	let hello;
	const greeted = new Promise((r) => { hello = r; });
	sock.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		for (;;) {
			const colon = buf.indexOf(0x3a);
			if (colon < 0) return;
			const len = Number(buf.subarray(0, colon).toString());
			if (buf.length < colon + 1 + len) return;
			const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString('utf8'));
			buf = buf.subarray(colon + 1 + len);
			if (!Array.isArray(msg)) { hello(msg); continue; }
			const [, id, err, res] = msg;
			const w = waiting.get(id);
			waiting.delete(id);
			if (w) {
				if (err) w.reject(new Error(err.message || JSON.stringify(err)));
				else w.resolve(res);
			}
		}
	});
	let next = 1;
	const send = (name, params) => new Promise((resolve, reject) => {
		const id = next++;
		waiting.set(id, { resolve, reject });
		const body = Buffer.from(JSON.stringify([0, id, name, params]), 'utf8');
		sock.write(body.length + ':');
		sock.write(body);
	});
	try {
		await greeted;
		await send('WebDriver:NewSession', { capabilities: {} });
		await send('Marionette:SetContext', { value: 'chrome' });
		const res = await send('WebDriver:ExecuteScript', { script, args: [] });
		await send('WebDriver:DeleteSession', {}).catch(() => {});
		return res && 'value' in res ? res.value : res;
	}
	finally {
		sock.destroy();
	}
}

module.exports = { chromeEval };
