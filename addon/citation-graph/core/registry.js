'use strict';

/**
 * Edge-provider registry.
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
 *
 * The register/get/all/select machinery lives in providerRegistry.js, shared
 * with the metadata enrichers in enrichRegistry.js so that `offline` and the
 * enable/disable lists cannot come to mean two different things.
 */

const { createRegistry } = require('./providerRegistry');

const registry = createRegistry({
	kind: 'provider',
	required: ['id', 'label', 'derive'],
	defaults: {
		requiresNetwork: false,
		defaultEnabled: true,
		defaultConfidence: 0.5,
		options: {},
	},
});

module.exports = registry;
