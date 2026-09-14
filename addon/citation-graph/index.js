'use strict';

/**
 * Entry point. Requiring this registers every bundled provider; adding one is a
 * new file under edges/ or enrich/ plus a line here.
 *
 * Two populations, two registries, on purpose: an edge strategy answers "does A
 * cite B", an enricher answers "what is this identifier called". See
 * docs/external-references.md.
 */

require('./edges/pdfLinks');
require('./edges/textDoi');
require('./edges/titleMatch');
require('./edges/locatorMatch');
require('./edges/refStrings');
require('./edges/openalex');

require('./enrich/openalex');

const registry = require('./core/registry');
const enrichRegistry = require('./core/enrichRegistry');
const { build, filterEdges, collectExternalNodes, consolidateByTitle } = require('./core/graphBuilder');
const { enrich } = require('./core/enrich');
const { CollectionIndex } = require('./core/collectionIndex');

module.exports = {
	build,
	filterEdges,
	collectExternalNodes,
	consolidateByTitle,
	enrich,
	registry,
	enrichRegistry,
	CollectionIndex,
	/** For a settings pane: everything the user can toggle. */
	listStrategies: () => registry.all().map((p) => ({
		id: p.id,
		label: p.label,
		requiresNetwork: p.requiresNetwork,
		defaultEnabled: p.defaultEnabled,
		defaultConfidence: p.defaultConfidence,
		options: p.options,
	})),
	listEnrichers: () => enrichRegistry.all().map((p) => ({
		id: p.id,
		label: p.label,
		requiresNetwork: p.requiresNetwork,
		defaultEnabled: p.defaultEnabled,
		supports: p.supports,
		options: p.options,
	})),
};
