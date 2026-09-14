'use strict';

/**
 * Shared vocabulary. No runtime behaviour -- typedefs plus the two small
 * value helpers every provider needs.
 *
 * @typedef {Object} Item
 * @property {string} key          Zotero item key (stable identity in the graph)
 * @property {string} itemType
 * @property {string} title
 * @property {?string} doi         raw, un-normalized
 * @property {?string} date
 * @property {?string} extra
 * @property {?string} url
 * @property {?string} publication  venue: journal, proceedings or book title
 * @property {?string} volume       venue coordinates. A numeric-style reference
 * @property {?string} pages        prints no title and often no DOI, so these
 * @property {?string} journalAbbreviation  are all that can identify the work.
 * @property {string[]} creators   surnames, in order
 * @property {string[]} tags       every tag on the item, manual and automatic alike
 *
 * @typedef {Object} Attachment
 * @property {string} key
 * @property {string} parentKey
 * @property {string} contentType
 * @property {?string} hash        content hash; cache keys derive from this
 *
 * @typedef {Object} Edge
 * @property {string} from         citing item key
 * @property {string} to           cited item key
 * @property {string} via          provider id that produced it
 * @property {number} confidence   0..1, provider's own estimate
 * @property {Object} [evidence]   provider-specific, for the UI's "why?" panel
 *
 * @typedef {Object} MergedEdge
 * @property {string} from
 * @property {string} to
 * @property {number} confidence   max across contributing providers
 * @property {string[]} via        every provider that produced this edge
 * @property {Object[]} evidence
 *
 * @typedef {Object} Metadata
 * What an enricher (core/enrichRegistry.js) knows about one identifier. Every
 * field but `key` may be null -- core/enrich.js merges per field across
 * enrichers, so a provider returns only what it actually resolved.
 * @property {string} key            the external node key it answers, e.g. 'doi:10.1038/...'
 * @property {?string} title
 * @property {string[]} creators     surnames, in order
 * @property {?number} year
 * @property {?string} itemType      the source's own vocabulary, not Zotero's
 * @property {?string} doi
 * @property {?string} url
 * @property {?number} citedByGlobal citations in the WHOLE literature. Never to be
 *   confused with externalNodes[].citedBy, which counts citers inside this
 *   collection. That one is what the graph is about; see
 *   docs/external-references.md for why the distinction is load-bearing.
 * @property {string[]} source       enricher ids that contributed a field
 *
 * @typedef {Object} Adapter
 * Everything a provider is allowed to touch. Two implementations exist:
 * `adapters/localSqlite.js` (runs standalone against a copy of zotero.sqlite)
 * and, later, a Zotero-runtime adapter backed by Zotero.Items / Zotero.FullText.
 * Providers must never reach past this interface -- that is what keeps them
 * runnable both inside and outside the app.
 * @property {() => Promise<Item[]>} listItems
 * @property {(itemKey: string) => Promise<Attachment[]>} getAttachments
 * @property {(attKey: string) => Promise<?string>} getAttachmentText
 * @property {(attKey: string) => Promise<string[]>} getPdfLinkUris
 */

/** Providers should build edges through this so the shape stays uniform. */
function edge(from, to, via, confidence, evidence) {
	return { from, to, via, confidence, evidence: evidence || null };
}

/** Canonical key for an unordered lookup of a directed pair. */
function edgeKey(from, to) {
	return from + '\u0000' + to;
}


/**
 * Node key for a cited work that is NOT in the collection.
 *
 * Zotero item keys are 8 uppercase alphanumerics, so a namespaced key can never
 * collide with one -- which is what lets external and collection nodes share a
 * single key space and therefore a single edge list.
 *
 * These exist only when build() is called with includeExternal. Offline there
 * is no metadata behind them: a DOI harvested from a PDF is a DOI and nothing
 * more, so a bare identifier is all the UI has to label them with.
 *
 * `ref` is the exception and the reason build() grew a metadata sink. Its id is
 * not a registered identifier at all but a slug of the cited work's own title
 * (edges/refParse.js refSignature), minted for references that name a work no
 * identifier was printed for. Nothing can resolve one -- no enricher declares
 * `ref` and externalUrl() has no address for it -- so unlike the other three it
 * has to arrive from the build already carrying its name.
 */
const EXTERNAL_NS = ['doi', 'arxiv', 'openalex', 'ref'];

function externalKey(ns, id) {
	return ns + ':' + id;
}

function isExternalKey(key) {
	const i = String(key).indexOf(':');
	return i > 0 && EXTERNAL_NS.includes(key.slice(0, i));
}

function parseExternalKey(key) {
	const i = String(key).indexOf(':');
	return i > 0 ? { ns: key.slice(0, i), id: key.slice(i + 1) } : null;
}

module.exports = { edge, edgeKey, externalKey, isExternalKey, parseExternalKey, EXTERNAL_NS };
