// Default prefs, loaded onto the default branch by Zotero with FULL pref names.
// Read them as Zotero.Prefs.get('zoteroGraph.<name>') -- Zotero.Prefs auto-prefixes
// 'extensions.zotero.'.
pref("extensions.zotero.zoteroGraph.strategies", "pdf-links,text-doi,title-match");
pref("extensions.zotero.zoteroGraph.minConfidence", 0);
pref("extensions.zotero.zoteroGraph.usePdfLinks", true);

// Metadata enrichment for outside references (docs/external-references.md).
// Ordered: core/enrich.js merges fill-first, so this list is the ranking.
pref("extensions.zotero.zoteroGraph.enrichers", "openalex");
// Optional. OpenAlex has required a key since 13 Feb 2026, but keyless access
// still works at about a tenth of the free daily allowance -- enough for a
// collection at a time, which is all this plugin ever asks for.
// Free key: https://openalex.org/settings/api
pref("extensions.zotero.zoteroGraph.openalex.apiKey", "");

// Width of the in-tab reader pane, in pixels. Written back whenever the
// splitter is dragged, so the pane opens at the size it was last left.
pref("extensions.zotero.zoteroGraph.readerPaneWidth", 520);
