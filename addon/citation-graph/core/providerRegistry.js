'use strict';

/**
 * The registry mechanism, shared by both kinds of provider.
 *
 * There are two provider populations -- edge strategies (core/registry.js) and
 * metadata enrichers (core/enrichRegistry.js) -- and they want identical
 * selection semantics: an explicit allow-list, a subtracted deny-list, and a
 * global offline switch that drops anything needing the network. Only the
 * required fields and the per-kind defaults differ.
 *
 * Factoring that out is not tidiness for its own sake: the two registries are
 * configured from the same prefs and the same CLI flags, so if `select()` ever
 * behaved differently between them, `--offline` would mean two things at once.
 *
 * @param {Object} spec
 * @param {string} spec.kind       noun used in error messages ('provider', 'enricher')
 * @param {string[]} spec.required fields a registration must supply
 * @param {Object} spec.defaults   merged under every registration
 */
function createRegistry({ kind = 'provider', required = ['id', 'label'], defaults = {} } = {}) {
	const _providers = new Map();

	function register(provider) {
		for (const f of required) {
			if (!provider[f]) throw new Error(`${kind} is missing required field '${f}'`);
		}
		if (_providers.has(provider.id)) {
			throw new Error(`${kind} '${provider.id}' is already registered`);
		}
		_providers.set(provider.id, { ...defaults, ...provider });
		return provider.id;
	}

	function get(id) {
		const p = _providers.get(id);
		if (!p) {
			throw new Error(`unknown ${kind} '${id}' (registered: `
				+ ([..._providers.keys()].join(', ') || 'none') + ')');
		}
		return p;
	}

	function all() {
		return [..._providers.values()];
	}

	/**
	 * Resolve a user config into the ordered list of providers to run.
	 *
	 * @param {Object} [config]
	 * @param {string[]} [config.enable]    explicit allow-list; overrides defaults
	 * @param {string[]} [config.disable]   subtracted after `enable`
	 * @param {boolean}  [config.offline]   drop every provider needing the network
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

	return { register, get, all, select, _providers };
}

module.exports = { createRegistry };
