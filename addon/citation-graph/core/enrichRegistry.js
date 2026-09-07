'use strict';

/**
 * Metadata-enricher registry.
 *
 * An enricher turns an identifier into a name. It exists separately from the
 * edge registry because naming a cited work is not deriving an edge: the two
 * run at different points (edges during the build, names after the external
 * nodes have been rolled up and capped), they fail independently, and one is
 * useless without `includeExternal` while the other is the whole graph.
 *
 * Enricher contract:
 *   id             {string}
 *   label          {string}
 *   requiresNetwork{boolean}  honoured by the global offline switch
 *   defaultEnabled {boolean}
 *   supports       {string[]} external namespaces it can resolve, e.g.
 *                             ['doi', 'openalex']. A provider is never handed a
 *                             ref outside this list, so it needs no guard.
 *   options        {Object}
 *   resolve(ctx)   {Promise<Metadata[]>}
 *
 * `ctx` is { refs, options, signal, onProgress }, where each ref is an already
 * parsed { key, ns, id } -- no enricher re-implements parseExternalKey.
 *
 * A Metadata is defined in types.js. Every field except `key` may be null: the
 * runner merges per field across enrichers, so a provider that knows only the
 * citation count should return only the citation count.
 */

const { createRegistry } = require('./providerRegistry');

const registry = createRegistry({
	kind: 'enricher',
	required: ['id', 'label', 'resolve'],
	defaults: {
		// Every enricher so far is a network call, but the flag is declared per
		// provider rather than assumed: a local cache or an ISBN table would not
		// be, and `offline` must keep meaning exactly one thing.
		requiresNetwork: true,
		// Off unless asked for. The plugin shipped unable to reach the network at
		// all; enrichment must not change that silently.
		defaultEnabled: false,
		supports: ['doi'],
		options: {},
	},
});

module.exports = registry;
