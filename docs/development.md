# Citation Graph for Zotero

A force-directed, Obsidian-style citation graph for a Zotero collection — or for whichever items
you have selected. Nodes are those items; a directed edge means "A cites B", and a citation
resolving to a paper already in the graph points at that existing node.

Edges are derived **entirely from local data** — no external API. On a real 395-item library the
offline stack produces 276 edges over 161 items; OpenAlex, for comparison, produces 259 over 138.

Targets **Zotero 10–12** (developed against 10.0.1 / Gecko 140 ESR).

An independent plugin, not affiliated with or endorsed by the Corporation for Digital
Scholarship. "Zotero" appears in the name only to say what this works with.

## Status

| Step | | |
|---|---|---|
| 1 | Plugin skeleton loads | confirmed in Zotero |
| 2 | Collection context-menu item | confirmed in Zotero |
| 3 | Tab + content page + renderer | confirmed in Zotero |
| 4 | Real collection metadata | built |
| 5 | Text strategies (`title-match`, `text-doi`) | built |
| 6 | `pdf-links` + per-file caching + progress | built |
| 7 | Directed styling, strategy toggles, click-through | built |
| 8 | Subcollections, colour-by, citekey labels, outside refs | built |
| 9 | Names + citation counts for outside refs (OpenAlex) | confirmed in Zotero |
| 10 | Add outside refs to Zotero; metadata cache; size-by | built |
| 11 | Click-to-pick, Ctrl-click for several, double-click-to-isolate, node context menu | built |
| 12 | Colour by publication; multi-value filter masks with context-sensitive completions | built |
| 13 | ~~Read a node’s PDF in a pane beside the graph~~ | retired in 0.24 — the item pane does this |
| 14 | Isolate several nodes at once, to an adjustable depth | built |
| 15 | Canvas menu; groups — an anchor that pulls whatever a filter names | built |
| 16 | Tags as a facet; a pull slider per group and one for the centre | built |
| 17 | Subfields: bibliographic coupling, Louvain communities, named clusters | confirmed in Zotero |
| 18 | The gap list: what the collection cites and does not hold, ranked | built |
| 19 | One `group pull` for every anchor; the pin drawn as a pin, and a `pin pull` towards pinned nodes | built |
| 20 | A second entry point: the item menu, graphing the selected items | built |

Steps 4–7 are statically verified (`npm test`) but **not yet confirmed against a real collection
in a running Zotero**. The number to check them against is the CLI's: run `tools/cli.js` over the
same items and the edge count should match.

Not yet done: a preferences pane (strategies are toggled in the graph's own control panel, which filters
an already-built graph rather than changing what gets derived), the year-keyed `d3.forceY()` that
would make citations point backwards in time, FlateDecode for the ~13% of PDF DOI links that live
in compressed streams, and any use of the `openalex` *edge* strategy — it is registered but no
build selects it.

**The plugin can now reach the network, in exactly one place**: the "query node metadata" panel
toggle, off by default, which resolves outside references through OpenAlex. Nothing else makes a
request. See [`external-references.md`](external-references.md).

## Outside references ("ghost" nodes)

With **outside refs** on — it is off by default, because ghosts outnumber held items by an order
of magnitude and a first look at a collection should be the papers you actually have — a cited
work the collection does *not* hold gets its own node, keyed `doi:<doi>`. Two consequences worth
knowing before reading the graph:

- **Only the DOI strategies can produce them.** `title-match` searches the reference text for
  titles it already holds, so a reference to something outside the collection is invisible to it
  by construction. That is a property of the strategy, not a bug.
- **Offline they are labelled by DOI and nothing else**, because offline there is no metadata
  behind a harvested DOI. Switching on **query node metadata** resolves the top 500 (by local citation
  count) through OpenAlex, after which they carry the same `Surname2013` citekey label as a real
  node, plus a title, authors and a global citation count in the tooltip. It is one batched
  request per 50 DOIs, works without an API key, and is the only network access the plugin makes.

There are a lot of them, and the long tail is noise. Measured library-wide:

| cited by | outside works |
|---|---|
| 1 | 3172 |
| 2 | 396 |
| 3 | 121 |
| 4 | 35 |
| 5+ | 47 |

Hence the **cited by ≥** control, default 2.

**Show details** on an outside ref's context menu opens a popover with its title, authors, both
citation counts and its DOI, and an **Add to Zotero** button. That asks where the paper should go
— a tag and a collection — and then takes Zotero's own add-by-identifier path, fetching an
open-access PDF if there is one. The ghost becomes a real node **in place**: nothing is re-derived
and nothing on screen moves, because nothing about the derivation changed — the same papers cite
the same work, which merely stopped being a ghost. Adding is behind a button rather than the act
of opening the card, because it writes to your library.

## Sizing

The **size** dropdown picks what node area means, for held items and outside refs alike:

- **cited here** (default) — in-degree, how many papers *in this collection* cite it. This is the
  question the graph exists to answer, and a gap in the library shows up here and nowhere else.
- **global citations** — how often the whole literature cites it. The counts come from **look up
  names**, so picking this switches that on and rebuilds rather than sitting there greyed out —
  you asked for the sizing, not for a lecture about its prerequisite. (The lookup is still never
  entered on its own, and switching it back off returns sizing to **cited here**.) Node *area* is
  proportional to the count up to the 95th percentile of what is on screen, and logarithmic above
  it. Anything with no resolved count stays a fixed small dot, so "not looked up" never reads as
  "never cited".

The percentile, rather than the maximum, is what keeps this readable: citation counts are
heavy-tailed, and normalising on one 41,000-citation landmark renders everything else as
identical specks. The curve lives in `content/nodeScale.js`, separate from the renderer because
it is pure and therefore testable — the first version drew a 4,000-citation paper the same size
as a 100-citation one, and only an eye caught it.

The two answer different questions and are deliberately never mixed into one number — a famous
paper you do not hold is not a gap in your library, it is merely famous.
`docs/external-references.md` part 4 has the argument in full. The head of that list is the interesting part — a
work twenty of your papers cite and you do not have is a gap in the library, which is the reason
to compute this at all.

Cross-check any of it with `node tools/cli.js … --offline --include-external`.

## Subfields

Colour by **subfield** and the graph stops reporting who cites whom and starts reporting what the
collection is made of. The partition comes from **bibliographic coupling** — how much of the
literature two papers point at in common — clustered with Louvain and named from its own members'
titles.

Coupling rather than the citation edges, because those two questions are not the same one. In a
library built from local PDFs most items cite each other rarely or not at all, so a partition of
the citation graph would mostly report which items happened to have a readable reference list.
Coupling works precisely where the citation graph is thin: a shared reference counts whether or
not the work referenced is one you hold, so **outside references are the useful half of it**. Two
papers leaning on the same three classics you do not own are doing the same kind of work, and
nothing in the citation graph proper says so. Switching **outside refs** on is not required —
the coupling reads the same edges either way — but the graph then shows you what the partition
was built from.

Three decisions shape what you see:

- **Salton cosine, not a raw count of shared references.** Without it a paper with a sixty-entry
  bibliography couples to everything for being long-winded, and ends up the centre of every
  cluster it appears in.
- **A reference more than half the collection cites is background, and couples nobody.** Every
  field has a handful of works everyone cites; pairing up their citers would fuse the library
  into one blob and drown the specific agreements that actually mark a subfield.
- **A direct citation adds half a unit** on top of whatever coupling a pair already has. Coupling
  is blind to it — A citing B does not make A and B share a reference — so on its own the measure
  would separate a paper from the very work it builds on.

It is computed over the **whole collection**, not over what the filters have left on screen: a
subfield is a property of a paper's place in the library, so masking down to one author must not
re-partition and recolour the survivors. It does honour the confidence slider and the strategy
toggles, because those change which edges are believed at all. A paper that shares no reference
with anything else is left **`(no subfield)`** rather than filed somewhere — placing it would be
the graph inventing a claim about it.

A cluster is named after the terms its members agree on, scored by share-of-cluster × idf, with a
phrase beating its own words when both say the same thing (`error correction`, not `correction`).
That name is also what keeps the colours stable: the palette hashes the label, so a cluster that
is still about the same thing keeps its colour however the partition was numbered this time.
`subfield` is a filter facet like any other, so `cluster:"error correction / surface code"` masks
the graph down to one of them, and a group anchor can pull one into a corner of the canvas.

**How much to trust it**: hover the legend's header. It carries the cluster count and the
partition's modularity, and under about 0.3 the split is more the algorithm than the library.

The maths is `content/graphCluster.js` — pure, no DOM, and unit-tested against fixtures whose
answer is known, for the same reason `nodeScale.js` is: a wrong partition is tedious to spot by
looking at a coloured graph. See the whole thing over a real library with
`node tools/cli.js … --offline --include-external --clusters`.

## What's missing

Right-click the canvas and pick **what is missing** for a ranked list of the works your papers
cite and the library does not hold. It opens in the right-hand pane, in place of the item pane,
and it is the same data the ghosts are drawn from — put in the one shape the canvas cannot
manage, because on screen the interesting ones sit somewhere in a cloud of several thousand.

**One panel, one occupant**, which is the same bargain the retired PDF pane struck: the list
takes over the pane rather than floating over the graph, and clicking a node hands it back to
the paper. It is a third page of the deck `<item-details>` already shares with the note editor,
so the sidenav's icons grey out while it is up for free — core's own rule, and the right one
here, since a live Abstract button over a list of works the library does not have would be
offering to scroll to a section that is not on screen.

**The ranking stays in the content page and the drawing does not.** Ranking reads the believed
edges, the outside works, the cluster partition and the lookup checkbox, none of which chrome
has; drawing needs a XUL deck the content page cannot reach. So the page ranks and pushes rows,
`lib/gapsPane.js` draws them, and the clicks come back the other way. Which page of the deck is
up is chrome's fact and chrome says so — the canvas menu reads it to decide whether it is
offering to open the list or to put it away, and a page that remembered its own answer would be
wrong every time a node click turned the deck away.

**The ranking is not the raw count.** Two numbers decide the order and they are not the same
number: `citedBy`, how many papers *here* cite it, and `citedByGlobal`, how often the whole
literature does. Sorting on the first alone puts the field's landmarks on top, which is the one
answer nobody needs — you already know about the 41,000-citation paper, and not holding it is a
decision rather than an oversight. The list divides the local count by `log10(10 + global)`, which
asks the better question: how hard is this library leaning on it, for how well known it is. A work
four of your papers cite that the literature has cited ninety times outranks one five of them cite
that the world has cited forty-one thousand times — and the discount never cancels the count
outright, so twelve citers still win whatever the fame.

With **query node metadata** off there is no fame to divide out, every gap is taken at face value, and
the list is plainly "most cited here". That is the honest answer to the question asked without the
counts, and the card's footer says so.

A caption under the card's title says what the leading number counts, because the first reading
of a bare `12` beside a work you do not hold is "I cited this twelve times" — which is not a fact
this list has, and it turns a list of gaps into a list of your own citations.

Each row carries the local count, the title (or the bare DOI, offline), the authors, the global
count, and **which subfield is doing the citing** — from the same partition the graph colours by.
A cluster is named only when it holds a strict majority of the citers, counting the ones no
subfield could be found for: an even split has no owner, and naming one of the halves would be
reporting a tie-break as a finding. So a row reads either *"seven papers of your error-correction
cluster lean on this"* or *"across three subfields"*, and those are genuinely different kinds of
gap.

- **A row carries the canvas's own four gestures**, over the one node it stands for: the ghost for
  the work the library does not hold. **Click** picks it out, **double click** isolates it, and
  **Ctrl** (Cmd on a Mac) on either adds to what is already picked or already lit rather than
  starting again. They are literally the node's four functions, called from the list instead of
  from the canvas — see the table under *Interacting with a node*.
  A row does **not** light the papers that cite it. Those are the ghost's own neighbours, and
  isolating is already the gesture that lights a neighbourhood — at whatever depth the reader set,
  which a list reaching past the node to grab its citers would silently overrule. A ghost a filter
  has taken off screen cannot be picked, and the row says so on the status line rather than doing
  nothing quietly.
- **Marks run in both directions**, because there is one selection and both ends are drawn from
  it: a row clicked lights its ghost on the canvas, and a ghost clicked on the canvas lights its
  row in the list. The page owns that — it holds the pick, a row is marked when its key is in it,
  and a filter that takes a ghost off screen drops it with no click made at all — so the page
  pushes `gaps-lit` and chrome only paints it, scrolling to a mark that has just appeared.
- **Nothing a selection does closes the list.** The list is a *pinned* page of the pane's deck
  (`pane.pinned`, honoured in `itemPane.face()`): every gesture made while reading it moves the
  selection — a row picks its ghost, the same ghost clicked on the canvas picks it from the other
  end, empty canvas clears the pick, a rebuild restates the count — and unpinned, each of those
  would put the list away, so you would get one gesture per opening. The selection is drawn on the
  page *behind* it instead, and closing the list is what brings that up. Escape still takes the
  layers off one press at a time, the list last.
- **The `+`** adds the work to Zotero through the same add-by-identifier path the ghost's own menu
  uses, so it needs a DOI and is disabled without one, and it asks the same two questions first.
  The work is then held and the row leaves the list by itself; cancel, and the row comes
  straight back.

Opening the card switches **outside refs** on and rebuilds if they were off — the build derives
outside references only when asked, and opening the list *is* the asking, the same bargain **size
by global citations** strikes with the lookup. Works cited by only one of your papers are left out:
3,172 of the sample library's outside works are cited exactly once, and a lone harvested DOI is as
likely to be a licence URL as a reference.

The ranking is `content/graphGaps.js`, pure and unit-tested like the rest. Over a real library:
`node tools/cli.js … --enrich --gaps`.

## Graphing a selection

**View Citation Graph** is on two context menus. On the collection tree it graphs a collection, as
it always has. On the item tree it graphs **the items you have selected** and nothing else — which
is the other unit anyone asks this question about. A collection is the shelf; a selection is the
handful you pulled off it, and "what do these few cite in common" had no way to be asked before
except by building a collection and then filtering it back down.

**The pick is frozen when the tab opens.** Clicking around the library afterwards never moves a
graph you are reading, which is the same bargain a collection graph strikes with the collection
tree. **Rebuild** re-derives the edges over the same papers — it re-reads their PDFs and text, but
it cannot grow the set the way rebuilding a collection picks up a paper filed since. Its tooltip
says "these items" for that reason.

**What the menu will act on** is the selection reduced to what a citation graph can draw
(`graphableKeys()` in `lib/main.js`):

- a child row — an attachment or a note under an expanded item — stands for its **parent**, the rule
  Locate already goes by, and a paper reached twice that way is one node;
- anything in the **trash** is left out, as a collection's own `getChildItems(false, false)`
  leaves it out;
- anything still not a **regular item** after that (a standalone note, an annotation) is left out;
- over a **feed**, the entry does not appear at all — feed items are not library items.

With nothing left, the entry hides itself rather than opening a tab onto an empty canvas. **One
item is enough**: a graph of one paper opens with **outside refs** on, because one dot with no
edges reads as a failed build, whereas "what does this cite" is the honest question to ask of a
single paper. The page holds the other half of that bargain: **cited by ≥** counts how many papers
*here* cite an outside work, so it can never exceed the number of papers held, and at the default of
2 a graph of one would hide every ghost it has. The first payload that says how many papers are held
clamps it to fit — once, and never again, since a number the reader has moved since is theirs
(`applyScope()` in `content/graph.js`).

**Rows can still be lost on the way in.** `itemRecord()` declines an item with no title, so ten
selected rows can become seven nodes. When the two numbers differ the stats line says so —
*7 of 10 selected* — and when every row came to nothing, the empty card says why in words that
fit a selection rather than a collection.

### What a selection graph is anchored to

A collection graph answers a handful of questions from its collection: *which collection is open*,
*which library*, *can this be edited*, *where does Add to Zotero file a paper*. A selection has no
collection of its own, so it keeps an **anchor** when it can:

| selection made in | nodes | the questions above are answered by |
|---|---|---|
| a collection | the pick | that collection — files land beside the papers they came from |
| My Library, a saved search, a tag view, unfiled items | the pick | the **library** |

Both halves live on one `scope` object in `lib/graphTab.js` — `{ kind, libraryID, collection,
itemKeys }` — which replaced the bare `Zotero.Collection` everything downstream used to be handed.
`collection` is null only for a selection made outside a collection; `itemKeys` is null only for a
collection graph.

The library fallback in `lib/tabContext.js` matters more than it looks. Without it the wrappers
would hand back core's answer, and core's answer is the library tab's collection tree reading
whatever it read when the graph opened — the very bug that module exists to fix. It builds a
`CollectionTreeRow` of type `library` or `group` over `Zotero.Libraries.get()`, whose
`editable` getter reads a group's own permission, so a read-only group stays read-only.
`getSelectedCollections()` answers `[]` rather than falling through, which is core's own reading
of "the library root" for *Add to Collection → New Collection*.

### Which controls apply

Only one control has no meaning over a selection: **Subcollections**. A pick of items has no
subtree, so the switch is hidden rather than left doing nothing, and the empty card never offers
*Include subcollections*. Everything else — outside refs, the lookup, OpenAlex references, the
strategy toggles, confidence, the physics, isolation, groups, search, the item pane, *what is
missing* — is scope-blind and applies unchanged. The `zg.*` settings in `localStorage` were
always facts about the screen rather than about a collection, so they carry across too.

**Colour by collection** reads better than before. Over a collection it means "which in-scope
subcollection"; over a selection it means **every collection in the library that holds the
paper**, which is the useful answer for a pick that spans several shelves.

A few strings used to say "collection" where they now mean "this graph", and were reworded so
both readings stay true: the outside-refs hint, the ghost tooltip, the rebuild hint and the gap
list's "still reading".

### Adding a paper from a selection graph

A work added from a selection graph — the ghost's menu, its card, or the `+` in *what is
missing* — **joins the graph**: its key goes into the pick and the ghost is adopted in place, with
nothing re-derived and nothing on screen moving. That differs from a collection graph on purpose.
There, a paper filed into some other collection is outside the graph by definition; here, adding
from the graph is an explicit act about this graph, and the pick is the only thing that could
hold it. `scopeNames()` answers `[]` rather than `null` for such a paper when it is on no shelf at
all, because an empty list is still a yes.

### Across a restart

The keys go into `session.json` with the rest of `tab.data`. On restore they are read back
through `Zotero.Items`, and a key whose item has since been deleted is **dropped** — the tab comes
back one paper smaller, and the shortened list is what the next save writes. Only when every
paper is gone is the tab dropped, the same answer a deleted collection gets. An anchor collection
deleted in the meantime costs a selection nothing but the anchor: the library answers instead.

A tab written before this existed has no `itemKeys`, which is exactly what "a collection graph"
reads as, so old sessions restore unchanged with no migration.

The tab is titled by its count — *Reading list · 7 items — Citation Graph*, or *7 items — Citation
Graph* with no anchor — because two selection tabs in the strip are otherwise told apart by
nothing. The count is the one the build found, so it is restated once phase 1 knows it.

### Where the entry lands

MenuManager puts every plugin's entries after a separator at the foot of the popup, and folds the
overflow into a submenu once the popup would run past 80% of the screen (`_groupMenus`,
`_computeAvailableMenuNum` in core's `menuManager.js`). The item menu is long, so this entry will
not sit where the collection entry does, and may end up one level down. The icon is what carries
it.

There is no cap on the size of a selection. Ctrl+A on a large library costs the same build a
collection that size already costs, the keys are about ten bytes each in `session.json`, and the
outside-reference payload is capped at `MAX_EXTERNAL_NODES` regardless. A graph silently
truncated to some limit would be worse than a slow one.

## Install for development

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-dev.ps1
```

This writes a *pointer file* into the Zotero profile's `extensions/` directory — a file whose name
is the addon ID and whose first line is the absolute path to `addon/`. It must be UTF-8 **without a
BOM**; the script handles that. If the plugin does not appear after a restart, check whether the
pointer file still exists — Zotero silently deletes pointer files it cannot parse, so its
disappearance is the diagnostic.

Then launch Zotero with debug output on stdout:

```powershell
& "C:\Program Files\Zotero\zotero.exe" -ZoteroDebugText -purgecaches | Out-Host
```

`| Out-Host` matters: `zotero.exe` is a GUI-subsystem binary, so `-ZoteroDebugText` only becomes
visible when stdout is redirected. In-app, **Tools → Developer → Run JavaScript** is the fastest
iteration surface (`Zotero.ZoteroCitationGraph` is live there).

Iterating: edit files under `addon/`, restart Zotero. No rebuild, no version bump, no re-copy —
`bootstrap.js` and every module loaded through `lib/cjs.js` use `ignoreCache: true`.

Remove with `tools\uninstall-dev.ps1`.

## Build

```
npm run verify   # version gate, then the test suite
npm run build    # writes dist/zotero-citation-graph-<version>.xpi
```

The packer is plain Node with no dependencies, so it runs the same on Windows, macOS and Linux.
It refuses to build when `package.json` and `addon/manifest.json` disagree about the version, and
it fixes every entry's timestamp, which makes the XPI byte-identical across runs of the same
source — so a hash is enough to tie an artifact to a commit.

`node tools/verify-xpi.js` reads a built XPI back through its own zip parser, rather than trusting
the one that wrote it, and checks what Zotero cares about: `manifest.json` and `bootstrap.js` at
the archive root, every CRC intact, the Node-only `citation-graph/adapters/` left out, and the
third-party notices present.

## The frame

The tab has the shape of Zotero's own library tab: a bar across the top, and under it a side
pane beside the thing the tab is of. Where the library puts *New Collection* this puts **Toggle
Sidebar** — the reader's own icon, `20/universal/sidebar.svg` — and where it puts the collection
tree this puts the **settings**, with the **legend** among them, as the section directly under
the colour control whose sentence it finishes. The **reframe** button sits beside the toggle; the **search** field sits where the
library's does, on the right.

The controls used to float over the canvas, and the argument for it is written into the markup
they came out of: the graph is the point of the window, and a wrapping toolbar on a narrow Zotero
pane ate several lines of it. What that cost was that the controls floated over *nodes* — the
four corners of the picture were never quite yours — and the tab looked like nothing else in the
application, which for a plugin that goes to the length of borrowing core's actual
`<item-details>` is an odd place to stop. A pane takes its width from the graph honestly and
gives the rest back whole.

**It is built in the content page, and that is not the obvious choice.** The graph runs at a
`resource://` URL with an ordinary content principal: `chrome://` is unreachable, XUL custom
elements cannot be instantiated, and none of Zotero's stylesheets apply — so `<toolbarbutton>`
and `<search-textbox>` are out of reach, the latter twice over, since it is a Mozilla toolkit
element that Zotero only skins. Building the frame in chrome instead would have meant moving the
settings and the legend across the privilege boundary with it: the `filterBox()` factory, its
chips, its context-sensitive completion list, the strategy toggles and `renderLegend()`, all
rebuilt in a document that cannot see the graph state every one of them reads. So the rule is
**replicate, do not instantiate** — the same bargain `content/icons.js` already strikes for the
menu icons, with the licence note already written for it.

What is copied is named where it appears. The colours are Zotero's own tokens, and the file worth
taking them from is not `zotero.css` but `resource/reader/reader.css`: the PDF reader is itself a
plain HTML document that cannot reach `chrome://` either, so it has already re-declared the whole
token set for exactly this situation and already translated the XUL `toolbarbutton` rules into
HTML. The 41px bar, the 28px buttons with their 5px radius and their `--fill-quinary` hover, the
sidebar's `--material-sidepane` and its divider, the search field's radius and its two-branch
focus ring — each is core's rule with the selector changed.

**Three things the page cannot work out for itself** are pushed over the bridge as
`zgSetChrome`, beside the strings. Zotero's *View → Color Scheme* forces light or dark regardless
of the OS, and a content document's `matchMedia` only ever reports the OS — but the *main
window's* does reflect the override, which is what makes reading it in chrome the whole of the
answer. The font size and the interface density are prefs, which is to say chrome as well. Core
pushes all three onto documents it owns through `Zotero.UIProperties.registerRoot()`, which
cannot cross the boundary, so `graphTab.js` reads the same values and hands them over and the
page sets the same three things. The attribute it stamps is core's own name, `data-color-scheme`,
and so is the three-way CSS that selects it: a bare `:root`, a media query guarded
`:not([data-color-scheme])`, then the attribute. The guard is load-bearing — without it an OS set
to dark beats a window explicitly told to be light, and forcing a scheme works one way only — and
it fails silently, so `npm test` holds it.

**The sidebar's width is dragged, not split.** There is no `<splitter>` in an HTML document,
which is exactly why the reader carries a resizer of its own; this does the same with pointer
events, clamped between core's own 200px collections-pane floor and 420px, and remembers the
width and the open state in `localStorage` beside the collapse, pull and depth keys — all of
them facts about this screen rather than about this collection. The canvas is re-measured on
every change, because `force-graph` is told its size in pixels rather than reading it, and a grid
column changing under it is not something the window's `resize` event fires for.

### Autobuild

The panel's foot carries two things now: **Rebuild**, and an **Autobuild** switch beside it. With
the switch on — which is the default, and what the panel has always done — every control that
cannot be filtered into existence rebuilds the moment it is changed. With it off nothing is
derived again until Rebuild is pressed. The controls still move and still record what the next
build should use; the graph on screen stays exactly as it was, and the button takes core's accent
to say the two have parted. On a library whose builds run to minutes, ticking three strategies
used to be three builds.

**The line it draws is control versus button.** A checkbox or a menu *states* something, and
those go through `requestRebuild()` / `requestLookup()`, which is where the switch is read —
the scope boxes, and the sizing menu that turns the lookup on because it has no counts to size
by. A button is someone asking for the thing *now*, so Rebuild, *what is missing* and the empty
card's *include subcollections* call `rebuildNow()` and build regardless. Gating those would
open an empty card beside a lit button, which is the feature not working rather than the feature
waiting. `npm test` holds the line, because a new checkbox wired straight to `rebuildNow()`
would rebuild under someone who had switched exactly that off, and nothing on screen would say
which control did it.

**Pending is derived, not latched.** `syncPending()` compares the controls against the options
the last payload came stamped with — chrome sends them on every push — so a switch flicked on and
off again leaves nothing pending, and the state clears itself the moment a build that used those
options lands, with no separate signal saying so. The one thing that follows from it: while the
panel is ahead of the graph, `zgSetData` stops copying `options` back onto the controls.
Payloads arrive without a rebuild — a lookup, a paper adopted into the graph — and each carries
the options *that* build was made with, which would quietly untick what the user had just asked
for.

The switch is remembered in `localStorage` as `zg.autobuild`, beside the pull, depth and
collapse keys, and for the same reason: how long your builds run and how many options you change
at once is a fact about how you work, not about any one collection. Turning it back **on** while
something is pending builds at once — it is a request to be up to date.

## Reading the graph

**Labels sit on the node**, not under it, so a circle and its `Surname2013`
citekey read as one object — captions hanging below turn a dense graph into a
field of text whose ownership you have to guess. The type grows with the node's
radius on screen, between a 13px floor and a 28px ceiling, and shrinks to fit
the circle where it can; on a small node it simply overhangs, and the halo
stroke keeps it readable over the edges underneath.

**The legend, directly under the colour and size controls**, is headed `Coloured by <mode>` — the
sentence the panel's colour control just made — and says what those colours mean: a labelled
gradient for `year`, one swatch per key for `collection`, `subfield`, `first author`,
`publication` and `item type` — commonest first, capped at twelve with a `+N more` line — plus a
`no date` entry when the ramp cannot place a node, and `outside refs` whenever
ghosts are on screen. It is rebuilt on every render, so it only ever lists
colours actually visible after the filters, and it collapses to its header
independently of the settings around it — a key for a colouring you have settled on is worth
putting away without putting the controls away with it.

**The reframe button, in the top bar**, zooms and centres the view on the
bounding box of every node currently drawn, with a margin. It is the way back
from a lost viewport, and there is no other one: the layout wanders as later
build phases add edges, a rebuild can land a graph far outside the zoom the last
one was read at, and dragging a node pans nothing. The margin is a tenth of the
smaller viewport dimension, capped at 40px — the graph runs in a narrow Zotero
pane as well as a full tab, and a fixed 40px a side would there be a third of
the window spent on nothing.

**The search field, on the right of the bar**, finds a paper and goes to it. It is
deliberately *not* a second filter: the sidebar's chips already narrow the graph, and typing
the same thing into two boxes to mean two different things would be a trap. What had no answer
until it existed is the other question — *where in here is the paper I am thinking of* — because
a force-directed layout puts a known paper somewhere you have to hunt for and gives you no order
to hunt along. Typing offers up to ten of the papers currently drawn, matched with the same
grammar and over the same facets a bare filter term uses, so a surname, a journal and half a
title all work without your having to say which is which. Picking one does the three things a
click on the node itself does — centres it, rings it, and describes it in the item pane —
because it *is* that gesture, arrived at from a list instead of from the canvas. The zoom is
left alone: someone reading a dense cluster at one magnification did not ask to be pulled out
of it.

## The layout sliders

Seven controls change nothing about *what* is on screen — no node and no edge
enters or leaves. They live in **Graph Physics**, the one pane in the sidebar with
sections inside it: **Force Adjustment** decides where a node is going, **Energy**
how much movement there is to get there with and when it runs out. Two questions
read together and answered at different moments — the forces when the shape is
wrong, the energies when the motion is — which is the argument for one pane with a
seam in it over either a single list of seven sliders or two panes to be found
separately. The nesting needs no machinery of its own: a section is a header that
toggles a body, remembered by name, and that is as true one level down.

**`edge pull`** scales how hard every citation link draws its two ends together.
d3 gives a link a strength of `1 / min(deg a, deg b)`, which is tuned for sparse
graphs; a densely cited collection packs into tight balls, because every edge
pulls at full strength while charge repulsion falls off with distance. Turning it
down trades cohesion for room, and is what an over-packed graph needs before it
can be read at all. At 0 the links hold nothing and the layout is left to
repulsion and the centre pull.

**`centre pull`** scales the force that draws every node towards the origin.
force-graph's own centring force only translates the whole cloud so its centroid
sits at 0,0 — it exerts nothing on an individual node, so a paper nothing cites
feels only charge repulsion, which is purely outward, and drifts away forever.
Stopping that is what this force was added for. Connected nodes get a light pull
(their links already hold them, and a hard one would crush the layout into a
disc) and unconnected ones a pull several times firmer, which parks them in a
ring at the edge of the graph instead of off screen; the slider scales both
together, so the ratio that keeps orphans in that ring is not something it can
get wrong. At 0 they drift off again, which is the honest answer to asking for no
centre pull; turned up, the whole graph gathers into a tighter disc.

**`group pull`** scales how hard every group anchor pulls the papers its masks
name — see *Groups* below for what an anchor is. It sat on each flag's own card
once, one answer per anchor. That sounded like the finer control and read as the
coarser one: "how hard does a group pull" is a question about how you want to
look at the graph, not about this flag, and a graph with four flags had four
answers to it, none of them anywhere near the two sliders above. At 0 every
anchor names its papers and moves none of them.

**`pin pull`** raises the edge attraction of the links that touch a pinned node,
and is **off by default**. A pin holds the one node it is on, which is the honest
minimum and is what this slider at 0 still means. But it leaves the gesture
weaker than it looks: drag a landmark paper to the edge, pin it, and the works
citing it stay wherever the rest of the layout had already put them, because
their links to it pull no harder than any other. Turned up, those links pull as
much as five times harder — and since the node at one end cannot move, the papers
at the other come to it. Nothing that neither cites nor is cited by the pin is
touched at all, which is the point: it says *gather this paper's literature
here*, not *collect the graph at this spot*.

It was a positional force once — an attraction towards the nearest pin — and that
was wrong twice over. It moved every node in the graph whether it had anything to
do with a pin or not, and the pile it made then had to be resolved by the
hard-sphere collision, which threw the graph apart: turning the slider up sent
everything *away* from the pin. Edge attraction has no such failure mode, because
it only asks more of a spring that was already there.

**`drag energy`** is how much of the graph a drag sets moving, as a fraction of
what force-graph does by itself. force-graph drags by holding the layout's alpha
*target* at 0.3 — a third of a cold start — for the whole gesture. Alpha converges
on a target and stays there, so this is not a push the layout spends and recovers
from: it is a tap left running, every force acting on every node on every tick for
as long as the pointer is down. That is why dragging one paper across a settled
graph churns the entire picture, and it is why the stopping threshold below cannot
answer it — a threshold says when motion *ends*, and this is what keeps refilling
it.

The tap is out of reach. force-graph re-exports `d3AlphaMin`, `d3AlphaDecay` and
`d3VelocityDecay` from the simulation but not the alpha target, and its drag
handler sets that from the inside, on every drag event. What is in reach is the
other half of how far a force actually moves a node: the velocity decay, how much
of its accumulated velocity a node keeps from one tick to the next. Damping that
for the length of the gesture leaves the forces exactly where they are and takes
the travel out of them — which is also the more honest reading of what is being
asked. Not *cool the layout down* but *hold the rest of the graph still while I
move this one*. A node keeps `1 - d` of its velocity per tick and so settles at a
speed of `(1 - d) / d` under a sustained force, which is why the far end of the
slider is `d = 1` exactly: there the velocity is spent every tick and nothing but
the carried node travels. The carried node is never affected, because a drag
writes its coordinates directly rather than pushing it with a force.

The drop is scaled by the same number, through `settle()` — a drag that stirred
nothing should not let go like one that did. At 1 that is a release into 0.3,
which is what a drop always was; at 0 it is a release into nothing, and the node
stays exactly where it was put.

Measured on 1,500 nodes, as far-field pixels changing per frame during a sustained
drag — everything more than 110px from the pointer, so the carried node and what
it shoulders aside are excluded — and again after the drop:

| `drag energy` | during the drag | 3s after the drop | 8s after |
|---|---|---|---|
| 1 (force-graph's own) | 193,600 | 161,800 | 38,100 |
| 0.5 | 118,800 | 146,900 | 24,300 |
| 0.2 (default) | 65,700 | 77,100 | 0 |
| 0.1 | 42,300 | 50,000 | 0 |
| 0 | 4 | 0 | 0 |

**`keep moving`** is the tap, and the one control here that adds motion rather
than rationing it. Dragging a node is the only gesture in the page that holds
alpha above zero — force-graph pins the alpha *target* at 0.3 for as long as the
button is down — which is why a graph goes on arranging itself while a node is
held and stops being rearranged the moment it is let go. Wanting that without the
mouse is not a threshold question at all, which is what `stop at energy` got
wrong: a threshold decides when motion *ends*, and what keeps it going is a tap.

The target is out of reach, but the line that reads it is not:

```js
i += (u - i) * a;        // alpha += (alphaTarget - alpha) * alphaDecay
l.forEach(t => t(i));    // every force is called with alpha
c.x += c.vx *= s;        // then positions integrate
```

At `a = 0` that whole term is zero whatever the target, so alpha stops moving and
stays exactly where it stands. Bring it to the level asked for, pin `d3AlphaDecay`
at 0, lift the floor and the clock, and the layout simmers there until it is
turned off. `d3AlphaDecay` is one of the props force-graph does re-export.

Holding alpha means knowing where it is, and the same line gives that too: d3
hands the live alpha to every registered force on every tick, so the centre pull
notes it on the way past and the tick hook reads it one tick later. Nothing is
sampled or estimated — it is the number the engine just used. Above the level, the
decay that lands on it next tick is `1 - level/alpha`, so a graph reheated to 1 by
a slider comes back down to the simmer in a single tick rather than riding alpha 1
for the rest of the session. At the level, decay 0. Below it — a graph already
cooled when the hold was switched on — alpha cannot be raised from out here at
all, so it borrows the shed: freeze the picture, reheat behind it, spend back down
over a few invisible ticks. While a node is carried the decay is pinned at 0 and
nothing else is done, so a held graph drags at the energy it is held at.

Measured on 1,500 nodes with the mouse untouched, as pixels changing over 600ms:
at rest with the hold off, 0. Switched to 0.05: 236,000 at three seconds, 231,400
at ten, 207,700 at twenty-two, 201,400 at forty-three — a layout still working,
not one coasting to a stop. Switched back off: 0 within ten seconds.

It overrules `stop at energy` while it is on, which is the only sensible reading
of the two together: a floor to stop under is meaningless on a layout that is not
allowed to stop.

**`stop at energy`** is the odd one out: not a force, but the floor the layout
stops at. d3 cools a running layout by a fixed fraction per tick, and force-graph
stops it once that energy falls below `d3AlphaMin` — which force-graph itself
ships at 0, meaning *never*, leaving `cooldownTime` as the only thing that ever
ended a layout. A floor was added for a settled graph that had come to rest with
seconds of its fifteen still to run; this exposes it, because how long a graph
should go on rearranging itself is a judgement about the graph in front of you.

The scale is logarithmic, because alpha is. Position `p` is `10^(p - 4)`, so each
step along the slider is a fixed number of ticks sooner or later rather than a
fixed amount of energy — which is what keeps the left half of the slider from
being all *never* and the right half all *at once*. 1 is d3's own 0.001 and the
default; 3 is 0.1, a stop within a second of a drop, before every node has found
its place. Position 0 is the other end: no floor, and `cooldownTime` lifted to
`Infinity` with it, so nothing cuts the layout off. Note what that does and does
not mean — d3 still cools towards a stationary graph, so *never* buys a layout
that is never *stopped*, not one that moves forever.

Two things give way to it. The collision force holds the engine open while
circles are still being pulled apart (see *Performance* below), and a floor above
d3's own now overrules that hold: asked to stop early, the layout stops, overlaps
and all — which is what asking means, and is what kept a dropped node's
neighbours shuffling on a dense graph. A node being dragged overrules the floor
in the other direction, dropping it to 0 for as long as the node is carried:
force-graph's drag raises the alpha *target*, which alpha climbs towards a tick
at a time, and it tests the floor before it ticks — so a layout that had come to
rest was stopped again on the very frame the drag restarted it, and the node
moved with not one neighbour answering.

All seven are remembered across windows, like `isolation depth`: they are settings
about this screen rather than about this graph. None reaches the simulation
through a rebuild — `edge pull` and `pin pull` both reinstall the link force's
strength function, since d3 evaluates those once and caches them, `centre pull` is
read live on every tick, and `group pull` goes through the pass that recomputes
each anchored node's target — so all four only have to reheat a cooled layout to
take effect. Pinning and unpinning reinstall the link strengths too, but only
while `pin pull` is up: at 0 a pin changes no price, and a settled graph should
stay settled. `drag energy` is read live by the drag that is happening, so a slider moved
mid-gesture is answered on the next drag event; `keep moving` is read by the
engine's own tick hook; `stop at energy` reaches the engine without a reheat at
all: nothing
about where the nodes are going has changed, so a running layout meets the new
floor on its next tick and a stopped one on the next thing that moves it.

## Filters

Under the colour and size selects sits a filter box. Type into it and a list of
completions drops down; pick one and it becomes a **chip** above the box.

The grammar is two rules:

```
publication: Nature, Nature Reviews, APL     one mask, three ways to pass it
+ author: Kucsko                             a second mask over the first
```

**Values inside a chip OR; chips AND.** Widening happens inside a chip and
narrowing happens between them, so every chip added narrows what is left and
none can widen it — the graph you end up with is the intersection of every mask
you laid down. Backspace on an empty box lifts the last chip; the `✕` on a chip
lifts that one.

Eight facets can be masked on: `author`, `year`, `tag`, `type`, `publication`,
`collection`, `cluster` (the subfield, see above), `title`. A bare term with no
`field:` prefix is asked of all eight at once, so `Tales` finds the paper without
you having to know which field it lives in.

`tag` is the Zotero tags on the item, the ones typed by hand and the ones a
translator attached alike — which of the two a tag is says where it came from,
not what it means. An item carries any number of them, and a mask matches on all
of them, so `tag:"to read"` finds the paper it is the fifth tag of. Being a facet
like the others, it stacks with them and names a group as readily as it filters
one: `tag:magnetometry` in the panel shows those papers, and the same text on a
flag gathers them.

The same box, chips and completions serve a second purpose: naming what a
**group** pulls. Everything below is true of both — the only difference is that
the panel's masks decide what is drawn and a group's decide what is attracted.
See [The canvas menu, and grouping](#the-canvas-menu-and-grouping).

### Building a chip

The first value you pick commits the chip and the graph moves at once; every
value after it **rewrites the same chip** rather than starting a second, and the
box keeps a trailing comma with the list still open so you can keep going. The
chip being authored is outlined in the panel. Enter on typed text finishes the
chip; so does clicking away.

Click a chip to put it back in the box for editing — that is the way to reach a
value the chip's width has clipped, and the way to drop one value out of several.

### Exact versus substring

| chip | meaning |
|---|---|
| `publication: Nature` | that value exactly — what picking a completion gives you |
| `publication: ~nat` | anything containing it — what typing gives you |

The exact form is what keeps `type: book` from dragging in every `bookSection`,
and `publication: Nature` from dragging in *Nature Reviews*; the substring form
is why nobody has to spell a surname out in full. In the box the two are told
apart by quoting: `"Nature"` is pinned, `nat` is a substring. Quoting is also how
a value containing a comma survives the split — `publication: "Ann. Phys., Lpz."`
is one value, not two — and `~"a, b"` is a substring that contains one.

`year` also takes comparisons and ranges — `year:2013`, `year:>2010`,
`year:>=2012`, `year:<2000`, `year:2010-2015` — because "papers since 2015" is a
question people actually ask and listing eleven years to ask it would be absurd.
These mix with plain years in one chip: `year: 2013, 1990-2000`. A three-digit
term is not a year, so `year:201` falls through to a text match and keeps meaning
the 2010s.

### The completion list

**It is context-sensitive**, and that is the part worth understanding. Its
candidates come from the items that survive the masks *already down*, never from
the whole collection, and each row carries the count of items behind it. So a
value offered to you always leaves something on screen: stacking filters walks
down a narrowing tree rather than dead-ending on a combination that matches
nothing.

The one mask left out of that reckoning is **the chip being edited**, because it
is about to be widened — constraining the candidates by a mask whose values OR
would hide exactly the values you are reaching for. Values already in the chip
are dropped from the list too; a top row that does nothing is worse than a
shorter list.

With the box empty the list names the six fields, so the vocabulary is
discoverable without documentation. Past the first comma it stops offering field
names — the field is settled by then.

**Outside references are not masked.** A ghost is a DOI and, with lookup on, a
title — masking it on author or publication would delete every one of them the
moment any filter existed. Instead it keeps the treatment it already had: a
ghost is drawn when a held item that survived still cites it. That is what makes
`author:Kucsko` read as "his papers, and what they cite".

The completion list itself is a sibling of `#graph`, not a child of the panel:
`#side-body` scrolls and clips, so a twelve-row list opened from a control
halfway down the panel would be cut in half. `graph.js` places it against the
input by hand — the same reason `#menu` and `#action` sit out there.

The parsing, matching and ranking live in `addon/content/nodeFilters.js`, which
is pure and unit-tested for the same reason `nodeScale.js` is — a range that
parses wrong, or a chip that does not survive the round trip through the box it
is edited in, are both tedious to catch by clicking around a graph.

## Interacting with a node

| gesture | held item | outside reference |
|---|---|---|
| hover | tooltip | tooltip |
| click | pick it and its edges, **and** describe it in Zotero's item pane beside the graph | pick it and its edges |
| Ctrl-click (Cmd on a Mac) | add it to the pick, or take it out again | same |
| double click | isolate | isolate |
| Ctrl-double-click | add its neighbourhood to the isolation, or take it out again | same |
| drag | move it; it drifts back unless pinned | move it; it drifts back unless pinned |
| the same four, on a row of **what is missing** | — | same as clicking the ghost itself |
| right click | Show in Library · Open PDF in new tab · Open in browser · Isolate · Add to isolation · Pin node here | Show details · Open in browser · Add to Zotero · Isolate · Add to isolation · Pin node here |

**Picking** rings the node and draws the edges out of it at full strength,
and changes nothing else on screen. It answers "which lines touch this one",
which only reads if the lines it is being picked out *from* are still there to
compare against — so unlike isolating, it takes nothing away. Only the node's own
edges light, not the rungs between its neighbours; that wider question is what
isolating is for. Clicking the node again, or clicking empty canvas, puts it back.

It is the single click because it is the cheap half of the pair: nothing else
moves or fades, so a stray click while panning a dense graph costs you a ring
rather than a graph you have to undim. Isolating repaints the whole picture, so
it is behind the double click.

The pick is also **the tab's selection**, and the only one there is: it is what
Locate, the item context menu and "Add to Collection" act on, and it is what the
pane beside the graph describes. So it is a **set**, built with Ctrl-click (Cmd
on a Mac) the way every list on the desktop is, and every node in it wears a
ring. A right click inside the pick acts on the whole pick; one outside it takes
the pick with it first, which is again the item tree's own rule. Ghosts carry no
item, so they ring like anything else but contribute nothing to the selection.

See *[The item pane, beside the graph](#the-item-pane-beside-the-graph)* for what
the pane says about a pick of none, one and several.

**Isolating** dims everything more than `isolation depth` edges from the node —
in both directions, so you see what it cites *and* what cites it. It is a view
state, not a filter: nothing is removed from the simulation, so nothing moves,
and the neighbourhood stays where your eye left it. Double-clicking the node
again, clicking empty canvas, pressing Escape, or the `isolated: …` button that
appears in the control panel all give the whole graph back.

The focus is a **set**, not one node, and it is built the way the pick is:
**Ctrl-double-click** (Cmd on a Mac) lights a second neighbourhood beside the
first without losing it, or puts one out again. That is the same modifier the
single click reads, meaning the same thing one level up — add to what is there
rather than start again — so one rule covers both of the things a click builds.
It is what answers "do these two papers share anything".

`Add to isolation` in the context menu is the same two calls for a pointer that
would rather not double-click; the entry appears only once something is
isolated, and reads `Remove from isolation` on a node already in the set. A
plain double click keeps its meaning whatever the set holds: it isolates the
node clicked and nothing else, so there is always one gesture back to a single
neighbourhood.

The **pick follows the focus** through a Ctrl-double-click, rather than being
left to the two clicks underneath — those run `togglePick()` twice and cancel
out, which would leave the ringed set saying nothing about the gesture just
made. Following it keeps the rings and the lit neighbourhoods describing the
same papers, which is what a plain double click already does with one.

**`isolation depth`** in the control panel is how many edges out the light
reaches: one step is the paper's own citations, two adds what those cite in turn.
Zero lights the isolated nodes alone — everything else dims, which is how you
pick a handful of papers out of a crowded graph and look at just them. A link
stays lit only if it is one of the edges walked to get there — both ends lit,
and at least one of them reached before the last step out. Without that second
condition a two-step isolation of a dense cluster would light every edge among
the fringe as well and come back looking like the whole graph. At zero there is
no step out for that rule to talk about, so both ends lit is the whole test and
a link between two isolated nodes stays lit. The setting is remembered across
windows, like `edge pull`: someone who reads their graph two steps out reads
every graph two steps out.

**Pinning** holds a node where you dragged it. Drag it into place, right-click,
`Pin node here`; the pin itself appears over the node's upper-right shoulder and
it stops being carried by the layout, while every force it exerts on its
neighbours keeps acting — so pinning one paper anchors the cluster around it
rather than freezing it. The mark was a grey ring just outside the circle once,
which was legible and mute: a ring says "something about this node" and leaves
you to remember which something, and it was the third ring in the drawing, inside
the pick's and beside isolation's fade. The badge is the same shape as the menu
entry that put it there — `ZGIcons.paths()` hands the canvas the pin's path data,
so the menu and the node are drawn from one table — and it is haloed in the page
background for the reason a label is, since it lies over the node's own fill and
over whatever edges cross that shoulder. It is sized from the node's radius, in
graph coordinates, unlike the label and the two rings: those are constant in
*screen* pixels, which for this badge would mean that zooming out to see a whole
collection left a fixed-size pin four times the size of the speck it belongs to.
Nothing is drawn on an *unpinned* node being carried: force-graph fixes a dragged
node's coordinates for the length of the gesture, so `isPinned()` was true of
anything anyone dragged and every drag flashed a pin — and a drag needs no mark
in any case, since the node is under the pointer, moving with it. A node that was
already pinned keeps its badge all the way through, because dragging a pinned
node moves its pin rather than releasing it. What tells the two apart is
`pressPinned`, recorded on the pointerdown the drag begins from — the last moment
`fx`/`fy` still mean what they say. Dragging a pinned node
moves its pin; `Unpin node` in the same menu releases it. Both populations can
be pinned: where a node sits is a fact about the layout, and an outside
reference has one as much as a held item does. Unpinning does not reheat the
simulation — taking one pin out is no reason to reshuffle a graph you have spent
time arranging, so the node rejoins the flow the next time something else stirs
it. Pins live on the node objects the renderer reuses, so they survive a filter
change and a late build phase landing, and are forgotten when the tab closes.

**Right-clicking a node you are still carrying** is the gesture the pin was
built for, and it works: drag it where it belongs, right-click without letting
go, pin it there. The right button ends the drag and opens the menu, and the
node is *held* at the spot it was dropped for as long as the menu is open — so
it can neither drift away underneath the question nor be dragged across the
canvas on the way to the answer. `Pin node here` makes the hold permanent;
dismissing the menu any other way gives the node back to the layout.

**Open in browser** resolves a held item's `url` field, or its DOI through
doi.org when it has no URL; an outside reference always goes through its
identifier (`doi.org`, `arxiv.org`, `openalex.org`). Only http(s) is ever handed
to `Zotero.launchURL` — the `url` field is free text and routinely holds a local
path. The URL building is pure and lives in `content/nodeLinks.js`, which also
carries the one copy of `normDoi()` the content page needs; `npm test` asserts
that copy still agrees with the core one.

**Add to Zotero** appears in three places — the ghost's context menu, the detail
card that menu's *Show details* opens, and the `+` in *what is missing* — and all
three end in the same dialog. The menu entry goes straight to it, because a
right-click menu entry cannot be hit by accident. The detail card keeps its own
button in front of it, because reading a reference and filing it are two
different intentions and adding writes to the library.

**The dialog asks two things.** A **tag**, defaulting to `added by citation
graph` and applied as a manual tag — the kind the tag selector lists and can
colour — which is what makes a graph-filled shelf findable afterwards; untick
the box to add without one. And a **collection**, which opens on whichever
collection the graph is of. The picker is core's own
`Zotero.Utilities.Internal.createMenuForTarget()`, the same tree behind *Add to
Collection* and behind the *Create in* field of Zotero's new-collection dialog,
so it nests exactly the way the collection pane does and picking the library
itself means the library root. **New Collection…** hands off to Zotero's own
new-collection dialog and files into whatever comes back.

Both answers stick. The tag and its checkbox are written to
`extensions.zotero.zoteroCitationGraph.addTag` and `.addTagEnabled`, and are what the
dialog opens with next time; the collection is remembered for the life of the
tab. The tag default is deliberately not translated — it is library data, not
interface text, and a tag that changed with Zotero's display language would
split one shelf of papers across two names.

It is a XUL `<panel>` built in the main window rather than a window of its own.
A Zotero 7+ plugin registers no `chrome://` package — this one serves its files
over `resource://` — so there is no privileged document of ours to hand
`openDialog()`, and the main window is where core's menu builder already works.
A panel also leaves the graph on screen behind it, which is the same bargain the
side panel strikes. See `lib/addDialog.js`.

**Adding does not rebuild the graph.** It used to, and the layout re-annealed
from full temperature every time — a rebuild opens by pushing an empty edge
list, which strips every edge off the graph you are reading and lets it fall
apart before the next two phases put it back. So the paper is folded in
instead: every edge that pointed at `doi:…` is re-keyed to the item's own key,
the item joins the collection's list, and one payload goes out carrying the
rename. The page gives the new node the ghost's coordinates — or, with outside
refs switched off and no ghost on screen, the middle of the papers that cite it
— and then **spends the reheat against a frozen graph**: every other node is
held where it stands while alpha is shed to nothing over ten ticks, a sixth of
a second, and then everything is let go at once. The graph does not move. The
freeze is deliberately that brief: a frozen node cannot answer a drag, so a
freeze that outlasted its shed would take the response out of the next thing
you did. What this deliberately does not do is read the new paper's own PDF for
what *it* cites — that needs a build, and the next one finds it.

In a **collection** graph, a paper filed into a collection this graph is not of is added to the
library and nothing else: the status line says so, and the ghost stays a ghost, which is the
truth about a collection-scoped graph.

## The canvas menu, and grouping

Right-clicking the canvas itself — anywhere no node is under the pointer — gives
two entries:

| entry | what it does |
|---|---|
| `Zoom to fit` | the same reframe as the ⤢ button, bottom left |
| `Group here` | plants an anchor at the pointer and asks what belongs at it |

**A group is an anchor with a filter.** Plant a flag, name what belongs there
with the same filter box the panel uses — same chips, same completions, same
grammar — and every paper the mask picks out is pulled to that spot. **Click the
flag** for its own two entries, `Edit group` and `Remove group` — the right
button over it offers the same two, and the card's `Remove` button does the
second. A flag closed without a mask ever being named is thrown away rather than
left standing, since it would pull nothing and say nothing.

**Drag a flag to move the anchor.** The papers stay where they are while it
travels and come after it when you let go, so a group can be put down somewhere
and the layout asked what follows it there. A press that lands within a flag's
reach belongs to the flag, whether or not a node is underneath it — the same
rule the right button already went by, since the alternative is that the one
thing you can see you are aiming at is the one thing you cannot hit.

The card opens at the pointer, which is where the flag was just planted — so
the one thing it is certain to cover is what you are looking at while you decide
what belongs there. **Drag it by its title** to move it out of the way. `Done`,
Escape, or a click anywhere outside it closes it; the masks are committed as
they are picked, so there is never anything in it left to save.

The point of it is that the layout answers one question — who cites whom — and
scatters everything else. "Where do this author's papers actually sit" has no
answer in a force-directed graph until you give it one. Two flags and two masks
turn the picture into a comparison: the papers go to their corners, and the edges
still running between them are what the two groups share.

**A group's masks decide what is *pulled*, never what is *drawn*.** That is the
one difference from the panel's masks, and it is what makes the two stack
sensibly: a group naming papers the panel has already filtered away simply pulls
nothing, because a node that is not on screen has no position to change. Lift the
panel mask and its papers come back and go straight to the flag.

The pull is firm by default — an order of magnitude past the centre pull that
keeps the graph together — but it does not win outright, and that is deliberate.
It still competes with the citation links, so a group that drags a paper away
from what it cites stretches those edges rather than cutting them, and how far
they stretch is part of the picture you asked for. A grouped node is exempt from
the centre pull entirely: two pulls at once would park it short of its flag, and
a group planted out at the rim would gather a cluster that visibly sagged towards
the middle.

**How hard every anchor pulls** is the panel's `group pull` slider, committed as
you drag it and shared by all of them. A firm setting states where these papers
go; a slack one asks how far they are willing to travel and lets their citations
answer, and you find the one you want by watching the graph reply. At 0 the
anchors name their papers and move none of them, which is how you ask what a
group would have been without disturbing the layout; an open card's note says so
in as many words, and those papers go back to feeling the centre pull rather than
being left held by nothing at all.

A paper caught by two flags goes to the point midway between them and feels the
two pulls together, capped at the strength past which it would ring around its
target instead of arriving at it. The weighted average that computes the midpoint
is kept even though every anchor now pulls equally — it is what the sum already
means, and it is the line that would have to be right again the moment an anchor
gets a weight of its own back.

Pins outrank groups. A pinned node has fixed coordinates, and d3 stops
integrating it at all — which is the right precedence, since a pin is a position
placed by hand and a mask should not overrule it. The two do not otherwise
collide: `pin pull` prices links, `group pull` moves nodes, so a paper an anchor
is holding can still have its link to a pinned node strengthened, and where it
ends up is the argument between the two that you asked to see.

Groups are view state, like isolation and the filter masks: nothing is derived
for them, nothing reaches chrome, and they survive a rebuild.

## The item pane, beside the graph

**Clicking a held node** opens Zotero’s *own* item pane on the right of the graph tab — info, abstract, attachments with their
previews, notes, libraries and collections, tags, related, and any section another plugin has
registered, all editable exactly as they are in the library. It is not a rendering of the item
pane: it is `<item-details>` plus an `<item-pane-sidenav>`, the same custom elements
`zoteroPane.xhtml` builds, created in the main window’s document. The recipe is core’s own —
`contextPane.js` `_addItemContext()` does precisely this to give every reader tab an item pane.

Three properties have to come from us, and each is load-bearing:

| property | why |
|---|---|
| `sidenav` | `ItemDetails` talks to one unconditionally (`forceUpdateSideNav`, `renderCustomSections`), so it is not optional even if the strip of icons were unwanted |
| `tabID` | `ItemDetails` watches `select`/`tab` and sets `skipRender` when its tab is not the one on screen; without it the pane keeps rendering in a tab nobody is looking at |
| `tabType` | `'graph'` — neither `library` nor `reader`, which is exactly right: attachment previews stay on (a reader tab suppresses the preview of the file it is already showing), while the panes that ask the library which row is selected (`inTrash`, the pinned-pane pref) take their non-library branch and never reach for a collection tree this tab does not have |

**The PDF is the item pane's job.** Its Attachments section previews the file and opens it, which
is the gesture the library already gives you, and the node menu's **Open PDF in new tab** is the
way to the full reader — sidebar, search, annotation, the lot. An earlier version rendered a
read-only `Zotero.Reader.openPreview()` into this same panel: a PDF you could scroll but not
annotate, search or select from, competing with the item pane for the one panel and needing four
of the preview's own defaults undone to be readable at all. It is retired. One panel, one
occupant, and the reader you get is the real one.

**One gesture, both halves of the same question.** A click already isolated the node’s
neighbourhood; now it also describes the item. What a paper is connected to and what it *is* are
the two things you want when you point at it, and asking for them separately was busywork. (An
earlier version put this on hover behind a checkbox. Hover meant a dwell timer, a preference to
remember, and a panel that appeared while you were only panning across the canvas — a click says
it once and says it deliberately.)

**Every change of the pick sends**, and the message carries the whole selection — chrome is the
side that knows whether anything needs doing. It *serialises* renders and draws only the latest
selection: click across three nodes while the first is still drawing and the middle one is
dropped, unrendered. A click never reopens a pane you have collapsed; see below.

**The pane has a different answer for each size of the selection, and they are the library's
answers** — copied out of core's `ItemPane.render()` (`elements/itemPane.js`), branch for branch:

| picked | the pane |
|---|---|
| nothing | the count of what the graph is drawing — *27 items in this view* — in core's own `<item-message-pane>` |
| one | that paper's sections, or, for a note, core's editor. As it always was |
| several | *3 items selected* and **Edit Multiple Items…**; taking that up hands core's `<item-details>` the whole list as `item` + `extraItems`, which is the multi-item info box — *Multiple* wherever the papers disagree, one edit written to all of them — with **Done** in the pane's head to come back |

The strings are core's own l10n ids, so the plurals and the translations are the ones the library
window puts on screen. The batch-editing offer is an **opt-in** for core's reason: the multi-item
box writes every edit to every selected paper, and that is not a thing to walk into by clicking a
second node. The opt-in is dropped whenever the set of papers changes.

The count of the view is the one thing only the page knows, so it travels on the same message
(`inView`). It moves with every pixel of a slider drag, so a restated count **re-words the message
and does not touch the deck** — the gap list is a page of that same deck, and a count that took it
would close a list the user was reading down. A real change of selection does take it.

**An outside reference contributes nothing to the selection.** There is no item to describe, and
its own card is what the context menu is for — so a pick made only of ghosts is an empty
selection, and the pane says how many items are in the view.

**A sidenav has to be told that something is being viewed, or it stays greyed out.** `init()`
ends with `toggleDefaultStatus(true)`, so every button starts `disabled` — 60% opacity and
`pointer-events: none`, present and inert. Core's `<item-pane>` clears it from
`_handleViewTypeChange`, and `contextPane.js` clears the reader's at init; a graph tab has
neither, so `itemPane.js` does it itself. **Before** setting `details.sidenav`, which is
contextPane.js's order: `render()` returns early while there is no container, so the strip is
drawn exactly once and drawn already enabled.

**The sidenav's first button — Toggle Item Pane — collapses the pane, exactly as it does in the
library.** That button is one line on top of `_collapsed`, and `ItemPaneContainerBase` resolves
that property through `closest('item-pane, context-pane')` — neither of which this is. So it read
`false`, swallowed every write, and sat in the strip as the one button that did nothing; it used
to be hidden for that reason, next to a chevron of ours doing the job instead. The property is
answered now: `itemPane.js` defines an *own* `_collapsed` on the `<item-details>` instance,
shadowing the base class's, and it drives `splitPane.js`. Nothing else about the button changes —
not the icon, not the keyboard handling — and the same property is what makes a click on any
*section* icon expand the pane on its way to scrolling there, which is core's behaviour and is now
ours for free.

**Collapsed is the sidenav, not an empty column.** `item-pane[collapsed=true]` in the library is
37px of icons with the pane beside it at `visibility: collapse`, and this panel does the same. The
strip is both the way back and the reminder that there is something to come back to, which is also
why the panel cannot simply be hidden: the button that reopens it lives in there.

**A collapsed pane is not rendered into.** Core skips its sections while collapsed, and `show()`
does not even start — so a click on a node behind a collapsed pane is *recorded* rather than
drawn, and drawn the moment the pane comes back. Expanding therefore lands on the paper you last
clicked, not on whatever was there when you put it away.

## Locate, and what a graph tab has selected

The button at the foot of the sidenav is Zotero’s **Locate** menu — “View PDF”, “View Online”, “Library
Lookup”, and every lookup engine in `<dataDir>/locate/engines.json` (Google Scholar is the one
Zotero ships). Over a graph tab it used to open onto a single disabled row reading *0 items
selected*, whichever node you had just clicked.

Nothing about Locate was wrong. `Zotero_LocateMenu.buildLocateMenu()` asks
`ZoteroPane.getSelectedItems()`, which is a `switch` over `Zotero_Tabs.selectedType`
(`zoteroPane.js`) with a case for each tab type core ships — the item tree’s selection for
`library`, the item behind the tab for `reader`, the item named in the tab data for `note` — and
`default: []` for everything else. A graph tab took the default. That same switch is what makes
Locate work in a reader tab, so the fix is core’s own shape: a graph tab needs its case.

There is no hook for adding one, so `lib/locate.js` wraps the function — one of the two wrappers
in that file, both there because core derives its answer from the type of the selected tab and a
graph tab is a type it has never heard of. It answers for exactly one tab type and hands every
other call straight through, `libraryTabOnly` included — that flag exists so a caller can ask what
the *library* holds while another tab is on screen, and core checks it ahead of the tab type. Note
the reach: several other core menus route through `getSelectedItems()` too, and they now see the
clicked node as well, which is the same deal a reader tab gets. Both wrappers are installed and
removed per window beside the tab hooks in `main.js`; on the way out the window gets its own
functions back, unless another plugin has wrapped on top since, in which case ours stays where it
is and goes inert rather than silently uninstalling theirs.

**What counts as selected is the pick** — the ringed nodes, which is the same gesture that fills
the item pane, and it is literally the same message: `item-pane-show` carries the whole list and
records it before drawing anything. Deliberately before, and outside the pane’s own guards:
`itemPane.show()` draws nothing when the panel is collapsed, and the click selected the papers
either way. What Locate acts on must not depend on whether the pane happened to be on screen.

Two consequences worth stating. Clicking empty canvas clears the pick, so it clears the selection
too, and the pane says how many items are in the view — the pane is the indicator, and the two
cannot disagree because they are one message. And a ghost has no item, so it rings like any other
node but adds nothing to the list.

The node context menu carries the same list on `node-menu`, and the page makes sure the node
right-clicked is in the pick before it sends: a right click inside the pick is a menu about the
whole pick, one outside it takes the pick with it first. That is the item tree's own rule, and it
is what makes **Add to Collection** over four ringed nodes file the four of them.

The IDs are read back through `Zotero.Items` rather than trusted. A paper deleted out from under a
graph that is still on screen drops out of the selection, which gives the honest *0 items
selected*, where handing a dead ID to core’s menu builder would throw.

**A graph tab is not the tab that is already showing the PDF.** The sidenav also works out a
`locateMode` from `container.tabType` — `"library"` for the library tab, `"tab"` for everything
else — and one test reads it, `ViewItem.canHandleItem`, which drops the entry that would “open in
the same type of the current context”. A reader tab is right to lose *View in Tab*: it is already
that tab. A graph tab is showing a graph, so the entry is not redundant, and the graph’s own node
menu has offered exactly that move all along. `locate.js` therefore takes the mode off the options
on the way past. **Removed rather than set to `"library"`**: the suppression is keyed on two named
contexts and a graph tab is neither, so no mode at all is the honest answer — and it is already
what core’s own `{ locateMode } = {}` default means. Claiming to be a library tab would buy the
same two entries today by asserting something untrue, and would come apart the first time core
gave that value a second meaning.

## The side panel, and how it is sized

The graph tab's right-hand panel holds one thing — Zotero's item pane — and `splitPane.js` owns
everything around it: the splitter, the remembered width
(`extensions.zotero.zoteroCitationGraph.paneWidth`, falling back to the old `readerPaneWidth` for a
profile that had already dragged the PDF pane this plugin used to put here), and the collapsed
state the sidenav's toggle writes through `_collapsed`.

It was two things once — a reader and the item pane, sharing one panel by handing it back and
forth, with a chevron of ours hung off the panel's edge to put either away. Both halves of that
are gone: there is nothing to hand over, and the button that collapses the pane is the pane's own.
What is left is a panel, a divider and a width.

**Collapsing is not implemented here.** It is core’s, from the module core’s own `<item-pane>`
uses — `chrome://zotero/content/elements/utils/collapsiblePane.mjs`. `isPaneCollapsed()` and
`setPaneCollapsed()` take the element sitting immediately after a `<splitter>` and write the whole
state across both: `collapsed` on the pane, `state` and `substate` on the splitter, and a resize
event on the window. That is exactly the shape this panel already has — `[splitter][box]` inside
the tab’s `hbox` — so the helpers apply to it unchanged, and the attributes they write are the
ones Zotero’s stylesheet is written against. The CSS is core’s too, copied with only the selector
changed:

```css
item-pane[collapsed=true] { min-width:37px; min-height:37px; max-width:37px; visibility:inherit }
item-pane[collapsed=true] #zotero-item-pane-content { visibility: collapse }
```

37px is the sidenav, which is the whole of the panel once collapsed. The `visibility: inherit` is
load-bearing and is core’s: XUL’s UA sheet gives `[collapsed="true"]` a `visibility: collapse`,
which would take the sidenav down with everything else and leave no way back. What is left for
this module is the width either side of the collapse — core’s `<item-pane>` restores its own from
`handleResize()` and a `zotero-persist` attribute, neither of which a plain box has.

**The divider is styled by core, but only if it asks.** Every one of Zotero’s splitter rules is
keyed on `[collapse=…]` or `[substate=…]`:

```css
splitter:not([orient=vertical])[substate=after] {
  border-left: 0; border-right: var(--material-border-quarternary);
  margin-left: calc(1px - var(--draggable-size)); margin-right: -1px;
}
```

The negative margins are the point: the splitter keeps its full 5–8px grab width but *costs the
layout nothing*, overlapping its neighbours, and paints one hairline between them. That is how
every divider in the window is built. A `<splitter>` carrying **neither** attribute — which is
what this plugin shipped — matches only `splitter:not([orient=vertical]) { min-width:
var(--draggable-size) }`: 5–8px of *transparent, real* layout width, with no line anywhere. It
went unnoticed for as long as it did because the old chevron was `position: absolute; right:
100%`, 18px wide and opaque, parked exactly on top of it; retiring the chevron uncovered the strip
beside the collapsed sidenav.

`substate="after"` is set once at creation, for the state the panel starts in; from there it is
core’s helper’s to maintain. Not core’s `collapse="after"`, which selects the identical rule:
`collapse` is the attribute `nsSplitterFrame` keys its **own** drag-to-the-edge collapse off, and
that writes `collapsed="true"` straight onto the panel — a second collapse behind the back of the
one the sidenav’s toggle drives.

### The edge of a collapsed pane, which took three goes

There is exactly **one** hairline at the outer edge of a collapsed pane, and two elements that
could draw it:

- the **splitter’s** own border, and
- the **sidenav’s** `border-inline-start`, which normally sits buried between the pane content and
  the sidenav — and becomes the panel’s outer edge the moment that content goes `visibility:
  collapse`.

Let both draw and you get two 1px lines in slightly different colours
(`--material-border-quarternary` against `--material-panedivider`) hard against each other: a
visibly darker edge than the library’s. That shipped.

Core’s answer is its `[state=collapsed]` rules, which move the splitter’s line to `border-left`
and drop the negative margins — parking the line at the far side of 8–10px of splitter. Core can
afford that width because its markup carries `collapse="after"`, which makes the collapsed
splitter the grab handle that pulls the pane back out. Taking that answer here gave the strip of
nothing back, because **this** splitter is deliberately not a handle. That shipped too.

So the sidenav draws the edge and the splitter gets out of the way — the one rule in this plugin
that departs from core on purpose:

```css
splitter.zg-pane-splitter:not([orient="vertical"])[substate="after"][state="collapsed"] {
  border: 0;
  margin-left: calc(1px - var(--draggable-size)); margin-right: -1px;
  pointer-events: none;
}
```

**That selector is core’s own, qualified with our class, and it has to be.** The rule it overrides
is `splitter:not([orient=vertical])[substate=after][state=collapsed]` — three attributes, because
`:not()` contributes its *argument’s* specificity rather than any of its own, plus a type selector:
**(0,3,1)**. This first shipped as `.zg-pane-splitter[state="collapsed"]`, which is **(0,2,0)** and
lost. Every declaration in it was dead; the only one that ever took effect was `pointer-events`,
because core sets no such property on a splitter — so the release that was supposed to fix the
strip changed nothing at all on screen. Adding the class to core’s selector makes it **(0,4,1)**,
which wins on specificity rather than on which stylesheet happens to be appended last.

The margins cancel the width off the *same variable* core’s own rule uses, so the density bump on
`--draggable-size` cancels itself; a hardcoded `-4px` would reopen the gap the first time someone
switched to comfortable density. `pointer-events: none` follows from not having `collapse="after"`:
without it `nsSplitterFrame` cannot un-collapse the pane on a drag, so a draggable-looking divider
could only push against `max-width` and feel broken. The way back is the sidenav’s button. And the
line you are left with is the sidenav’s `border-inline-start` — the same line, from the same
element, that the library shows beside *its* collapsed item pane.

`npm test` holds all four: that this rule **outranks** the core rule it is overriding (it counts
both selectors, `:not()` expanded, and compares them), the border zeroed, both margins present,
and the width cancelled by the variable rather than a number.

**Zotero’s `--material-*` border variables are whole shorthands, not colours.**
`--material-panedivider` is `1px solid var(--color-panedivider)`, so `border: 1px solid
var(--material-panedivider)` expands to `1px solid 1px solid #dadada` and is discarded — the rule
does nothing at all, and a missing hairline is easy to stop seeing. The splitter once had the same
mistake in reverse (`background: var(--material-panedivider)`), which is why styling it did
nothing. `npm test` scans `lib/*.js` for both shapes.

Sizing needs two things, and getting one without the other is what made the first version of the
item pane open at the width of the whole window:

- **`contain: inline-size`** on the panel. A XUL box sizes to its contents, and an item pane's
  contents are an abstract on one very long line — wide enough to push the graph off the screen
  entirely. With inline-size containment the panel's width never depends on what is in it.
- **The `width` attribute mirrored into an inline width.** A XUL splitter resizes by writing the
  `width` *attribute* onto its neighbours, so that attribute has to stay the source of truth or
  dragging stops working; a `MutationObserver` copies it into `style.width` so the panel is
  sized the same way whether or not the attribute is honoured on its own.

## Layout

```
addon/
  manifest.json          applications.zotero, strict_min_version 10.0.0
  bootstrap.js           lifecycle; registers resource://zotero-citation-graph/ and boots the CJS loader
  lib/
    cjs.js               ~50-line CommonJS loader -- why there is no build step
    main.js              menu registration, per-window setup, tab hooks
    graphTab.js          tab creation, the chrome<->content bridge, phased build
    itemPane.js          the in-tab item pane: core's own <item-details>, following the pointer
    gapsPane.js          "what is missing", as a third page of the item pane's deck
    splitPane.js         the tab's side panel: how wide it is, and whether it is showing
    zoteroAdapter.js     the 4-method adapter over the live Zotero APIs
    pdfLinkCache.js      per-file cache of PDF /URI scans, in the data directory
    metadataCache.js     resolved identifier metadata; ages out, unlike the above
    l10n.js              chrome-side strings: resolves the locale, reads the .ftl
  content/               runs with a CONTENT principal: no Zotero, no XPCOM
    graph.html/.js/.css  plain DOM + canvas
    nodeScale.js         node sizing maths; pure, so npm test can assert the curve
    nodeLinks.js         where a node points on the web; pure, same reason
    nodeFilters.js       the mask grammar, matching and completions; pure, same reason
    ftl.js               a Fluent subset, shared with lib/l10n.js; pure, same reason
    l10n.js              the page's strings, pushed over the bridge as .ftl source
    lib/force-graph.min.js   vendored UMD (global `ForceGraph`)
  citation-graph/        the derivation library, shared verbatim with the CLI
    edges/               "does A cite B"      -> core/registry.js
    enrich/              "what is this DOI"   -> core/enrichRegistry.js
  locale/
    en-US/zotero-citation-graph.ftl   the source strings; every other locale mirrors it
    de-DE/zotero-citation-graph.ftl
docs/
  external-references.md  how Zotero's own add-by-identifier works, which citation
                          API to use and why, and the design of enrich/
tools/
  cli.js                 Node benchmark harness (see citation-graph/README.md)
  test-cjs-shim.js       pre-flight for the CommonJS loader
  install-dev.ps1 / uninstall-dev.ps1
```

## Design notes worth knowing before editing

- **Two provider populations, two registries, one selection rule.** An edge strategy answers
  "does A cite B"; an enricher answers "what is this identifier called". They run at different
  times and fail independently, so they are separate registries — but both are built from
  `core/providerRegistry.js`, so `offline` and the enable/disable lists cannot come to mean two
  different things. Enrichers merge **fill-first, per field**, which is what makes the list of
  them a ranking: a second API is only ever asked about what the first could not resolve.
- **`citation-graph/` is host-agnostic and must stay that way.** It has zero Node-only requires,
  which is what lets the same source run inside Zotero *and* under Node for benchmarking. It reads
  the world through a 4-method adapter (`listItems`, `getAttachments`, `getAttachmentText`,
  `getPdfLinkUris`). `adapters/localSqlite.js` is the Node one and is never loaded by the plugin.
- **Payloads cross the privilege boundary as JSON strings.** A string is a primitive, so no
  `Cu.cloneInto`, no Xray waivers, no structured-clone failures. Chrome calls
  `contentWindow.wrappedJSObject.zgSetData(json)`; the page replies with a `zg-event` CustomEvent
  whose `detail` is also a JSON string.
- **Strings are `.ftl`, and the page formats them itself.** Zotero registers
  `addon/locale/<locale>/*.ftl` into a global `L10nRegistry` source all by itself
  (`xpcom/plugins.js registerLocales`), with a per-file fallback of exact locale → same language →
  `en-US`; that is what renders the collection menu's label. Everything else goes a different way,
  because the graph page has an ordinary **content** principal: the `Localization` constructor is
  `[ChromeOnly]`, and `document.l10n` — if a `resource://` content document gets one at all —
  formats asynchronously, which a canvas tooltip accessor cannot wait for. So chrome reads the
  `.ftl` for the resolved locale and hands the page its **source text**, over the same bridge as
  everything else; `content/ftl.js` formats it synchronously on both sides. One source of truth,
  no async in a render path, nothing that depends on privilege the page does not have.
  The subset is variables and plural selectors — no message references, no nested selectors, no
  functions. Static markup carries `data-zg-str` / `-title` / `-placeholder` / `-aria-label`
  attributes and keeps its English as the fallback, so a page whose strings never arrive is still
  a usable panel. `npm test` checks every id the source asks for against `en-US`, every other
  locale against `en-US`'s message list and variables, and `LOCALES` in `lib/l10n.js` against the
  directories on disk.
- **`restoreState` is the one mandatory tab hook.** `tabs.js:611` destructures the hook's return
  value and the missing-hook default returns `undefined`, so omitting it throws and aborts session
  restore for every later tab — not the tab it was called for. Neither `restoreState.graph` nor
  `load.graph` is therefore allowed to throw; both wrap their whole body. Note the indexing is
  `tabHooks[action][type]` — i.e. `tabHooks.restoreState.graph`.
- **The `restoreState` hook is the fast path, not the one that usually runs.** A plugin cannot get
  itself registered before Zotero restores: `Zotero.Plugins.init()` is awaited at the *end* of
  `Zotero.init()`, while `ZoteroPane.init()` — and `_loadPane()`, which restores once the item and
  collection trees are up — is gated only on `initializationPromise`, which resolves before it.
  Measured on a real profile, restore had finished before this plugin was loaded at all: at
  `onMainWindowLoad` the strip already held the session's `reader-unloaded` tabs and the hook had
  never been called. So `graphTab.restoreMissing()` reads `Zotero.Session.state` — the parsed
  `session.json`, which restoring does not clear — and gives a tab to every `graph` entry the hook
  never claimed. Both paths share a `WeakSet` keyed on the session entry object (the same objects
  `restoreState` is handed), claimed *before* the first `await` so two passes cannot both get past
  the check, and passes are serialised behind one chain. Either order, or both, ends with one tab.
  **What it cannot repair:** with no hook registered, `tabs.js:611` destructures the default hook's
  `undefined` and throws, and `zoteroPane.js` catches that around the *whole* loop — so any tab
  positioned after a graph tab in the session is lost with it, and those are not ours to restore.
- **Graph tabs restore lazily, through core's own unloaded-tab mechanism.** `restoreState` re-adds
  the tab as `graph-unloaded`; `select()` then promotes it through `graph-loading` to `graph` by
  calling `tabHooks.load.graph`, which is where the page is actually mounted. So a window restored
  with four graph tabs pays for one build, not four concurrent PDF scans at the slowest moment of
  startup. The `load` hook resolves when the **bridge** is up, not when the build finishes —
  `select()` holds `ZoteroContextPane`'s loading cover over the tab until it settles. And `graph` is
  deliberately **not** pushed into core's `_loadableTypes`: that list is what `unloadUnusedTabs()`
  reads, and a built graph must not be discarded after a day unselected.
- **What survives a restart is the scope, and nothing derived.**
  `Zotero_Tabs.getState()` serialises `tab.data` wholesale into `session.json`, so `tabData()` is the
  persisted form: `libraryID`, `collectionKey` (null for a selection made outside a collection),
  `itemKeys` (null for a collection graph), `icon`, and the scope options, written back through
  `Zotero_Tabs.setTabData()` whenever they change. See *Graphing a selection*. Edges and layout are **not** stored — a
  graph blob has no honest invalidation key, whereas `pdfLinkCache` (the ~30s phase) and
  `metadataCache` already survive restarts invalidated per input, which leaves a warm rebuild at
  the ~1–2s of phase 1 plus the text strategies.
- **Which teardown a shutdown wants depends on its reason.** `Zotero.Session.save()` snapshots the
  tab strip *synchronously* from the `quit-application-granted` observer, which fires before the
  `quit-application` that starts plugin shutdown — so at `APP_SHUTDOWN` (reason `2`) the tabs are
  already recorded and closing them would only take work off the restore; the plugin just lets go
  of them (`forgetAll`), after telling each side panel. Every other reason — disable, uninstall,
  upgrade — leaves Zotero running while `resource://zotero-citation-graph/` stops resolving under a live
  page, so those tabs are closed outright, unmounted ones included: a `graph` entry left in
  `session.json` for a Zotero with no hook is exactly the `tabs.js:611` throw above. Installing a
  new build therefore closes the open graphs, which is the cost of never stranding an entry.
- **The tab type must not contain a hyphen** — `parseTabType()` splits on `-` to separate the
  `-unloaded` state suffix. `graph-unloaded` and `graph-loading` are core's suffixes on it, not
  new types.
- **A build that ends empty must still stamp its payload `phase: 'done'`.** The renderer reads any
  other phase as work in flight (`stats-building`, and the gap list's "still building"), so an
  empty collection that pushed `phase: 'items'` claimed to be building forever over a canvas
  nothing was ever going to arrive on. The empty payload carries `meta.empty` instead, which is
  what `#empty` paints — including whether offering "include subcollections" would change anything.
- **Never read `ctx.collectionTreeRow`** in a menu handler; core defines it as a getter that throws.
  Use `ctx.collectionTreeRows`. That holds for both entries: the item menu's context
  (`zoteroPane.js`, target `main/library/item`) carries the same throwing getter beside `items`.
- **Two caches, invalidated differently, and the difference is the point.** `pdfLinkCache`
  stamps entries with `size:mtime`, because a PDF's links change only when the file does.
  `metadataCache` ages out after 30 days, because a citation count changes continuously and
  nothing local can detect it. Copying the stamping approach would have cached counts forever.
- **The build runs in four phases, each pushing a payload.** Nodes appear instantly, text-derived
  edges after ~1–2s, PDF-hyperlink edges after ~30s on a cold cache, and names/counts last of
  all — it is the only network phase, so a failure there costs labels and nothing else. One
  combined build would mean staring at an empty tab for half a minute on first open. The renderer reuses node objects across
  pushes so later phases add edges to a settled layout instead of restarting the simulation.
- **`force-graph`'s `init()` does `container.innerHTML = ''`.** Anything nested inside `#graph` is
  deleted when the graph initialises, which is why `#status`, `#action` and `#menu` are siblings.
- **force-graph pauses its own redraw loop once the simulation has cooled** (`autoPauseRedraw`), so
  a purely visual change — isolating a node changes nothing but the colour accessors — would not
  appear until something else moved the canvas. Re-setting any visual accessor is what marks it
  dirty; `repaint()` re-sets `nodeCanvasObject`, and everything that changes what is lit —
  `setIsolated()`, the depth box — goes through it.
- **An author `display:` rule beats the UA stylesheet's `[hidden] { display: none }`.** Every
  floating element here is shown and hidden through the `hidden` attribute and is laid out with
  `display: flex`, so each one needs its own `#id[hidden] { display: none }` or it is simply always
  on screen — with the code that "hides" it setting an attribute nothing reads. `#group` shipped
  without one: the card was up from the moment the tab opened, and its Done button did nothing
  visible. `npm test` now asserts the pairing for every id the page hides.
- **The filter box is a factory, instantiated twice.** The panel's mask stack and a group's
  differ in one thing only — what the masks are FOR — so `filterBox()` owns the whole gesture
  (commit into a chip, widen it with the next pick, click it back into the box, backspace to lift
  it) and each owner supplies its elements, an `onChange`, and `candidates(skip)`: the facets
  completions are drawn from, with the mask being widened left out. The completion list itself is
  one shared DOM node with a `suggestBox` pointer, which is sound precisely because only one box
  can hold the focus. Escape inside a box closes the list, then the edit, then the text — and once
  there is nothing left in there to close it is let through, so the card wrapping the second box
  can still be shut with it.
- **A group is a force, not a filter.** `groupOf` maps a node id to the point its groups pull it
  to, recomputed only when the anchors or the drawn nodes change — never per tick, since a mask
  match is a string comparison per facet per filter and the force runs over every node sixty times
  a second. `facetCache` is what makes that cheap: render() keeps the facets of the nodes it drew,
  so re-matching an anchor costs no rebuild. Each anchor carries its own strength, so what the map
  holds is a point *and* a `k`: two springs on one body are one spring at their weighted centre
  pulling as hard as the two together, which is both what the arithmetic gives and the honest
  picture of belonging to both. The summed `k` is capped at 1 — a node moves `k * (1 - 0.3)` of the
  way to its target each tick, so past about 1.4 the step overshoots by more than the velocity
  decay takes back and the node rings around its flag forever. An anchor at zero strength is left
  out of the map entirely rather than recorded with `k = 0`, because `centerPull()` withholds
  itself from anything the map mentions and its papers would otherwise be held by neither force.
- **Planting an anchor reheats; closing an empty card must not.** A group asks nodes to travel,
  sometimes the width of the graph, so `groupsChanged()` calls `d3ReheatSimulation()` outright
  rather than shedding down to a drop's alpha the way unpinning does. But it first compares the
  new assignment against the old and returns early when nothing is being pulled anywhere new —
  otherwise opening the card and thinking better of it would shake a settled layout for nothing.
- **What is lit is a breadth-first walk, cached.** `lit()` maps every node within `isolateDepth`
  edges of a focus node to the distance it was reached at, and is read once per node and once per
  link on every frame — so it is computed once and thrown away only when the focus set, the depth
  or the graph itself changes. The distance is not bookkeeping: it is what lets a link tell
  whether it is one of the edges walked to get somewhere or a rung between two fringe nodes.
- **d3-drag ends a gesture on _any_ mouseup that reaches the window.** Its handler is registered
  on the view rather than the canvas and never looks at `event.button`, so the right button coming
  up while the left is carrying a node drops it — and the layout then pulls the node away from the
  spot being aimed at, which is precisely what pinning exists to prevent. `guardDrag()` swallows
  every non-zero button while `dragNode` is set, on `window` in the capture phase: d3 re-registers
  its window listeners on each mousedown, so a listener registered at load always runs ahead of it.
  The one exception is the right button's *mouseup*, which is let through so the drag ends cleanly
  and is noted in `menuOnDrop` on the way past — force-graph will not raise its own right-click for
  it, because it suppresses clicks that end a drag. `onNodeDragEnd` then opens the menu and takes
  the `hold()`. A stuck `dragNode` would swallow every right-click for the rest of the session, so
  it has two ways back: the primary button coming up, and any mousemove without it down.
- **A flag takes its press in the capture phase.** The two layers underneath it both want that
  press: d3-zoom, on the canvas, reads a left drag as a pan, and force-graph's own pointer
  bookkeeping, on the container, raises a background click on the way up and clears the isolation.
  So `flagDown()` and the rest are registered on the container at load with `capture` set — which
  reaches the canvas's listeners before they run — and swallow with `stopImmediatePropagation()`,
  because force-graph's are on that same container and were registered later, when the graph was
  built. The compatibility mouse events are swallowed too while a drag is live: d3-zoom listens for
  `mousedown` rather than `pointerdown`, so a browser that does not suppress them on a prevented
  `pointerdown` would pan the canvas out from under the flag being dragged. Which gesture it was
  is decided on the way up — 4px of travel and the anchor moved, less and it was a click asking for
  the flag's menu — and only the drop calls `groupsChanged()`, since pulling the papers along
  would mean reheating the layout on every frame of the drag.
- **A hold is a pin the user has not agreed to yet** — the same `fx`/`fy`, worn only while the menu
  offering to make it permanent is open, and deliberately undrawn, since the ring means "this node
  is staying". `isPinned()` excludes it, so the entry reads `Pin node here` rather than `Unpin`.
  Every exit from the menu runs through `hideMenu()`, which is the one place the hold is given up;
  picking `Pin node here` releases and then re-fixes the node at coordinates nothing has had a
  chance to change.
- **force-graph's drag handler restores `fx`/`fy` to whatever they were before the drag**, rather
  than always clearing them. That is what gives pinning its two gestures for free: dragging a
  pinned node moves its pin, and dragging an unpinned one still releases it on drop. Pinning
  itself is nothing but `fx = x; fy = y` — d3 then holds the node and zeroes its velocity each
  tick, and the custom forces only ever touch `vx`/`vy`, so none of them can drag a pin off its
  spot.
- **There is no `onNodeDoubleClick`.** force-graph does not expose one, but it *does* unbind
  d3-zoom's `dblclick.zoom`, so the DOM `dblclick` on the container is free to use. Which node it
  refers to comes from force-graph's own hit test, via `onNodeHover` — more reliable than timing
  two clicks. The pair of `onNodeClick`s underneath still runs, and because isolating is a toggle
  they cancel out: the second click clears the focus the first one set, so double-clicking a node
  leaves the isolation exactly as it found it.
- **Two classes of control, and the difference matters.** Scope (subcollections, outside
  refs) changes what gets *derived*, so it sends a `rebuild` to chrome and costs a full pass.
  Everything else — confidence, strategy toggles, colour-by, cited-by threshold, filter masks —
  filters an already-built graph in the content page and is instant however expensive the build
  was. A filter mask holds several values that OR; masks AND, which is what keeps stacking them a
  narrowing operation. Filter masks are applied to the held items *before* the edge pass, so a masked-out paper
  cannot keep an outside reference alive; `inCollection` still spans every item, because that set
  is identity — it is what tells a held work from a ghost — and not visibility.
- **External node keys are namespaced (`doi:…`).** Zotero item keys are 8 uppercase alphanumerics
  and contain no colon, so the two can never collide and share one key space — which is what lets
  held and outside works live in a single edge list.
- **The citing side of an edge is always a collection item.** `graphBuilder` drops any edge whose
  source it does not hold, even with `includeExternal`; an edge between two works you do not have
  says nothing about this library.
- **PDF link annotations must be parsed from raw bytes.** pdf.js is not reachable from chrome JS,
  and Zotero has no link annotation type. `resource://zotero/pako.js` is available for
  FlateDecode. Do **not** use `TextDecoder('latin1')` — it aliases windows-1252 and corrupts
  0x80–0x9F; use chunked `String.fromCharCode.apply`.

## Tests

```bash
npm test                 # CommonJS loader + end-to-end derivation against a stub adapter
node tools/cli.js --list
node tools/cli.js --data-dir "C:/Users/you/Zotero" --db ./z.sqlite --offline
node tools/cli.js --data-dir "C:/Users/you/Zotero" --enrich    # names the outside works
node tools/cli.js --data-dir "C:/Users/you/Zotero" --db ./z.sqlite --offline \
    --include-external --clusters                             # the subfield map
```

Copy `zotero.sqlite` before pointing the CLI at it — Zotero holds a write lock while running.

## Licence

**GNU Affero General Public License v3.0 or later** (`LICENSE`).

AGPL rather than something permissive because the plugin carries Zotero's own
material: `content/icons.js` holds the SVG path data of sixteen menu icons
copied verbatim out of `zotero/zotero`, which is AGPL-3.0. Matching Zotero's
licence is also what keeps the door open for the way this project is built —
reading Zotero's source and adapting from it, as `docs/external-references.md`
does throughout. The network clause is inert for a desktop plugin.

Zotero does not require plugins to be AGPL ([forum thread][zplugin]; Better
BibTeX is ISC). It is this repository's own copying that decides it.

Third-party material, and the notices their licences require, are in
[`addon/THIRD-PARTY-NOTICES.md`](../addon/THIRD-PARTY-NOTICES.md) — which ships
inside the XPI, because MIT and ISC both require the notice to travel with the
distribution. In short:

| What | Where | Licence |
|---|---|---|
| force-graph 1.51.4 + its bundled d3 modules | `addon/content/lib/force-graph.min.js` | MIT / ISC |
| Sixteen Zotero menu icons | `addon/content/icons.js` | AGPL-3.0, © Corporation for Digital Scholarship |
| Everything else | | AGPL-3.0-or-later, © 2026 Jakob Holz |

Zotero is a registered trademark of the Corporation for Digital Scholarship.
This plugin is independent and is not affiliated with, endorsed by, or
sponsored by them.

[zplugin]: https://forums.zotero.org/discussion/125352/
