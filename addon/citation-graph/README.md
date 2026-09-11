# citation-graph

Pluggable edge-derivation for the Zotero citation graph view. Each way of
answering *"does paper A cite paper B, where B is already in the collection?"*
is a **strategy** behind one interface, so they can be enabled, disabled,
weighted and compared independently.

Background and the measurements these strategies are tuned against:
[`../docs/citation-graph-feasibility.md`](../docs/citation-graph-feasibility.md).

## Why strategies are switchable

No single source wins. Measured on a real 395-item library:

- the offline stack and OpenAlex produced ~260 edges each, but agreed on only 177
- each found ~83 edges the other missed, so the union is ~32% larger than either
- the highest-*yield* offline signal (title matching) is also the least
  *trustworthy* — under half its uncorroborated edges could be confirmed

So the design keeps every edge's provenance and confidence rather than
flattening sources into one boolean. A user in a hyperlink-rich field can run
`pdf-links` alone; someone with a DOI-less humanities library needs
`title-match`; someone who wants maximum recall and does not mind the network
adds `openalex`.

`ref-strings` is the odd one out and worth stating separately, because it
answers a different question. Every other strategy answers *"does A cite B,
where B is already in the collection?"* — even the ones that emit ghosts do it
by recognising an identifier. `ref-strings` answers *"what does A cite at
all?"*, by reading the reference entries themselves, and so it is the only
source that can name a work for which nothing anywhere printed an identifier.
That is also why its nodes are keyed on a slug of their own title
(`refParse.js refSignature`), why it is the only strategy that has to hand its
nodes' metadata out of `build()` through `ctx.describe`, and why it is switched
rather than filtered: taking it away removes nodes, not edges.

## Layout

```
core/
  normalize.js        shared DOI/title normalization -- all strategies must use it
  types.js            Edge / Item / Adapter shapes
  collectionIndex.js  the "is it already in the collection?" lookup, built once
  registry.js         strategy registration and config resolution
  graphBuilder.js     runs strategies, merges edges, keeps provenance
adapters/
  localSqlite.js      reads a Zotero data dir directly -- no running Zotero
edges/
  refSection.js       reference-section segmentation (shared, precision-critical)
  refParse.js         reference strings -> entries, fields, identity (pure)
                      styles: ieee, nature, elsevier, apa, acm, vancouver
  pdfLinks.js         DOI hyperlinks in PDF /URI annotations     offline
  textDoi.js          DOIs printed in reference text             offline
  titleMatch.js       cited title found in reference section     offline
  refStrings.js       every work the references NAME             offline
  openalex.js         OpenAlex referenced_works                  network
cli.js                benchmark harness
```

## Adding a strategy

Create `edges/mine.js`, call `register({...})`, and add one `require` to
`index.js`. Nothing in `graphBuilder` changes.

```js
module.exports.id = register({
    id: 'crossref',
    label: 'Crossref reference lists',
    requiresNetwork: true,
    defaultEnabled: false,
    defaultConfidence: 0.95,
    options: { mailto: null },
    async *derive({ items, index, options }) {
        for (const item of items) {
            for (const ref of await fetchRefs(item, options)) {
                const to = index.lookupDoi(ref.DOI);
                if (to && to !== item.key) yield edge(item.key, to, 'crossref', 0.95, { doi: ref.DOI });
            }
        }
    },
});
```

`derive` may return an array, a promise for one, or be an async generator —
generators are preferred for the file-scanning strategies so results stream and
progress is reportable. A strategy that throws is caught and reported in
`meta.errors`; the others still complete.

Obvious next ones: `crossref` (free, no key, DOIs directly), `opencitations`
(free, returns DOI *and* OpenAlex ID per edge), `cita` (read citation notes a
user's Cita plugin already stored), `zotero-relations` (honour manually
confirmed edges).

A strategy that invents nodes rather than recognising them has one more
obligation: call `ctx.describe(key, { title, creators, year, ... })` for every
external key it mints. `build()` returns those as `described`, and for a
namespace no enricher supports it is the only name the node will ever have.

## The adapter boundary

Strategies never touch Zotero APIs or the filesystem directly — only these four
methods:

```
listItems()               -> Item[]
getAttachments(itemKey)   -> Attachment[]
getAttachmentText(attKey) -> string|null   // prefers Zotero's .zotero-ft-cache
getPdfLinkUris(attKey)    -> string[]      // PDF /URI link annotations
```

`localSqlite` implements them against a Zotero data directory, which is what
makes the whole pipeline benchmarkable before any client integration exists. The
Zotero-runtime adapter will back the same four with `Zotero.Items`,
`Zotero.FullText.getItemCacheFile()` and pdf.js `page.getAnnotations()` —
strategies are unaffected.

Note `getAttachmentText` reads the `.zotero-ft-cache` file Zotero's indexer has
**already written** for every attachment, so the text strategies cost no
extraction work at all.

## Usage

Zotero holds a write lock on `zotero.sqlite` while running — copy it first.

```bash
cp ~/Zotero/zotero.sqlite ./z.sqlite

node citation-graph/cli.js --list
node citation-graph/cli.js --data-dir ~/Zotero --db ./z.sqlite
node citation-graph/cli.js --data-dir ~/Zotero --db ./z.sqlite --enable pdf-links,title-match
node citation-graph/cli.js --data-dir ~/Zotero --db ./z.sqlite --offline
node citation-graph/cli.js --data-dir ~/Zotero --db ./z.sqlite --json graph.json
```

`--compare` runs each strategy alone and prints a pairwise overlap matrix plus,
for each, how many edges *only* it found:

```bash
node citation-graph/cli.js --data-dir ~/Zotero --db ./z.sqlite \
     --compare pdf-links,text-doi,title-match,openalex --mailto you@example.com
```

That last column is the validation queue — edges no other strategy corroborates
are exactly the ones worth checking by hand before trusting a strategy.

## Runtime switching

`build()` returns every edge with full provenance, so toggling a strategy *off*
in the UI needs no rebuild:

```js
const { edges } = await cg.build(adapter, { offline: true });
cg.filterEdges(edges, { minConfidence: 0.9 });          // publisher-asserted only
cg.filterEdges(edges, { excludeVia: ['title-match'] }); // drop inferred edges
```

Only enabling a strategy that has not run yet requires re-deriving.
