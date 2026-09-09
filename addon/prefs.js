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

// The "Add to Zotero" dialog opens with these, and writes back whatever it was
// last used with. The tag is deliberately NOT localised: it is library data, not
// interface text, and a tag that changed with Zotero's display language would
// split one shelf of papers across two names.
pref("extensions.zotero.zoteroGraph.addTag", "added by citation graph");
pref("extensions.zotero.zoteroGraph.addTagEnabled", true);

// Width of the tab's side panel, in pixels -- the one the item pane sits in.
// Written back whenever the splitter is dragged, so the panel opens at the size
// it was last left.
//
// The old readerPaneWidth is read as a fallback (splitPane.js storedWidth) so a
// profile that had dragged the PDF pane this plugin used to put here keeps the
// width it chose; it has no default here any more, so only a value someone
// actually set is ever seen.
pref("extensions.zotero.zoteroGraph.paneWidth", 520);
