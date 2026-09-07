'use strict';

/**
 * Entry point. Requiring this registers every bundled strategy; adding one is a
 * new file under edges/ plus a line here.
 */

require('./edges/pdfLinks');
require('./edges/textDoi');
require('./edges/titleMatch');
require('./edges/openalex');

const registry = require('./core/registry');
const { build, filterEdges, collectExternalNodes } = require('./core/graphBuilder');
const { CollectionIndex } = require('./core/collectionIndex');

module.exports = {
	build,
	filterEdges,
	collectExternalNodes,
	registry,
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
};
