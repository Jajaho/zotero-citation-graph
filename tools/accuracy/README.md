# The ground-truth collection

A hand-built citation graph for measuring how well the edge strategies in
`addon/citation-graph/edges/` actually find references. It lives in a separate
Zotero profile so it can be opened, rebuilt and thrown at the plugin without
touching a real library.

- **Profile** — `C:\Users\you\Zotero citation_graph_testing`
- **Collection** — `Citation Graph Benchmark` (13 items)
- **Answers** — [`ground-truth.json`](ground-truth.json), beside this file

Run Zotero against that profile with `zotero.exe -datadir "C:\Users\you\Zotero citation_graph_testing"`.

## An edge is not a reference

This trips people up, so it is worth stating before anything else. **An edge is a
citation from one work in the collection to another work in the collection.**

These 12 papers cite **931 works** between them. Only **29** of those references
point at a work the collection also holds; those 29 are the edges. Every other
reference lands on a ghost node outside the collection, and the key says nothing
about it — that is what `docs/external-references.md` is about, not this.

So:

| work | references | edges | ghosts |
|---|---|---|---|
| `barry2020` | 454 | 6 | 448 |
| `rondin2014` | 148 | 3 | 145 |
| `barry2016` | 59 | 1 | 58 |
| `sarkar2023` | 54 | 6 | 48 |
| `sturner2019` | 35 | 5 | 30 |

Barry 2020's 6 and Stürner's 5 are **complete counts of their in-collection
citations**, not a sample of their bibliographies. A 12-work collection cannot
have more than 132 possible directed pairs, and chronology rules out most of
those before anything is read.

This also means recall figures depend on getting those 29 exactly right: recall
is `TP / 29`, so a key that missed true edges would silently inflate every score
in the table. Hence the completeness check below.

## Completeness, checked against Crossref

The edge list was verified on 2026-09-11 against **Crossref's deposited
reference lists** — independent of the hand reading, and deliberately not
OpenAlex, which is one of the strategies being graded.

For all ten source works that have a DOI, the in-collection targets Crossref
reports match this key exactly, work for work:

```
sarkar2023 6 · sturner2019 5 · zhang2022 4 · barry2020 6 · rondin2014 3
barry2016 1 · dolde2011 1 · hahn1950 0 · dreau2011 2 · gruber1997 0   = 28
+ odmrManual 1 (no DOI; hand-read from its PDF)                       = 29
```

No edge missing, none invented. The `refCount` values in the key are Crossref's
exact figures, replacing the bracket-number estimates the first version carried
(which had `barry2016` at 75 against an actual 59, and `hahn1950` at 0 against
an actual 19).

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

`dolde2011 → gruber1997` is the **one edge no PDF-derived channel reaches**: its
printed title is mangled, its entry prints no DOI, and Dolde 2011 has zero link
annotations. Every offline strategy misses it; `openalex` finds it, which is the
sharpest single illustration of why the network layer is worth having.

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

## Two tiers, known to two standards

| | tier 1 | tier 2 |
|---|---|---|
| file | `ground-truth.json` | `external-refs.json` |
| covers | 29 citations **between** the 12 held works | 809 works they cite and the collection does **not** hold |
| built by | hand, from each citing PDF | machine, from Crossref deposited reference lists |
| exhaustive? | yes — cross-checked against Crossref | **no** — publishers deposit incomplete lists |
| a wrong edge is | a false positive | *not* judged; reported as `unconf` |

Tier 1 is small enough to be complete, so it can call a strategy wrong. Tier 2
is 28× bigger and gives the external-facing strategies — `ref-strings` and
`openalex`, which mint ghost nodes — something to be measured against, but it
cannot prove a negative.

**Presence is reliable, absence is not.** If Crossref says A cites X, A cites X.
The converse fails: `barry2016` prints 75 numbered references and Crossref holds
59, so a third of that paper's real citations are missing from the set through
no fault of any strategy. Tier-2 recall is therefore a **lower bound**, and an
emitted DOI that is not in the set is counted as `unconf`, never as an error.

Two things *are* graded as defects, because both are provable despite the
incompleteness:

- **suffix artifact** — stripping a URL tail (`/abstract`, `/epdf`, `/full`,
  `/pdf`, `/meta`, `/html`) turns the emitted string into a DOI that **is** in
  the set. So the emitted one names nothing and the real one was missed.
- **truncated** — the emitted DOI is a strict prefix of one in the set.

Both mint a ghost node for a work that does not exist under that identifier,
which is worse than a missing edge: it is a node nobody cited.

Crossref is deliberately not one of the graded strategies — the graded network
one is OpenAlex — so tier 2 stays independent of what it measures, the same rule
tier 1 follows.

## Running it

```
npm run accuracy -- --data-dir "C:/Users/me/Zotero citation_graph_testing"
npm run accuracy -- --data-dir <dir> --db ./snap.sqlite      # Zotero running
npm run accuracy -- --data-dir <dir> --enable openalex --api-key KEY
npm run accuracy -- --data-dir <dir> --report REPORT.md --json baseline.json
npm run accuracy -- --data-dir <dir> --baseline baseline.json
npm run accuracy -- --data-dir <dir> --no-external           # tier 1 only
npm run accuracy:external                                    # rebuild tier 2
```

Zotero holds a write lock on `zotero.sqlite` while it runs, so point `--db` at a
copy if it is open.

`.crossref-cache/` (the raw deposited reference lists) and
`.openalex-doi-cache.json` are committed on purpose: with them, everything
except the `openalex` strategy itself scores with no network at all, and tier 2
is rebuildable byte-for-byte rather than being whatever Crossref returns today.

`openalex` returns its references as OpenAlex work IDs, not DOIs, so scoring it
against tier 2 needs an ID→DOI map. That resolution is cached in
`.openalex-doi-cache.json` and is **identity only** — which DOI is `W123`. The
truth about who cites whom stays Crossref's. `--no-resolve` skips it and scores
from the cache alone.

## The report

`--report <file.md>` writes a report; `--json <file>` writes the same run
machine-readably, and `--baseline <that file>` compares a later run against it.
`REPORT.md` and `baseline.json` in this directory are the committed current
standing, so a change in strategy code shows up as a diff.

The report leads with the conditions, because a score without them cannot be
compared with a score taken later. It records the commit and whether the tree
was dirty, node and OS versions, the **sha256 of the database and of the PDF
set**, the sha256 and size of both answer keys, whether the network was used and
whether an API key was supplied, and every strategy's confidence and full
options object as it actually ran.

That is what makes a comparison honest rather than hopeful. If the dataset hash
or the key hash moved between two runs, the report says so above the diff and
warns that the difference is not attributable to the code — which is exactly the
mistake a benchmark is otherwise built to invite.

Scoring is at **work** level. The collection holds one work twice on purpose; an
item-level count would let a strategy score the same citation twice and would
punish one that correctly merged the duplicate. An edge between the two copies
collapses to a self-loop and is reported on its own `dup` column rather than as
a false positive — that is a duplicate-merging failure, not a wrong citation.
Edges to works the collection does not hold are counted as `ghost` and never
graded, since the key says nothing about them.

## Where the strategies stand

Measured 2026-09-11, all five strategies (`openalex` anonymous, no API key):

```
strategy        pred   TP   FP   FN   prec  recall  rec/pdf     F1  dup  traps
pdf-links         18   18    0   11   100%     62%      67%   0.77    0  -
text-doi           7    7    0   22   100%     24%      26%   0.39    0  -
title-match       19   19    0   10   100%     66%      70%   0.79    0  -
ref-strings       13   13    0   16   100%     45%      48%   0.62    0  -
openalex          28   28    0    1   100%     97%      96%   0.98    0  -
ALL (union)       29   29    0    0   100%    100%     100%   1.00    0  -
```

`recall` is against all 29 edges; `rec/pdf` against the 27 a PDF-reading
strategy can actually reach.

**Precision is 100% for every strategy.** No trap was hit, no edge touching the
`adam2017` negative control was emitted, and the duplicated work was never split
into a self-loop. The substring collisions the set was built to catch — "spin
echoes" inside another reference's title, the two wrong "Zhang"s — are all
correctly declined.

**Offline recall is channel-bound, and two strategies are already at their
ceiling.** `pdf-links` finds 18 of the 18 link-annotated edges; `title-match`
finds 19 of the 19 exact-matchable titles. Neither improves without a new
channel or fuzzy matching.

**`openalex` is the strongest single strategy: 97% recall at perfect
precision.** It reaches both populations the PDFs cannot — the two edges whose
citing work is held without a PDF, and `dolde2011 → gruber1997`, whose printed
title is too mangled for exact matching. Its one miss is `odmrManual →
dolde2011`: the lab manual has no DOI, so OpenAlex cannot identify it as a
source at all.

**The two are complementary, and the union is complete.** That single OpenAlex
miss is found by three offline strategies, so together they score 29 of 29 at
100% precision. This is the measured version of the claim in
`edges/openalex.js`'s own docstring — neither layer subsumes the other, and the
one that fails is the one whose identifier is missing.

### Tier 2: the outside world

```
strategy      emitted by namespace        TP  missed  unconf  defects  recall ≥
pdf-links     doi 516                    485     324      16        4       60%
text-doi      doi 55                      37     772       5        2        5%
title-match   —                            0     809       0        0        0%
ref-strings   doi 44, ref 118, arxiv 4    37     772       7        2        5%
openalex      openalex 1025              804       5      77        0       99%
```

`title-match` contributes **nothing** outside the collection, by construction —
it can only match a title the library already holds. That is the systematic hole
`ref-strings` exists to fill, and the tier-2 row is the first measurement of how
well it does: 118 `ref:` nodes for works no identifier was printed for, which no
other offline strategy can see at all.

**`openalex` finds 804 of 809 at 99%** — unsurprising, since reference lists are
what it is. The interesting number is its 77 `unconf`: OpenAlex knows citations
Crossref's deposits do not, which is the same incompleteness that caps everyone
else's apparent recall.

**Its 1025 external nodes are keyed `openalex:W…`, not `doi:`.** In a default
build the same cited work is therefore *two* ghost nodes — `doi:10.x` from
`pdf-links` and `openalex:W…` from `openalex` — until the metadata lookup runs
and resolves them. `edges/openalex.js` says as much in its own comment; tier 2
puts a number on it.

### Six defects, all in DOI extraction

The benchmark grades only provable defects, and found six:

| strategy | defect | emitted | should be |
|---|---|---|---|
| `pdf-links` | suffix | `10.3389/fncom.2013.00137/abstract` | `10.3389/fncom.2013.00137` |
| `pdf-links` | truncated | `10.1002/1521-396x(200009)181:1` | `…181:1<99::aid-pssa99>3.0.co;2-5` |
| `pdf-links` | truncated | `10.1002/1521-396x(200108)186:2` | `…186:2<187::aid-pssa187>…` |
| `pdf-links` | truncated | `10.1002/(sici)1521-396x(199903)172:1` | `…172:1<25::aid-pssa25>…` |
| `text-doi`, `ref-strings` | truncated | `10.1038/lsa` | `10.1038/lsa.2016.32` |
| `text-doi`, `ref-strings` | truncated | `10.1063/1` | `10.1063/1.4823548` |

Three causes, all in `core/normalize.js`:

1. **`normDoi` does not strip URL tails.** A Frontiers link is
   `https://doi.org/10.3389/fncom.2013.00137/abstract`; the tail is part of the
   URL, not of the DOI.
2. **`DOI_RE` stops at `<`.** Pre-2005 Wiley DOIs embed `<...>`
   (`10.1002/1521-396X(200009)181:1<99::AID-PSSA99>3.0.CO;2-5`), so every one of
   them is cut at the angle bracket.
3. **Line breaks inside a DOI**, the same fault as the tier-1 `text-doi` gap:
   `flattenPdfText` rejoins wrapped lines with a space, and `10.1038/` + `lsa…`
   on the next line becomes `10.1038/ lsa…`, so the match ends early.

A truncated DOI is not a near miss. It is a node in the graph that no work
anywhere has, permanently unresolvable by any enricher.

### OpenAlex corrected the answer key

On its first run `openalex` produced two edges the key called false positives,
both from `dreau2011`. Both turned out to be **real**: Crossref's deposited
reference list for `10.1103/PhysRevB.84.195204` contains 38 references including
Dolde 2011 and Gruber 1997. The key had missed them because it was built by
reading citing PDFs, and `dreau2011` is held without one — a blind spot in the
method, not a wrong reading.

They are now in the key, marked `citingPdfHeld: false` and
`verifiedVia: crossref-deposited-references`, and the scorer reports recall
against both populations so no offline strategy is marked down for a citation it
had no way to read. Gruber 1997's own deposited list (29 references) cites
nothing in the set, so those two are the complete correction.

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
