'use strict';

/**
 * Provider registry.
 *
 * An edge provider is one strategy for deriving "A cites B" edges. Providers
 * are registered by id and selected at build time, so adding a strategy is a
 * new file plus one `register()` call -- never a change to the builder.
 *
 * Provider contract:
 *   id             {string}   stable, used in prefs and in Edge.via
 *   label          {string}   human-readable, for the settings UI
 *   requiresNetwork{boolean}  honoured by the global offline switch
 *   defaultEnabled {boolean}
 *   defaultConfidence {number} 0..1, the provider's baseline trust
 *   options        {Object}   declared option defaults, merged with user config
 *   derive(ctx)    {AsyncGenerator<Edge>|Promise<Edge[]>}
 *
 * `ctx` is { adapter, items, index, options, signal, onProgress }.
 */

const _providers = new Map();

function register(provider) {
	for (const f of ['id', 'label', 'derive']) {
		if (!provider[f]) throw new Error(`provider is missing required field '${f}'`);
	}
	if (_providers.has(provider.id)) {
		throw new Error(`provider '${provider.id}' is already registered`);
	}
	_providers.set(provider.id, {
		requiresNetwork: false,
		defaultEnabled: true,
		defaultConfidence: 0.5,
		options: {},
		...provider,
	});
	return provider.id;
}

function get(id) {
	const p = _providers.get(id);
	if (!p) throw new Error(`unknown provider '${id}' (registered: ${[..._providers.keys()].join(', ') || 'none'})`);
	return p;
}

function all() {
	return [..._providers.values()];
}

/**
 * Resolve a user config into the ordered list of providers to run.
 *
 * @param {Object} [config]
 * @param {string[]} [config.enable]   explicit allow-list; overrides defaults
 * @param {string[]} [config.disable]  subtracted after `enable`
 * @param {boolean}  [config.offline]  drop every provider needing the network
 * @param {Object}   [config.providers] per-provider option overrides, keyed by id
 */
function select(config = {}) {
	const { enable, disable = [], offline = false, providers: opts = {} } = config;
	let chosen = enable && enable.length
		? enable.map(get)
		: all().filter((p) => p.defaultEnabled);

	chosen = chosen.filter((p) => !disable.includes(p.id));

	const skipped = [];
	if (offline) {
		chosen = chosen.filter((p) => {
			if (p.requiresNetwork) { skipped.push(p.id); return false; }
			return true;
		});
	}
	return {
		providers: chosen.map((p) => ({ ...p, options: { ...p.options, ...(opts[p.id] || {}) } })),
		skippedForOffline: skipped,
	};
}

module.exports = { register, get, all, select, _providers };
