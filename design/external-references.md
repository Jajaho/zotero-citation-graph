# External references: naming them, counting them, adding them

Design note for three related features on the "ghost" nodes described in the README —
cited works the collection does not hold, keyed `doi:<doi>`.

| # | Feature | Status |
|---|---|---|
| 1 | Resolve a ghost's identifier to a **name** (author, year, title) | built — `enrich/openalex.js` |
| 2 | Attach a **global citation count** to a ghost | built — same call |
| 3 | **Add a ghost to Zotero** as a real item | built — `graphTab.js:addByDoi` |
| 4 | **Cache** resolved metadata across rebuilds | built — `lib/metadataCache.js` |
| 5 | Enrich **held items** too, so both sizing modes span the whole graph | built |
| 6 | Name a cited work that has **no identifier at all** (`ref:` nodes) | built -- `edges/refStrings.js`, Part 7 |

Feature 3 was deliberately last: it is the smallest of them, because Zotero already implements
it and we call that implementation directly.

---

## Part 1 — How Zotero adds an item from an identifier

Read out of `Zotero/app/omni.ja`, not from documentation. The magic-wand ("Add Item by
Identifier") path is about forty lines, in `chrome/content/zotero/lookup.js`,
`Zotero_Lookup.addItemsFromIdentifier`:

```js
var identifiers = Zotero.Utilities.extractIdentifiers(textBox.value);
for (let identifier of identifiers) {
    let translate = new Zotero.Translate.Search();
    translate.setIdentifier(identifier);        // {DOI}|{ISBN}|{PMID}|{arXiv}|{adsBibcode}
    let translators = await translate.getTranslators();
    translate.setTranslator(translators);        // "be lenient": hand it ALL of them
    newItems.push(...(await translate.translate({
        libraryID, collections, saveAttachments: !childItem
    })));
}
```

Four things in there are load-bearing for us.

**`setTranslator(<the whole array>)` is not laziness.** `Zotero.Translate.Search.prototype.complete`
(`translate/src/translation/translate.js:2777`) shifts to the next translator whenever one
returns no items, then re-enters `translate()`. You do not choose a metadata source; you hand
over the ranked list and let it fall through. Any reimplementation of ours would have to
rebuild that fallback chain by hand.

**`translate({ libraryID: false })` returns the item JSON without saving anything.**
`translate.js:180`:

```js
// if we're not supposed to save the item or we're in a child translator,
// just return the item array
if (translate._libraryID === false || translate._parentTranslator) {
    translate.newItems.push(item);
    return translate._runHandler("itemDone", item, item);
}
```

Zotero itself uses this as its metadata-lookup API, in `recognizeDocument.js:490` and `:624`.
So "resolve a DOI to a name" needs no new code and no new dependency — only a chrome context,
which a bootstrap plugin has.

**`collections: [id]`** files the new item directly into a collection, so "add this ghost" can
land in the collection the graph was built from with no follow-up step.

**`saveAttachments: true`** triggers Zotero's own open-access PDF lookup. Free.

### The find: Crossref REST is a batch DOI resolver that Zotero never calls

`translators/Crossref REST.js` (priority 90, `translatorType: 8`):

```js
function detectSearch(item) { return false; }        // never auto-selected

function doSearch(item) {
    if (item.DOI) {
        if (Array.isArray(item.DOI))                 // <- accepts an ARRAY
            query = '?filter=doi:' + item.DOI.map(x => ZU.cleanDOI(x)).filter(x => x).join(',doi:');
```

`detectSearch` returning `false` means `getTranslators()` never surfaces it; it is reachable
only via an explicit `setTranslator("0a61e167-de9a-4f93-a68a-628b48855909")`. Nothing under
`chrome/` does that. Its one caller, `DOI Content Negotiation.js`, has it behind an `if (false)`
left over from a May 2025 Crossref outage.

So a working N-DOIs-in-one-request resolver ships inside Zotero, wired to nothing:

```js
let t = new Zotero.Translate.Search();
t.setTranslator('0a61e167-de9a-4f93-a68a-628b48855909');
t.setSearch({ itemType: 'journalArticle', DOI: [d1, ..., d50] });
let items = await t.translate({ libraryID: false });   // 50 works, one HTTP request
```

The default DOI path (`DOI Content Negotiation`, priority 100) is one `https://doi.org/<doi>`
request per DOI with `Accept: datacite+json, crossref-unixref+xml, csl+json`, handing the body
to an import translator. Correct for one item, hopeless for the 4,564 ghost DOIs the sample
library produces.

---

## Part 2 — Choosing the metadata / citation-count API

Verified February–September 2026, not from memory.

| Source | count field | batch | auth | limits |
|---|---|---|---|---|
| **OpenAlex** | `cited_by_count` | 50/call, `filter=doi:a\|b\|...` | key required since **13 Feb 2026**; keyless is ~1/10 the daily budget | list call = 10 credits |
| **Crossref REST** | `is-referenced-by-count` | yes, `filter=doi:a,doi:b` | none; `mailto` for the polite pool | **5 rps public / 10 rps polite** since Dec 2025 |
| **Semantic Scholar** | `citationCount` | **500/call**, `POST /graph/v1/paper/batch` | free key | 1 rps with key |
| **OpenCitations** | `/index/v2/citation-count/{doi}` | **no — one DOI per request** | free token | 180 req/min |

OpenCitations is out on batching alone: 4,564 ghosts at 180/min is 25 minutes of wall clock.
Crossref's counts cover Crossref-deposited references only, so they read systematically low.

**Decision: OpenAlex is the first and default enricher**, because one `filter=doi:...` list call
returns `display_name`, `publication_year`, `authorships`, `cited_by_count` *and*
`referenced_works` in the same response. That serves ghost naming, citation counts, and the
existing `edges/openalex.js` edge provider from a single network layer. Cost for the whole
sample library: 4,564 DOIs / 50 = 92 calls x 10 credits = 920 credits, comfortably inside even
the keyless allowance.

Semantic Scholar is the better *second* enricher than Crossref (500 ids per call beats 50), at
the price of a key and a second identifier vocabulary (`DOI:10....`, `ARXIV:...`).

Two consequences of the Feb 2026 OpenAlex change, both now applied to `edges/openalex.js`: the
`mailto` polite-pool parameter is **ignored by the server** and has been removed, and the key
moves to an `Authorization: Bearer` header so it does not appear in URLs, logs, or error text.

---

## Part 3 — Where enrichment lives, and why not in `edges/`

Naming a ghost is **node enrichment**, not edge derivation. Putting it behind `register()` in
`core/registry.js` would have made `graphBuilder.build()` return metadata as a side effect of
producing edges, which is the wrong seam: the two run at different times (edges during the
build, names after the external nodes have been rolled up and capped) and fail independently.

So there is a second, parallel registry:

```
core/providerRegistry.js   createRegistry() -- the enable/disable/offline selection logic
core/registry.js           edge providers      (unchanged public API: register/get/all/select)
core/enrichRegistry.js     metadata providers
core/enrich.js             the runner: refs -> { metadata, meta }
enrich/openalex.js         the first provider
```

`core/registry.js` and `core/enrichRegistry.js` are now thin instances of the same factory, so
the two kinds of provider get identical `enable` / `disable` / `offline` semantics for free, and
neither can drift from the other.

### The enricher contract

```
id             {string}
label          {string}
requiresNetwork{boolean}   honoured by the global offline switch
defaultEnabled {boolean}
supports       {string[]}  external namespaces it can resolve, e.g. ['doi','openalex']
options        {Object}
resolve(ctx)   {Promise<Metadata[]>}   ctx = { refs, options, signal, onProgress }
```

`refs` are `{ key, ns, id }` — already parsed, so a provider never re-implements
`parseExternalKey`. A provider is only ever handed refs whose `ns` it declared in `supports`.

### Why the chain is fill-first, not first-wins

`enrich()` runs the selected providers in order and merges **per field**, keeping the first
non-null value for each field. That is what makes "add another API later" real rather than
aspirational: OpenAlex names most of the DOIs, a Crossref enricher would fill the DataCite-
registered ones it missed, Semantic Scholar would fill arXiv preprints — and each provider is
only sent the refs that are still incomplete, so the second provider costs a request only for
the tail.

### `citedByGlobal`, never `citedBy`

`externalNodes[].citedBy` already means *how many papers in this collection cite this work*. The
global count is a different number and is called `citedByGlobal` everywhere, including on the
wire. This is not pedantry — see Part 4.

### Fetching a name and drawing one are two switches

`query node metadata` decides whether a ghost is *given* a name; `hide outside names`
decides whether the one it has is *drawn* on the canvas. They are deliberately not the same
question. The first reaches the network and rebuilds nothing; the second reaches
nothing at all — the panel checkbox is read by the label pass in `placeLabel()`, so
switching it costs one repaint and no node moves.

It ships **off** -- names drawn -- because an unnamed ghost is a grey dot whose only
answer is its tooltip. It exists because of the graphs where that trade goes the other way: with
the lookup off, or past its cap, a ghost falls back to the tail of its DOI, and a
collection whose outside references outnumber its papers is then a canvas of
registrant strings sitting on top of the citekeys you came to read. Taking those
names out of the label pass hands the room back to the held items, which is half
the point of the switch.

What it does **not** do is clear `node.label`. The label is what the search box
matches on and what heads its rows, so a ghost with its name undrawn is still a
ghost you can find by name.

---

## Part 4 — Why global citation count is NOT the primary signal

The README's justification for computing ghosts at all is:

> a work twenty of your papers cite and you do not have is a gap in the library

That is local in-degree, which the graph already renders as node size. A globally famous paper
you do not hold is not a gap in your library; it is merely famous. Sizing or colouring by
`citedByGlobal` would replace a signal about *this collection* with one about the literature as
a whole, and the ghost feature would stop answering the question it exists to answer.

So: **local in-degree is the default sizing metric, and global citations are an explicit,
labelled mode you have to choose** — the `size` dropdown, `cited here` by default. The
distinction is preserved by being visible rather than by being unavailable: the user opts into
a different question, they are never silently shown the wrong answer to this one. The tooltip
wording ("cited by N *here*" versus "N citations total") carries the same distinction and must
not be reworded to match.

Two details that make the global mode readable rather than decorative:

- **Area proportional to the count, normalised to the 95th percentile on screen.** The first
  version of this was a log scale normalised to the maximum, and it was unusable: `log10`
  compressed the domain, force-graph's own `radius = sqrt(val)` compressed it again, and a 40×
  difference in citations came out as a **1.27× difference in radius** — a 4,000-citation paper
  drawn the same size as a 100-citation one. Two lessons, both now encoded in tests:
  force-graph's value is an *area*, so a scale that does not undo its sqrt is compressed twice;
  and citation counts are heavy-tailed, so normalising on the maximum lets one landmark paper
  flatten the whole rest of the graph. Above the percentile the curve continues
  logarithmically rather than clamping, because a hard clamp tied the 41,000-citation outlier
  with the 4,000-citation one.
- **The curve is a separate module.** `content/nodeScale.js` is pure and loaded as a plain
  `<script>` like force-graph, so `tools/test-cjs-shim.js` can evaluate it and assert
  monotonicity, the magnitude separation, and the area round-trip. The original scale shipped
  because it was reasoned about rather than computed.
- **Unknown is not zero.** Anything without a resolved count sizes to a fixed small value, so
  "not looked up" stays distinguishable from "never cited".
- **Picking the mode is the request for the data.** The dropdown option used to be disabled until
  `query node metadata` had run, which told the user what they could not have and left them to find the
  checkbox that would allow it. It now switches the lookup on and runs it. The distinction that
  matters is that the network is still only ever reached on a deliberate choice — one of two, now,
  instead of one. Switching `query node metadata` back off drops sizing to `cited here`, and that
  fallback keys off the checkbox rather than the last payload: while the lookup is in flight the
  counts are on their way, and the mode the user just picked has to survive the wait.
- **The lookup is a phase, not a rebuild.** It is the only scope option that derives nothing: no
  item joins or leaves the collection for it, and no edge is found or lost — it writes names and
  counts onto nodes that are already on screen. So toggling it runs phase 4 alone, over the build
  the tab already holds (`entry.built`), and the renderer sees a payload whose nodes and edges are
  byte-identical to the last one. That is what keeps the layout still: a rebuild opens by pushing
  an empty edge list, which strips every edge off the graph and re-anneals it from nothing over
  the next two phases. Sizing by `global citations` is the one case that still moves the graph
  when the counts land, and it has to — every circle changes size, and the collision force has
  real overlaps to resolve. Sized by `cited here`, the same payload lands without moving anything.

Both modes apply to ghosts and held items alike — which is the whole reason feature 5 exists.
Sizing by a number only half the graph has would be worse than not offering it.

---

## Part 5 — Adding a ghost to Zotero

The content page runs under a content principal and cannot touch Zotero, so this goes over the
existing bridge: `content/graph.js` emits `{ type: 'add-item', doi, title }`, and
`lib/graphTab.js:handleMessage` gained a `case 'add-item'` beside `'open-item'` that calls
`addByDoi()` — the `lookup.js` sequence verbatim, with `saveAttachments: true` so Zotero's own
open-access PDF lookup runs. The `title` is carried only so the dialog below can name the work;
chrome does not keep the last payload's metadata around.

**Where it goes is asked first.** `lib/addDialog.js` puts a XUL `<panel>` in the main window
with two questions — a tag, defaulting to `added by citation graph` and applied as a manual
tag after the save, and a collection, defaulting to the one the graph is of. `collections:` is
then `[chosen]` or `[]`, an empty list being the library root. The picker is core's
`Zotero.Utilities.Internal.createMenuForTarget()` and *New Collection…* opens core's
`newCollectionDialog.xhtml`; both are used exactly as `newCollectionDialog.js` uses them, so
the menu cannot come to disagree with the collection pane about what the library holds. It is
built in the main window's document because a Zotero 7+ plugin registers no `chrome://`
package, and a `resource://` document of ours is not privileged enough to hold XUL widgets.

The tag is a second write rather than part of the save: `Zotero.Translate.ItemSaver` takes a
library and collections and nothing else. A tag that will not stick is logged, not reported as
a failed add — the paper is in the library either way.

Cancelling, a DOI that resolves to nothing, and a failed translate all end without a rebuild,
so each sends `zgAddSettled` back. The gap list disables a row's `+` the moment it is pressed
and had nothing but the rebuild to give it back.

`Zotero.Utilities.extractIdentifiers` is not needed: the ghost's key already holds a DOI that
`normDoi` produced, so `setIdentifier({ DOI: d })` is enough.

**The click does not add anything.** Clicking a ghost opens a popover showing the title,
authors, both citation counts and the DOI; adding is a button inside it. Adding writes to the
library, and a stray click while panning must not silently file a paper. `Escape` and a
background click dismiss it.

**It rebuilt once, and that was the wrong instrument.** After the save the ghost's `doi:...` key
has to become the new item's 8-character key and every edge pointing at it has to follow, and a
rebuild got that right by construction. It also opened by pushing an empty edge list through
phase 1, which takes every edge off the layout and re-anneals it from nothing over the next two
phases — so the answer to "add this one paper" was the whole graph rearranging itself.

`adoptAdded()` folds the paper in instead. It re-keys the edges in place, appends the item —
described by `zoteroAdapter.js:itemRecord()`, the very function the build describes its own
items with, so a newcomer cannot be shaped differently from its neighbours — adds it to
`inCollection`, moves the ghost's `citedByGlobal` onto it, and pushes once. The three things a
rebuild was there to keep consistent take care of themselves: `pushData()` recomputes the
external roll-up from the edges on every push, so the ghost stops being an outside reference by
construction, and the payload carries `meta.adopted = { was, now }` so the renderer's
`nodeCache` can hand the ghost's coordinates to the new node.

The page then holds the layout still around it. `placeAdopted()` gives the new node the ghost's
coordinates, or — with outside refs off, where no ghost was drawn — the centroid of the papers
citing it, so there is nothing left to arrange. `holdStill()` then spends the alpha that
`graphData()` set: every node but the new one is fixed where it stands and `d3AlphaDecay` is
turned right up, so ten ticks take alpha from 1 to 0.001 with nothing free to move, and the
release that follows is into an alpha of nothing.

That is `settle()`'s mechanism with a different target, and both now go through `shedTo(target,
freeID)`. **The shed has to end, and quickly.** The first version of this held the freeze for
the whole engine run and gave it back from `onEngineStop`, which is up to `cooldownTime` — 15
seconds. A frozen node carries `fx`/`fy`, so for those 15 seconds dragging any node dragged it
against a graph nailed to the canvas and nothing answered. Ten ticks is a sixth of a second,
which no gesture can land inside.

What is given up is the new paper's own outgoing references — reading its PDF for what *it*
cites needs a build, and the next one finds them. A DOI that resolves to more than one work
still rebuilds, and a paper filed into a collection this graph is not of changes nothing on
screen at all, which is the honest answer for a collection-scoped graph.

Not built: multi-select. When it is, loop **sequentially**, as `lookup.js` does — `doi.org`
throttles, and `Zotero.Translate.Search` retries through the translator list on failure, which
would multiply concurrent requests.

## Part 5a — Caching

`enrich()` takes an optional `config.cache` with `get(key)` / `set(key, metadata)`. It is
injected rather than imported because the only implementation touches `IOUtils`, and importing
it would drag a chrome-only dependency into the host-agnostic tree.

`lib/metadataCache.js` is that implementation, and is deliberately shaped like
`pdfLinkCache.js` — a plain JSON file under `<data dir>/zotero-citation-graph/` — with **one deliberate
difference**. A PDF's link annotations change only when the file does, so those entries carry a
`size:mtime` stamp and never expire. A citation count changes continuously and nothing local
can detect it, so these expire on age instead (30 days).

That TTL is long on purpose. Titles and author lists are immutable in practice, and a count a
month stale is still the right order of magnitude — which is all it is ever used for, since the
graph ranks on the local count and log-scales the global one. Re-fetching 900 identifiers to
move a number from 1,989 to 1,994 would be a poor trade.

Two rules the runner enforces around it:

- **Only complete answers are cached.** An entry with a count but no title is not written, or
  the fill-first chain would skip the enricher that could have completed it.
- **A cache hit is never written back.** Refreshing its own timestamp on every read would make
  the TTL unreachable and the entry immortal.

Measured: a cold two-DOI run is one request and 495 ms; the same run warm is zero requests and
0 ms.

---

## Part 6 — This plugin now uses the network

Until this change the plugin could not reach the network at all: `edges/openalex.js` was
registered but no build ever selected it. That is no longer true, so:

- enrichment is **off by default** (`requiresNetwork: true`, `defaultEnabled: false`), matching
  how `openalex` has always been declared
- it honours the same `offline` switch as edge providers, because it shares the selection logic
- it covers the top `maxEnrich` ghosts by *local* citedBy plus the held items' own DOIs, so a
  large library cannot turn into an unbounded number of requests. It is **not** gated on
  `includeExternal`: with outside refs off there are no ghosts to name, but the held items still
  have DOIs, and their global counts are what the `global citations` size mode reads. Gating it
  meant sizing the graph you actually hold by citation count was unreachable without first
  switching on ten thousand nodes you do not
- the API key is a pref (`extensions.zotero.zoteroCitationGraph.openalex.apiKey`), never hardcoded, and
  travels in a header rather than a query string

---

## Part 7 — `ref:`, the namespace with no identifier

Everything above assumes a ghost *has* an identifier and the only question is what it is
called. `edges/refStrings.js` breaks that assumption, and the consequences are worth writing
down because every one of them follows from the same fact.

The hole it fills: DOIs are printed in 23% of PDFs (Part 2's measurements), hyperlinked in
rather more, and absent altogether from most older and most humanities literature. `title-match`
needs no identifier but **can only find titles the collection already holds** — it searches for
what it has, so an outside work is invisible to it by construction. Between them, the works a
library cites and does not hold, in a field whose publishers print no DOIs, were not merely
unnamed: they were not nodes.

`ref-strings` splits the reference section into entries, parses each into author/year/title, and
resolves it down a ladder — printed DOI, arXiv id, a title the collection holds, and only then a
new node. The node's key is a slug of the cited work's own title.

**Identity is the title and nothing else.** `refSignature` takes the first eight words of
`normTitle`. Not the author: the surname arrives in four orderings (`Smith, J.` / `J. Smith` /
`Smith J` / `Jane Smith`), and OCR damages the accented ones. Not the year: routinely absent, or
belonging to a reprint. Either one in the key fragments a single work into several ghosts far
more often than it separates two works — and a fragmented ghost is not merely duplicated, it is
**hidden**, because `citedBy` is what the min-citations filter reads. A preprint merging with its
published version is the accepted cost.

The same reasoning sets the failure policy: **no title, no node.** An entry that parses to a
fragment is dropped rather than keyed, because fragments collide with each other and would
surface as one enormous ghost that a dozen papers appear to cite.

### Three consequences, each of which had to be built

1. **It has to carry its own name.** No enricher declares `ref`, so `enrich()` will never resolve
   one, and `MAX_ENRICH` must not be spent on them (`ghostKeysOf` filters them out). `build()`
   therefore grew a metadata sink — `ctx.describe(key, meta)` in, `result.described` out — and
   `describeNode()` merges it under the lookup's answer, fill-first, exactly as `enrich()` merges
   two enrichers. The lookup wins per field; the parse fills the rest and is all a `ref:` node
   ever gets.
2. **It has no address.** `externalUrl('ref', …)` returns `null` and "Open in browser" disables
   itself. This retired an invariant the tests had encoded — *every namespace must resolve to a
   URL* — in favour of a sharper one: every namespace must have a **decided** answer, and
   `ghostMenu` already disables on a null rather than opening a 404.
3. **It cannot be added to Zotero.** Adding goes through Zotero's add-by-identifier path
   (Part 5), and a parsed title is not an identifier. The button is disabled, and the ghost card
   shows the parsed venue where a DOI node shows its DOI — printing the slug there would read as
   an identifier the work does not have. Resolving a title to a DOI over the network and handing
   *that* to the existing path is the obvious follow-up; it is one request per add and fails on
   anything OpenAlex does not index, which is why it is not in this change.

### Why the same work does not become two nodes

One paper prints a DOI for a reference and the next does not, so the work is `doi:10.1038/…`
from one and `ref:<slug>` from the other — two ghosts cited once each where the truth is one
cited twice, which the default `cited by ≥ 2` filter then hides entirely.

`consolidateByTitle` folds them, keyed on the same slug function that minted the `ref:` key, so a
work cannot fail to match itself. A held item wins over any ghost, and among ghosts a registered
identifier wins over a slug; a held item is only ever re-keyed *onto*, never re-keyed, because two
papers in a library sharing a title are two papers.

**It works offline**, which is the part worth keeping: `ref-strings` describes the `doi:` nodes it
finds as well as its own, so both sides carry a parsed title before anything touches the network.
`rekeyByDoi` — the equivalent for OpenAlex ghosts — cannot say that, and needs the lookup. The
consolidation runs twice for that reason: once during the build on parsed names alone, and again
after the lookup over whatever OpenAlex resolved.

### What it costs

Its own phase and its own switch, off by default. It is offline and cheap in CPU — splitting is
one pass over the section's lines, parsing is a handful of regexes over ~40 entries per document —
but it is a separate `build()` call, so the `.zotero-ft-cache` files are read a second time,
roughly the 1–2 s the text phase already measures. The `ctx.refSection` memo now keeps the
section's raw text alongside the flattened form, because every signal that separates one entry
from the next is exactly what flattening destroys.

It is switched rather than filtered for a reason no other strategy shares: it is the only one that
adds **nodes**. The strategy list under it filters an already-built graph, which works because
removing a strategy there leaves the same population with fewer edges. Removing this one would
empty the canvas of everything it found.

### The parser's one load-bearing rule

A period is both the field separator and a character that occurs freely inside two fields —
author initials (`Smith, J. D.`) and abbreviated venues (`Inf. Process. Lett.`). A naive
`indexOf('.')` truncates nearly every title in the corpus at its first initial.
`nextSentenceBreak` therefore skips lone capitals, a vocabulary of bibliographic and ISO-4
journal abbreviations, and — because no vocabulary can be complete — any period inside an
*abbreviation run*: a short capitalised token, a period, then another short capitalised token
that is itself followed by a period.

That last rule is shape rather than vocabulary, and it is what separates `Inf. Process. Lett.`
from `…in the Brain. Nature, 500`, where the second token is followed by a comma. The word list
must stay clear of anything that is both a journal and an ordinary English word: `cell` was in it
briefly and truncated *"Nanometre-scale thermometry in a living cell."* at the word the title ends
on. Both cases are pinned by tests.

Where the rule errs it errs long — a venue swallowed into the title — and that is the safe
direction, since the signature reads the first eight words either way: a title with extra tail
still lands on the right node, a truncated one does not.

---

## Part 8 — What real PDFs do, and which of it we can survive

Everything in Part 7 was designed against clean fixtures. Run against a real 485-attachment
library it failed on papers that looked entirely ordinary, and the failures fell into two
groups: bugs, and properties of the source document that no parser can undo. The distinction
matters, because the second group must fail *quietly* — a reference list we cannot read has to
produce nothing, never something invented.

### The bugs (fixed)

**Entries running together on one line.** The single biggest one. `pdftotext` routinely emits a
whole bibliography as one line, or packs several entries onto each line — Acosta 2013 runs them
together mid-line (`… Phys. Today 58, 42 (2005). 2. T.D. Ladd, …`), and Britton 2012's entire
forty-entry list is *one line* of the `.zotero-ft-cache`. The marker pattern was anchored to
`^`, so all three reported papers produced **zero** entries. Markers are now found anywhere, and
what keeps that safe is the ascending-run check: volume, issue and page numbers all look like
markers in isolation, but none of them continues somebody else's count.

**Two whole citation styles unparsed.** Both returned `null` for every entry:

- **Nature/Science** — `Anderson, P. W. The resonating valence bond state … Science 235, 1196 (1987).`
  Its year is parenthesised like APA's but sits at the *end*, so the APA branch read the entire
  entry as an author list. The author block has no closing punctuation, so it is now matched
  positively as a run of `Surname, A. B.` groups.
- **Elsevier numeric** — `[3] L.A. Rosenthal, Thermal response of bridewire …, Rev. Sci. Instrum. 32 (9) (1961) 1033–1036.`
  The title is delimited by **commas**, so no period-based branch could find it. Its end is found
  by working back from where the venue's numbers start — the last comma before the first
  volume-or-year token — because taking the first comma would truncate every title containing
  one, and truncation is the one error the design cannot absorb.

Measured over the whole library — all 485 attachments carrying extracted text, 241 of which
yield entries at all — adding these two took the share of entries yielding a usable identity
from **44% to 57%**: 3,420 to 4,407 of 7,796 entries, +987 works.

| style | docs | entries | with title | yield |
|---|---|---|---|---|
| `elsevier` | 77 | 3402 | 2122 | 62% |
| `generic` | 78 | 1924 | 356 | 19% |
| `nature` | 21 | 1053 | 987 | 94% |
| `apa` | 27 | 677 | 261 | 39% |
| `ieee` | 34 | 621 | 587 | 95% |
| `vancouver` | 4 | 119 | 94 | 79% |
| **total** | **241** | **7796** | **4407** | **57%** |

`elsevier` sits well below `nature` and `ieee` for a structural reason rather than a fixable
one: `ELSEVIER_AUTHORS` matches the compressed **titleless** style too, since the two share an
author shape and differ only in whether a title is present at all. Acosta 2013 is in this bucket
at 8/33. The number is a blend of "parsed well" and "there was nothing to parse", and cannot be
read as parser accuracy. The same reclassification is why `apa` is now 27 documents rather than
the 96 it held before: most of that bucket was Elsevier all along, which is exactly why it was
returning a title for only a third of its entries.

**What this counts, and what it does not.** An entry counts here when a title was *extracted* —
not when the resulting node was correct. A mis-parsed title counts as a success. These are
recall figures for the parser; nothing here measures precision, and `--compare`'s
only-this-strategy-found-it column is still the way to settle that.

**A bibliography with no heading.** Britton 2012 does not contain the word "references"
anywhere, and its list is one line, so the heading search had nothing to find and the
line-counting run saw a run of one. `segment()` now also recognises a single line carrying an
ascending marker run.

### The things we cannot fix, and how they fail

| Paper | What the PDF does | Outcome |
|---|---|---|
| **Acosta 2013** | Compressed numeric style that prints **no article titles at all** — `J.Q. You, F. Nori, Phys. Today 58, 42 (2005).` is the whole reference | 33 entries split correctly; **0 titles**, because there are none. Only its book references (8) yield a node |
| **Feynman 1957** | References are in **footnotes**, there is no reference section | `tail` scope, split declines, **no entries, no ghosts** |
| **Bertet 2001** | Two-column Nature page; the extraction **interleaves the neighbouring article**, whose reference list and headline land inside this one's | Now finds Bertet's *own* list (Bohr, Einstein–Podolsky–Rosen, Scully) — the contamination is bounded, not removed |
| Instrument manuals | Not papers at all; the tail is a laser-safety notice and the AGPL | Rejected outright by the dated-works rule |

Acosta is worth stating plainly because it looks like a bug and is not: **a titleless citation
style cannot yield title-keyed nodes.** The danger there is the opposite one — the field after
the authors is the *journal*, and an eager parser mints "Phys. Today" as a cited work. The
Elsevier branch therefore requires a candidate title to look like one (four words, 25
characters) before it will believe it.

Three guards now carry the "fail quietly" half, each earned from one of these papers:

- a split must be **mostly dated works**, or the section is not a bibliography (the manuals);
- an individual entry must carry a **year**, or it is body text a contaminated scope dragged in
  (Bertet);
- a marker run must **start at 1 or 2** — a `0.` is an equation label or a footnote, and allowing
  it is how a run once anchored itself in a paper's body text (Bertet again).

### These edge cases affect the other strategies too

They always did; `ref-strings` only made them visible, because it is the first strategy that
*reports* on the section rather than quietly scanning it.

`text-doi` and `title-match` both read the very same segmented section (`ctx.refSection`). When
segmentation falls through to `tail`, they are handed the last 40% of the document — body text,
appendices and footnotes included. That is precisely what the feasibility study blamed for
`title-match`'s precision: **under half its uncorroborated edges could be confirmed**.

So the segmentation fix above is not only for this strategy. Measured across the library:

```
segment quality  before                       after
  heading        248                          248
  numbered        32                           57   (+25)
  tail           201                          176   (-25)
  none             4                            4
```

**25 documents gained a real reference-list scope, and 252,000 characters of body text stopped
being searched** by `text-doi` and `title-match`. Every edge those two draw from those documents
is now drawn from the bibliography rather than from the paper, which raises their confidence
scores as well — `title-match` scores `heading`/`numbered` at 0.8/0.75 and `tail` at 0.4.

The two unfixable cases degrade the other strategies in ways nothing here changes: Feynman's
footnote references are invisible to every offline strategy (no section, no DOIs, no titles in a
1957 paper), and Bertet's interleaved neighbour means `title-match` can still match a title the
*adjacent* article cited. Acosta is the starkest: with no titles and no DOIs printed anywhere in
its bibliography, it is invisible to `text-doi`, `title-match` and `ref-strings` alike. For
papers like it, `openalex` references are the only source that will ever work.

## Follow-ups, in the order I would do them

1. **A Crossref enricher**, to fill what OpenAlex misses. The fill-first chain already expects
   it, and it is the first real test of whether the extensibility claim holds.
2. **A preferences pane.** There are now three things to configure — API key, enricher order,
   cache TTL — and Zotero's Config Editor has stopped being an acceptable answer for any of them.
3. **Multi-select add** (Part 5), sequential.
4. **Colour by citations**, now that held items carry a count. Same log scale as the size mode;
   the palette work is the only open question.
5. **`arxiv:` ghosts.** ~~no strategy emits one~~ -- `ref-strings` now does, from arXiv ids
   printed in reference entries, which is `findArxivIds()`'s first caller since it was written.
   Still open: no enricher declares `arxiv`, so those nodes are named only by what the reference
   string itself said.
6. **Resolve a `ref:` node to a DOI** over the network, so it can be added to Zotero through the
   existing path. One request per add, and the first thing to reach for if "Add to Zotero" being
   greyed out on a parsed reference turns out to annoy anyone.
