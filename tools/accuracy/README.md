# The ground-truth collection

A hand-built citation graph for measuring how well the edge strategies in
`addon/citation-graph/edges/` actually find references. It lives in a separate
Zotero profile so it can be opened, rebuilt and thrown at the plugin without
touching a real library.

- **Profile** — `C:\Users\you\Zotero citation_graph_testing`
- **Collection** — `Citation Graph Benchmark` (13 items)
- **Answers** — [`ground-truth.json`](ground-truth.json), beside this file

Run Zotero against that profile with `zotero.exe -datadir "C:\Users\you\Zotero citation_graph_testing"`.

## What "ground truth" means here, and what it is not

Every edge in the JSON was read out of the **citing PDF's own reference list**.
Nothing in it came from OpenAlex, Crossref, or any of the strategies being
measured — using a metadata API to build the answer key would score
`edges/openalex.js` against itself and tell us nothing.

Each candidate pair was put through four independent probes — the DOI string,
the full title, the bibliographic signature (author/journal/volume/page), and
author-plus-year proximity — and then every hit and every near-miss was read in
context and accepted or rejected by hand. Four pairs that one probe flagged are
recorded as **non**-edges because reading them showed the match was spurious;
they are in the file as `expectedNonEdges`, because a benchmark that only lists
what should be found cannot measure precision.

## The set

12 works in 13 items. Eleven have a PDF and can act as a source; two are
target-only.

| work | year | role | why it is in the set |
|---|---|---|---|
| `sarkar2023` | 2023 | source, 6 out | IEEE style: numbered, titles, DOI on only some entries |
| `sturner2019` | 2019 | source, 5 out / 3 in | Elsevier: DOI on every entry. Also carries a **second PDF** (supplementary) with its own 4 references |
| `zhang2022` | 2022 | source, 4 out | the clean case — DOI *and* title on every edge |
| `barry2020` | 2020 | source, 6 out / 2 in | **author-year with no titles and no DOIs**; ~475 references |
| `rondin2014` | 2014 | source, 3 out / 3 in | numbered with titles, no DOIs; 150 references |
| `barry2016` | 2016 | source, 1 out / 4 in | PNAS numbered; page numbers broken by extraction |
| `dolde2011` | 2011 | source, 1 out / 5 in | **held twice** — the duplicate case |
| `hahn1950` | 1950 | source, 0 out / 1 in | pre-reference-section paper; two-word title, a false-positive magnet |
| `odmrManual` | — | source, 1 out | a lab-course **report**: no DOI, no creators, not a publisher PDF |
| `dreau2011` | 2011 | **target only** (no PDF), 6 in | most-cited work in the set; Zotero says first author "Rondin", every citation says "Dréau" |
| `gruber1997` | 1997 | **target only** (no PDF), 3 in | Zotero says "Wrachtrup", every citation says "Gruber" |
| `adam2017` | 2017 | **negative control**, 0 in / 0 out | machine learning, in a physics set |

`adam2017` was already in the profile. It stays because it is the cleanest
precision test available: it shares no domain with anything else here, so any
edge touching it is provably wrong. Verified both directions — no fulltext among
the source library's 485 indexed attachments mentions "Kingma" or "stochastic
optimization", and Adam's own 23 references name no NV work.

## What the set is designed to separate

The reference lists deliberately span the formats real libraries contain, so the
strategies cannot all score the same:

A citation reaches a strategy through one of **three independent channels**, and
every edge in the key is flagged for all three:

| channel | flag | edges | what it is |
|---|---|---|---|
| printed DOI | `doi` | 11 of 27 | a DOI visible in the extracted reference text |
| printed title | `title` | 20 of 27 | the target's title visible in that text |
| link annotation | `pdfLink` | 18 of 27 | a `/URI` annotation on the reference — invisible to a reader |

The channels are **not** nested, which is the whole point of the set. The link
layer in particular carries citations the printed page does not.

**Only 11 of 27 edges print a DOI**, so a strategy reading printed text for
identifiers is capped at 41% recall however well it is written.

**Six edges print neither a DOI nor a title.** All six are `barry2020`, whose
Reviews of Modern Physics reference list is pure author-year — `Hahn, E. L.,
1950, Phys. Rev. 80, 580`. Nothing in that printed entry names the work.

But that same PDF carries **435 `/URI` annotations**: every one of those six
references *is* DOI-linked in the link layer. So they are reachable without any
author-year parsing at all, and `pdf-links` finds all six. An earlier version of
this file claimed a 78% ceiling on the assumption that they were unreachable;
that was wrong, because it only considered the printed text. The real ceiling
across all three channels is **26 of 27 (96%)**.

The `pdfLink` flags were extracted from raw PDF bytes by an independent parser
(inflating object streams and reading `/URI` dictionaries), not from
`edges/pdfLinks.js` output — same rule as the rest of the key.

**Two edges carry a title that exact matching still misses**, because PDF text
extraction damaged it:

- `sturner2019 → rondin2014` — the title is **truncated** in the citing PDF:
  "Magnetometry with nitrogen-vacancy defects in", with "diamond" missing. Only
  the DOI resolves it.
- `dolde2011 → gruber1997` — the spacing is **mangled**: "scanningconfocal
  optical microscopyand magnetic resonance on single defect centers". Neither
  normalised exact matching nor the DOI (absent) resolves it.

So the realistic title-match ceiling is 19 of 27, not the 20 that carry a title.

`dolde2011 → gruber1997` is the **one edge no current channel reaches**: its
printed title is mangled, its entry prints no DOI, and Dolde 2011 has zero link
annotations. It is the 1 of 27 that the full union still misses, and the
standing argument for fuzzy title matching.

**One edge is cited twice under two identities.** `sarkar2023` cites
`barry2020` at ref [21] as `arXiv:1903.08176` and again at ref [44] as
`Rev. Mod. Phys. 92, 015004` — preprint and version of record in one reference
list. It must collapse to one edge.

**One work is held twice.** `dolde2011` is two Zotero items with the same DOI
and a byte-identical PDF. Scored at work level the set has 27 edges; an item-level
scorer that expands the duplicate on both sides sees 33. That six-edge gap is the
duplicate-merging penalty, and it is why `summary.edgesItemLevel` is recorded
alongside `summary.edges`.

## The traps

`expectedNonEdges` records pairs that look like edges and are not. Three are
substring collisions that a naive matcher will emit:

- **`dolde2011 → hahn1950`** — "spin echoes" really does appear in dolde2011's
  reference list, inside *another* reference's title: "van Oort, E. et al.
  Electric field induced modulation of **spin echoes** of NV centers in diamond".
  Matching the two-word title `Spin Echoes` as a substring produces a false edge.
- **`barry2020 → zhang2022`** and **`rondin2014 → zhang2022`** — both cite a
  "Zhang", neither is *this* Zhang, and both are chronologically impossible.
- **`zhang2022 → sarkar2023`** — cites a different paper in the same journal
  (IEEE TIM), also chronologically impossible.

A cheap and effective guard falls out of the last three: **a work cannot cite
one published after it.** Three of the five false positives found while building
this set are killed by a year comparison alone.

The fifth trap is for whoever extends the set: `barry2020 → gruber1997` looks
like it must exist — a 475-reference NV review that does not cite the 1997 paper
that started single-defect microscopy is surprising. It does not. The string
"gruber" occurs zero times in that PDF. It is recorded because the tempting
correction is to add the edge from memory, and that would corrupt the answer key.

## Running it

```
node tools/accuracy/score.js --data-dir "C:/Users/me/Zotero citation_graph_testing"
node tools/accuracy/score.js --data-dir <dir> --db ./snap.sqlite   # Zotero running
node tools/accuracy/score.js --enable openalex --api-key KEY
node tools/accuracy/score.js --json out.json
```

Zotero holds a write lock on `zotero.sqlite` while it runs, so point `--db` at a
copy if it is open.

Scoring is at **work** level. The collection holds one work twice on purpose; an
item-level count would let a strategy score the same citation twice and would
punish one that correctly merged the duplicate. An edge between the two copies
collapses to a self-loop and is reported on its own `dup` column rather than as
a false positive — that is a duplicate-merging failure, not a wrong citation.
Edges to works the collection does not hold are counted as `ghost` and never
graded, since the key says nothing about them.

## Where the strategies stand

Measured 2026-09-11, offline strategies only:

```
strategy        pred   TP   FP   FN   prec  recall     F1   dup  traps
pdf-links         18   18    0    9   100%     67%   0.80     0  -
text-doi           7    7    0   20   100%     26%   0.41     0  -
title-match       19   19    0    8   100%     70%   0.83     0  -
ref-strings       13   13    0   14   100%     48%   0.65     0  -
ALL (union)       26   26    0    1   100%     96%   0.98     0  -
```

**Precision is 100% across the board.** No strategy hit any of the five traps,
none emitted an edge touching the `adam2017` negative control, and none split
the duplicated work into a self-loop. The substring collisions the set was built
to catch — "spin echoes" inside another reference's title, the two wrong
"Zhang"s — are all correctly declined.

**Recall is channel-bound, and two strategies are already at their ceiling.**
`pdf-links` finds 18 of the 18 link-annotated edges; `title-match` finds 19 of
the 19 exact-matchable titles. Neither can improve without a new channel or
fuzzy matching. The union reaches 26 of 27 — everything except the one edge no
channel carries.

**`text-doi` is the one strategy below its ceiling: 7 found of 11 printed.** The
four misses are `sturner2019 → barry2016`, `→ dolde2011`, `→ gruber1997`, and
`odmrManual → dolde2011`, and they share one cause. `flattenPdfText` joins
wrapped lines with a space, so a DOI broken across a line break becomes

```
https://doi.org/10. 1073/pnas.1601513113      (space after "10.")
https://doi.org/10.1038/ nphys1969            (break after the slash)
```

and `DOI_RE` — which wants digits immediately after `10.` and at least one
character after the slash — matches neither. Repairing a break *inside* a DOI
before matching should close the whole gap and take `text-doi` to its 41%
ceiling. Nothing else in the table is currently leaving edges on the table.

## Extending it

Add the item to the collection in the test profile, then add the work to
`works` and its outgoing edges to `edges` — including `doi`/`title`/`authorYear`
for each, since those flags are what make per-strategy ceilings computable rather
than guessed. Read the citing PDF's reference list; do not resolve the references
through a metadata API, or the answer key stops being independent of the thing it
measures.

If a probe flags a pair you then reject, put it in `expectedNonEdges` with the
reason. The rejected matches are worth as much as the accepted ones.
