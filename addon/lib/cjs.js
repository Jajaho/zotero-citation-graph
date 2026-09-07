/* global Services */

/**
 * Minimal CommonJS loader for the Zotero chrome sandbox.
 *
 * The plugin sandbox has no `require`. Core solves the same problem with
 * Services.scriptloader.loadSubScriptWithOptions() against a plain object target
 * (see xpcom/plugins.js setDefaultPrefs), and that is all this needs to be.
 *
 * The point of this file: citation-graph/ is plain CommonJS with zero Node-only
 * requires, so with a working `require` it loads into Zotero unmodified -- no
 * bundler, no build step, and the same source keeps running under Node for the
 * benchmark CLI.
 */

this.makeRequire = function (rootURI, globals) {
	let cache = new Map();

	function resolve(fromURL, spec) {
		let s = spec;
		if (!/\.[a-z]+$/i.test(s)) {
			s += s.endsWith('/') ? 'index.js' : '.js';
		}
		return new URL(s, fromURL).href;
	}

	function load(fromURL, spec) {
		let url = resolve(fromURL, spec);
		if (cache.has(url)) {
			return cache.get(url).exports;
		}
		let module = { exports: {} };
		// Cache before executing so circular requires get the partial exports
		// rather than recursing forever.
		cache.set(url, module);

		let scope = Object.assign({}, globals, {
			module,
			exports: module.exports,
			require: spec2 => load(url, spec2),
			__filename: url,
			__dirname: url.slice(0, url.lastIndexOf('/')),
		});

		Services.scriptloader.loadSubScriptWithOptions(url, {
			target: scope,
			charset: 'utf-8',
			// Defeats the startup cache so edits are picked up on the next
			// Zotero restart without -purgecaches.
			ignoreCache: true,
		});

		// A module may reassign module.exports wholesale.
		module.exports = scope.module.exports;
		return module.exports;
	}

	return spec => load(rootURI, spec);
};
