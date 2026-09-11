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

**Only 11 of 27 edges carry a DOI in the citing text.** A DOI-only strategy is
capped at 41% recall no matter how well it is implemented. That ceiling is the
point of the set.

**Six edges carry neither a DOI nor a title.** All six are `barry2020`, whose
Reviews of Modern Physics reference list is pure author-year — `Hahn, E. L.,
1950, Phys. Rev. 80, 580`. Title matching and DOI extraction both score exactly
zero on that source, though it genuinely cites six works in the set. Nothing
short of parsing author-year-journal-volume-page reaches them, which puts the
combined DOI-or-title ceiling at 21 of 27 (78%).

**Two edges carry a title that exact matching still misses**, because PDF text
extraction damaged it:

- `sturner2019 → rondin2014` — the title is **truncated** in the citing PDF:
  "Magnetometry with nitrogen-vacancy defects in", with "diamond" missing. Only
  the DOI resolves it.
- `dolde2011 → gruber1997` — the spacing is **mangled**: "scanningconfocal
  optical microscopyand magnetic resonance on single defect centers". Neither
  normalised exact matching nor the DOI (absent) resolves it.

So the realistic title-match ceiling is 19 of 27, not the 20 that carry a title.

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

## Extending it

Add the item to the collection in the test profile, then add the work to
`works` and its outgoing edges to `edges` — including `doi`/`title`/`authorYear`
for each, since those flags are what make per-strategy ceilings computable rather
than guessed. Read the citing PDF's reference list; do not resolve the references
through a metadata API, or the answer key stops being independent of the thing it
measures.

If a probe flags a pair you then reject, put it in `expectedNonEdges` with the
reason. The rejected matches are worth as much as the accepted ones.
