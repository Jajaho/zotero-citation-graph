'use strict';

/**
 * A static server over addon/, plus a sink the benchmark posts its results to.
 *
 * Two problems, one answer. The benchmark drives the real graph page in an
 * iframe, which means reading into it -- and over file:// Firefox gives every
 * document its own opaque origin, so the harness could not touch the frame at
 * all. Served over http both documents share an origin and it just works, with
 * no about:config surgery to explain to anyone.
 *
 * And a headless run has to get its numbers back out. The usual answers are a
 * browser driver (a dependency, and a large one) or parsing dump() off stdout
 * (a pref, and a format). A POST back to the server that served the page is
 * neither: same origin, no dependency, no parsing.
 *
 * No framework, because this serves six files to one browser on localhost.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const addonDir = path.join(__dirname, '..', '..', 'addon');

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ftl': 'text/plain; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
};

/**
 * Resolve a URL path inside addon/ and nowhere else.
 *
 * This binds to loopback and lives for the length of one benchmark, but a
 * static server that will serve `../../../.ssh/id_rsa` to anything that asks
 * is not a thing to leave in a repository whatever its intended lifetime.
 */
function resolve(urlPath) {
	const clean = decodeURIComponent(urlPath.split('?')[0]);
	const full = path.resolve(addonDir, '.' + clean);
	const rel = path.relative(addonDir, full);
	if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return full;
}

/**
 * @param {object} o  {port, onResults}
 * @returns {Promise<{port:number, close:function}>}
 */
function serve(o = {}) {
	const server = http.createServer((req, res) => {
		if (req.method === 'POST' && req.url === '/results') {
			let body = '';
			req.on('data', (c) => { body += c; });
			req.on('end', () => {
				res.writeHead(204).end();
				let parsed = null;
				try { parsed = JSON.parse(body); }
				catch (e) { parsed = { errors: ['unparseable results: ' + e.message] }; }
				if (o.onResults) o.onResults(parsed);
			});
			return;
		}
		const file = resolve(req.url === '/' ? '/content/bench/bench.html' : req.url);
		if (!file) return res.writeHead(403).end('outside addon/');
		fs.readFile(file, (err, data) => {
			if (err) return res.writeHead(404).end('not found: ' + req.url);
			res.writeHead(200, {
				'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
				// Every run must measure the build on disk right now, and a
				// cached bench.js from the previous run is a benchmark of the
				// change you just made not being there.
				'cache-control': 'no-store',
			});
			res.end(data);
		});
	});
	return new Promise((done, fail) => {
		server.on('error', fail);
		server.listen(o.port || 0, '127.0.0.1', () => {
			done({
				port: server.address().port,
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

module.exports = { serve };

if (require.main === module) {
	const port = Number(process.argv[2]) || 8730;
	serve({ port, onResults: (r) => console.log(JSON.stringify(r, null, '\t')) })
		.then((s) => {
			console.log('\n  addon/ served at http://127.0.0.1:' + s.port + '/');
			console.log('  benchmark:  http://127.0.0.1:' + s.port + '/content/bench/bench.html');
			console.log('\n  Open it in Firefox. Ctrl-C to stop.\n');
		})
		.catch((e) => { console.error(e.message); process.exit(1); });
}
