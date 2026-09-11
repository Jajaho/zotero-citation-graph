# The ground-truth collection

A hand-built citation graph for measuring how well the edge strategies in
`addon/citation-graph/edges/` actually find references. It lives in a separate
Zotero profile so it can be opened, rebuilt and thrown at the plugin without
touching a real library.

- **Profile** — `C:\Users\you\Zotero citation_graph_testing`
- **Collection** — `Citation Graph Benchmark` (15 items)
- **Answers** — [`ground-truth.json`](ground-truth.json), beside this file

Run Zotero against that profile with `zotero.exe -datadir "C:\Users\you\Zotero citation_graph_testing"`.

## An edge is not a reference

This trips people up, so it is worth stating before anything else. **An edge is a
citation from one work in the collection to another work in the collection.**

These 14 papers cite **1512 works** between them. Only **30** of those references
point at a work the collection also holds; those 30 are the edges. Every other
reference lands on a ghost node outside the collection, and the key says nothing
about it — that is what `docs/external-references.md` is about, not this.

So:

| work | references | edges | ghosts |
|---|---|---|---|
| `blais2021` | 527 | 1 | 526 |
| `barry2020` | 454 | 6 | 448 |
| `rondin2014` | 148 | 3 | 145 |
| `barry2016` | 59 | 1 | 58 |
| `sarkar2023` | 54 | 6 | 48 |
| `sturner2019` | 35 | 5 | 30 |

Barry 2020's 6 and Stürner's 5 are **complete counts of their in-collection
citations**, not a sample of their bibliographies. Blais 2021's single edge, out
of 527 references, is the shape in its purest form. A 14-work collection cannot
have more than 182 possible directed pairs, and chronology rules out most of
those before anything is read.

This also means recall figures depend on getting those 30 exactly right: recall
is `TP / 30`, so a key that missed true edges would silently inflate every score
in the table. Hence the completeness check below.

## Completeness, checked against Crossref

The edge list was verified on 2026-09-11 against **Crossref's deposited
reference lists** — independent of the hand reading, and deliberately not
OpenAlex, which is one of the strategies being graded.

For all twelve source works that have a DOI, the in-collection targets Crossref
reports match this key exactly, work for work:

```
sarkar2023 6 · sturner2019 5 · zhang2022 4 · barry2020 6 · rondin2014 3
barry2016 1 · dolde2011 1 · hahn1950 0 · dreau2011 2 · gruber1997 0
magnard2020 0 · blais2021 1                                          = 29
+ odmrManual 1 (no DOI; hand-read from its PDF)                       = 30
```

`magnard2020`'s **zero** is the one to read twice. Crossref's deposit for it
lists 52 DOIs and the Blais review is not among them — which is what makes the
title collision below a non-edge on machine evidence as well as on the reading.

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
context and accepted or rejected by hand. The pairs that one probe flagged and
the reading rejected are recorded as **non**-edges; they are in the file as
`expectedNonEdges`, because a benchmark that only lists what should be found
cannot measure precision.

## The set

14 works in 15 items. Thirteen have a PDF and can act as a source; two are
target-only.

| work | year | role | why it is in the set |
|---|---|---|---|
| `sarkar2023` | 2023 | source, 6 out | IEEE style: numbered, titles, DOI on only some entries |
| `sturner2019` | 2019 | source, 5 out / 3 in | Elsevier: DOI on every entry. Also carries a **second PDF** (supplementary) with its own 4 references |
| `zhang2022` | 2022 | source, 4 out | the clean case — DOI *and* title on every edge |
| `barry2020` | 2020 | source, 6 out / 2 in | **author-year with no titles and no DOIs**; 454 references |
| `rondin2014` | 2014 | source, 3 out / 3 in | numbered with titles, no DOIs; 148 references |
| `barry2016` | 2016 | source, 1 out / 4 in | PNAS numbered; page numbers broken by extraction |
| `dolde2011` | 2011 | source, 1 out / 5 in | **held twice** — the duplicate case |
| `hahn1950` | 1950 | source, 0 out / 1 in | pre-reference-section paper; two-word title, a false-positive magnet |
| `odmrManual` | — | source, 1 out | a lab-course **report**: no DOI, no creators, not a publisher PDF |
| `dreau2011` | 2011 | **target only** (no PDF), 6 in | most-cited work in the set; Zotero says first author "Rondin", every citation says "Dréau" |
| `gruber1997` | 1997 | **target only** (no PDF), 3 in | Zotero says "Wrachtrup", every citation says "Gruber" |
| `adam2017` | 2017 | **negative control**, 0 in / 0 out | machine learning, in a physics set |
| `magnard2020` | 2020 | source, 0 out / 1 in | half of the **cycle pair**: its reference list names a field, not the review of it |
| `blais2021` | 2021 | source, 1 out / 0 in | the other half: a **title that is the bare name of a field**, 31 normalised characters, one past the floor |

`adam2017` was already in the profile. It stays because it is the cleanest
precision test available: it shares no domain with anything else here, so any
edge touching it is provably wrong. Verified both directions — no fulltext among
the source library's 485 indexed attachments mentions "Kingma" or "stochastic
optimization", and Adam's own 23 references name no NV work.

## What the set is designed to separate

The reference lists deliberately span the formats real libraries contain, so the
strategies cannot all score the same:

A citation reaches a strategy through one of **three independent channels**. Each of
the 28 PDF-reachable edges is flagged for all three (the 2 edges from the work
held without a PDF carry none of them):

| channel | flag | edges | what it is |
|---|---|---|---|
| printed DOI | `doi` | 11 of 28 | a DOI visible in the extracted reference text |
| printed title | `title` | 20 of 28 | the target's title visible in that text |
| link annotation | `pdfLink` | 19 of 28 | a `/URI` annotation on the reference — invisible to a reader |

The channels are **not** nested, which is the whole point of the set. The link
layer in particular carries citations the printed page does not.

**Only 11 of 28 edges print a DOI**, so a strategy reading printed text for
identifiers is capped at 39% recall however well it is written.

**Seven edges print neither a DOI nor a title.** Six are `barry2020`, whose
Reviews of Modern Physics reference list is pure author-year — `Hahn, E. L.,
1950, Phys. Rev. 80, 580`. Nothing in that printed entry names the work. The
seventh is `blais2021 → magnard2020`, the same journal and the same style —
`Magnard, P., et al., 2020, Phys. Rev. Lett. 125, 260502.`

But those PDFs carry link layers — 435 `/URI` annotations in barry2020, 515 in
blais2021: every one of those seven references *is* DOI-linked there. So they are
reachable without any author-year parsing at all, and `pdf-links` finds all
seven. An earlier version of this file claimed a 78% ceiling on the assumption
that they were unreachable; that was wrong, because it only considered the
printed text. The real ceiling across all three channels is **27 of 28 (96%)**.

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

So the realistic title-match ceiling is 19 of 28, not the 20 that carry a title.

`dolde2011 → gruber1997` is the **one edge no PDF-derived channel reaches**: its
printed title is mangled, its entry prints no DOI, and Dolde 2011 has zero link
annotations. Every offline strategy misses it; `openalex` finds it, which is the
sharpest single illustration of why the network layer is worth having.

**One edge is cited twice under two identities.** `sarkar2023` cites
`barry2020` at ref [21] as `arXiv:1903.08176` and again at ref [44] as
`Rev. Mod. Phys. 92, 015004` — preprint and version of record in one reference
list. It must collapse to one edge.

**One work is held twice.** `dolde2011` is two Zotero items with the same DOI
and a byte-identical PDF. Scored at work level the set has 28 edges; an item-level
scorer that expands the duplicate on both sides sees 34. That six-edge gap is the
duplicate-merging penalty, and it is why `summary.edgesItemLevel` is recorded
alongside `summary.edges`.

## The traps

`expectedNonEdges` records pairs that look like edges and are not. The sharpest
of them is the only one any strategy has yet fallen for:

- **`magnard2020 → blais2021`** — the **reverse of a real edge**. Blais 2021
  genuinely cites Magnard 2020, so a strategy that draws this one too puts a
  **two-work cycle** in the graph, and the cycle is the symptom a reader notices
  first. Magnard does not cite the Blais review: it is absent from Crossref's 52
  deposited DOIs, absent from the PDF's 65 `/URI` annotations, and "Grimsmo"
  occurs zero times in the file. What the reference list does carry is the phrase
  "circuit quantum electrodynamics", twice, both times inside *another*
  reference's title — "…qubit-resonator coupling in **circuit quantum
  electrodynamics**, Phys. Rev. A 91, 043846" and "Microwave-Controlled
  Generation of Shaped Single Photons in **Circuit Quantum Electrodynamics**,
  Phys. Rev. X 4, 041010". Blais 2021's title is that phrase and nothing else.

  Two guards that catch the other traps both miss this one, which is why the pair
  is in the set. `minTitleLength` does not save it: the normalised title is 31
  characters against a floor of 30. `rejectImpossibleYear` does not either: it
  allows one year of slack for preprint/issue-date mismatches, and 2021 is
  exactly one year past 2020.

Three more are substring collisions that a naive matcher will emit:

- **`dolde2011 → hahn1950`** — "spin echoes" really does appear in dolde2011's
  reference list, inside *another* reference's title: "van Oort, E. et al.
  Electric field induced modulation of **spin echoes** of NV centers in diamond".
  Matching the two-word title `Spin Echoes` as a substring produces a false edge.
- **`barry2020 → zhang2022`** and **`rondin2014 → zhang2022`** — both cite a
  "Zhang", neither is *this* Zhang, and both are chronologically impossible.
  `magnard2020 → zhang2022` and `blais2021 → zhang2022` are the same collision
  again, recorded for the same reason.
- **`zhang2022 → sarkar2023`** — cites a different paper in the same journal
  (IEEE TIM), also chronologically impossible.

A cheap and effective guard falls out of those: **a work cannot cite one
published after it.** Five of the false positives recorded here are killed by a
year comparison alone — but `magnard2020 → blais2021` is not one of them, and
that is the point of it. A one-year slack is the right allowance for a preprint
cited before its journal issue, and it is exactly the window this collision sits
in.

The last trap is for whoever extends the set: `barry2020 → gruber1997` looks
like it must exist — a 475-reference NV review that does not cite the 1997 paper
that started single-defect microscopy is surprising. It does not. The string
"gruber" occurs zero times in that PDF. It is recorded because the tempting
correction is to add the edge from memory, and that would corrupt the answer key.

## Two tiers, known to two standards

| | tier 1 | tier 2 |
|---|---|---|
| file | `ground-truth.json` | `external-refs.json` |
| covers | 30 citations **between** the 14 held works | 1366 works they cite and the collection does **not** hold |
| built by | hand, from each citing PDF | machine, from Crossref deposited reference lists |
| exhaustive? | yes — cross-checked against Crossref | **no** — publishers deposit incomplete lists |
| a wrong edge is | a false positive | *not* judged; reported as `unconf` |

Tier 1 is small enough to be complete, so it can call a strategy wrong. Tier 2
is 45× bigger and gives the external-facing strategies — `ref-strings` and
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

Measured 2026-09-11 on the 14-work set, all five strategies (`openalex`
anonymous, no API key):

```
strategy        pred   TP   FP   prec  recall  rec/pdf     F1  dup  traps
pdf-links         19   19    0   100%     63%      68%   0.78    0  -
text-doi          11   11    0   100%     37%      39%   0.54    0  -
title-match       20   19    1    95%     63%      68%   0.76    0  1
ref-strings       15   15    0   100%     50%      54%   0.67    0  -
openalex          29   29    0   100%     97%      96%   0.98    0  -
ALL (union)       31   30    1    97%    100%     100%   0.98    0  1
```

`recall` is against all 30 edges; `rec/pdf` against the 28 a PDF-reading
strategy can actually reach.

**`title-match` hits a trap, and it is the first false positive this benchmark
has ever recorded.** It draws `magnard2020 → blais2021` from the phrase "circuit
quantum electrodynamics" sitting inside two other references' titles. Precision
95%, and the union's too, because no other strategy corroborates or contradicts
it — `openalex` declines the pair, but a union takes the edge from whoever
emitted it. Since `blais2021 → magnard2020` is real, the graph gets a **cycle
between two works**, which is how this surfaced in an actual library rather than
here.

The earlier reading of this collection — that "precision is 100% for every
strategy" — held only because nothing in the set had a title that was also the
plain name of a field. That is now the thing the set tests.

Every other precision property still holds. No edge touching the `adam2017`
negative control was emitted, the duplicated work was never split into a
self-loop, and the substring collisions the set was built to catch — "spin
echoes" inside another reference's title, the wrong "Zhang"s — are still all
correctly declined.

**Offline recall is channel-bound, and two strategies are at their ceiling.**
`pdf-links` finds 19 of the 19 link-annotated edges, the new one among them;
`title-match` finds 19 of the 19 exact-matchable titles. Neither improves
without a new channel or fuzzy matching. The recall percentages moved by a point
against the previous run only because the denominator grew from 29 to 30.

**`openalex` is the strongest single strategy: 97% recall at perfect
precision.** It reaches both populations the PDFs cannot — the two edges whose
citing work is held without a PDF, and `dolde2011 → gruber1997`, whose printed
title is too mangled for exact matching — and it is the only strategy that both
finds `blais2021 → magnard2020` and refuses the reverse. Its one miss is
`odmrManual → dolde2011`: the lab manual has no DOI, so OpenAlex cannot identify
it as a source at all.

**The two layers are still complementary, and the union still finds everything.**
That single OpenAlex miss is found by three offline strategies, so together they
score 30 of 30 — now at 97% precision rather than 100%, the one wrong edge being
the trap. Neither layer subsumes the other, and the one that fails is the one
whose identifier is missing.

### Tier 2: the outside world

```
strategy      emitted by namespace        TP  missed  unconf  defects  recall >=
pdf-links     doi 1068                  1039     327      18        0       76%
text-doi      doi 70                      50    1316       7        1        4%
title-match   -                            0    1366       0        0        0%
ref-strings   doi 57, ref 154, arxiv 7    50    1316      12        0        4%
openalex      openalex 1845             1357       9     195        0       99%
ALL (union)   -                         1366       0     209        1      100%
```

Adding two APS papers with 581 deposited references between them nearly doubled
this tier, and `pdf-links` took most of the gain: 489 → 1039 confirmed external
DOIs, 60% → 76% recall. That is the link layer doing what it does — Blais 2021
prints no DOIs at all and hyperlinks 505 of them.

`title-match` contributes **nothing** outside the collection, by construction —
it can only match a title the library already holds. That is the systematic hole
`ref-strings` exists to fill: 154 `ref:` edges resolving to 130 distinct nodes,
for works no identifier was printed for at all — which no other offline strategy
can see.

**`openalex` finds 1357 of 1366 at 99%** — unsurprising, since reference lists
are what it is. The interesting number is its 195 `unconf`: OpenAlex knows
citations Crossref's deposits do not, which is the same incompleteness that caps
everyone else's apparent recall.

**Its 1845 external nodes are keyed `openalex:W…`, not `doi:`.** In a default
build the same cited work is therefore *two* ghost nodes — `doi:10.x` from
`pdf-links` and `openalex:W…` from `openalex` — until the metadata lookup runs
and resolves them. `edges/openalex.js` says as much in its own comment; tier 2
puts a number on it.

### A seventh DOI defect, not yet fixed

The two new PDFs brought one with them, in `text-doi`:

| defect | emitted | cause |
|---|---|---|
| truncated | `10.1103/physrevlett` | a space inside the DOI, from `magnard2020` |

Magnard's supplemental-material note prints
`http://link.aps.org/supplemental/10.1103/PhysRevLett .125.260502` — extraction
put a space before `.125`, so `findDois` stops at `10.1103/physrevlett` and
mints a ghost node under a string that names nothing. (The scorer's "should be"
column reports whichever set member that prefix matches first, which is *not*
the right DOI here; the right one is Magnard's own.)

It is the same family as the six fixed in 0.63.1 and the same strand as the
`10.` + `1073/…` line-break gap: `healDoiLineBreaks` demands a **digit** after
the gap it closes, and this continuation begins with `.`. Left unfixed and
recorded, because the point of the run was to add the pair, not to chase what it
turned up.

### Six defects in DOI extraction, found and fixed

The benchmark grades only provable defects. Its first run found six, all minting
ghost nodes for works that exist under no such identifier — not a near miss, but
a node in the graph permanently unresolvable by any enricher. Fixed in 0.63.1;
kept here because they are what the tier-2 set was built to catch.

| defect | emitted | should be |
|---|---|---|
| suffix | `10.3389/fncom.2013.00137/abstract` | `10.3389/fncom.2013.00137` |
| truncated | `10.1002/1521-396x(200009)181:1` | `…181:1<99::aid-pssa99>3.0.co;2-5` |
| truncated | `10.1002/1521-396x(200108)186:2` | `…186:2<187::aid-pssa187>…` |
| truncated | `10.1002/(sici)1521-396x(199903)172:1` | `…172:1<25::aid-pssa25>…` |
| truncated | `10.1038/lsa` | `10.1038/lsa.2016.32` |
| truncated | `10.1063/1` | `10.1063/1.4823548` |

Four causes, three in `core/normalize.js` and one worse:

1. **`normDoi` did not strip URL tails.** A Frontiers link is
   `.../10.3389/fncom.2013.00137/abstract`; the tail belongs to the URL, not to
   the DOI.
2. **Percent-encoding was never decoded.** A DOI arriving through a link
   annotation is part of a URL, so its reserved characters come encoded —
   `%3C` for `<`. `DOI_RE` stops dead at the `%`.
3. **`DOI_RE` had no `<` or `>`.** DOIs registered before ~2005 embed them
   (`10.1002/1521-396X(200009)181:1<99::AID-PSSA99>3.0.CO;2-5` is *one* DOI), so
   even decoded, every legacy Wiley reference was cut at the bracket.
4. **`edges/pdfLinks.js` carried its own private copy of the DOI pattern.** That
   is why fixing 2 and 3 in `normalize.js` changed nothing for the strategy that
   produced three of the six: a second copy of a shared pattern is a second
   thing to fix, and only one of them got fixed. It now calls `findDois`, and
   `normalize.js`'s own docstring — *every provider must use these* — is true
   again.

Line breaks inside a DOI are the fifth strand, shared with the tier-1 `text-doi`
gap: `flattenPdfText` rejoins wrapped lines with a space, so `10.` + `1073/…`
becomes `10. 1073/…` and matches nothing. `healDoiLineBreaks` closes only gaps a
DOI cannot legally contain, and each rule demands the continuation look like one
— a digit must follow — so a reference ending `…nature12373. Smith et al.` is
left alone.

What the fix bought, against the committed baseline:

| strategy | tier 1 recall | tier 2 TP | defects |
|---|---|---|---|
| `pdf-links` | 62% → 62% | 485 → **489** | 4 → **0** |
| `text-doi` | 24% → **38%** | 37 → **50** | 2 → **0** |
| `ref-strings` | 45% → **52%** | 37 → **50** | 2 → **0** |
| `openalex` | 97% → 97% | 804 → **807** | 0 |
| union | 100% | 806 → **809 of 809** | 6 → **0** |

Precision stayed at 100% throughout, no trap was hit and the negative control
stayed clean, so none of it was bought by guessing. The union now finds every
external DOI Crossref knows about, with nothing left missed.

(`openalex` gained three without its code changing: those were legacy Wiley DOIs
the *key* had entity-encoded, `&lt;` for `<`, which `build-external.js` now
decodes. A benchmark can be wrong about the same DOI its subject is wrong about.)

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

**`text-doi` was the one strategy below its ceiling, at 7 found of 11 printed —
it is now at all 11.** The four misses were `sturner2019 → barry2016`,
`→ dolde2011`, `→ gruber1997` and `odmrManual → dolde2011`, and they shared one
cause. `flattenPdfText` joins wrapped lines with a space, so a DOI broken across
a line break becomes

```
https://doi.org/10. 1073/pnas.1601513113      (space after "10.")
https://doi.org/10.1038/ nphys1969            (break after the slash)
```

and `DOI_RE` — which wants digits immediately after `10.` and at least one
character after the slash — matched neither. `healDoiLineBreaks` (0.63.1) closes
the gap and takes `text-doi` to exactly its 41% ceiling; `ref-strings`, which
reads the same text, went 45% → 52% with it.

Every offline strategy is now at its channel ceiling, so none of them can gain
another tier-1 edge without a new channel or fuzzy title matching.

## Extending it

Add the item to the collection in the test profile, then add the work to
`works` and its outgoing edges to `edges` — including `doi`/`title`/`authorYear`
for each, since those flags are what make per-strategy ceilings computable rather
than guessed. Read the citing PDF's reference list; do not resolve the references
through a metadata API, or the answer key stops being independent of the thing it
measures.

If a probe flags a pair you then reject, put it in `expectedNonEdges` with the
reason. The rejected matches are worth as much as the accepted ones.
