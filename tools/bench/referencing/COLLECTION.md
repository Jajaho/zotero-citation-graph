# The benchmark collection

What is in the ground-truth collection, why each work is in it, and what the
answer key can and cannot prove. For running the benchmark and reading its
output, see [README.md](README.md); for the current standing, see
[REPORT.md](REPORT.md).

- **Profile** — `C:\Users\you\Zotero citation_graph_testing`
- **Collection** — `Citation Graph Benchmark` (15 items)
- **Answer keys** — [`ground-truth.json`](ground-truth.json) (tier 1),
  [`external-refs.json`](external-refs.json) (tier 2)

## An edge is not a reference

This trips people up, so it is worth stating before anything else. **An edge is a
citation from one work in the collection to another work in the collection.**

These 14 papers cite **1512 works** between them. Only **30** of those references
point at a work the collection also holds; those 30 are the edges. Every other
reference lands on a ghost node outside the collection, and tier 1 says nothing
about it — that is tier 2's business.

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

Recall therefore depends on getting those 30 exactly right: it is `TP / 30`, so a
key that missed true edges would silently inflate every score.

## What "ground truth" means here

Every edge in `ground-truth.json` was read out of the **citing PDF's own
reference list**. Nothing in it came from OpenAlex, Crossref, or any of the
strategies being measured — using a metadata API to build the answer key would
score `edges/openalex.js` against itself and tell us nothing.

Each candidate pair was put through four independent probes — the DOI string,
the full title, the bibliographic signature (author/journal/volume/page), and
author-plus-year proximity — and then every hit and every near-miss was read in
context and accepted or rejected by hand. The pairs a probe flagged and the
reading rejected are recorded as `expectedNonEdges`, because a benchmark that
only lists what should be found cannot measure precision.

### Completeness, checked against Crossref

The edge list was verified on 2026-09-11 against **Crossref's deposited
reference lists** — independent of the hand reading, and deliberately not
OpenAlex, which is one of the strategies being graded.

For all twelve source works that have a DOI, the in-collection targets Crossref
reports match the key exactly, work for work:

```
sarkar2023 6 · sturner2019 5 · zhang2022 4 · barry2020 6 · rondin2014 3
barry2016 1 · dolde2011 1 · hahn1950 0 · dreau2011 2 · gruber1997 0
magnard2020 0 · blais2021 1                                          = 29
+ odmrManual 1 (no DOI; hand-read from its PDF)                       = 30
```

No edge missing, none invented. The `refCount` values in the key are Crossref's
exact figures, replacing the bracket-number estimates the first version carried
(which had `barry2016` at 75 against an actual 59, and `hahn1950` at 0 against
an actual 19).

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
| `barry2016` | 2016 | source, 1 out / 4 in | PNAS numbered; **the extracted section starts at marker 31** |
| `dolde2011` | 2011 | source, 1 out / 5 in | **held twice** — the duplicate case |
| `hahn1950` | 1950 | source, 0 out / 1 in | pre-reference-section paper; two-word title, a false-positive magnet |
| `odmrManual` | — | source, 1 out | a lab-course **report**: no DOI, no creators, not a publisher PDF; markers abut their authors (`[1]Alexios`) |
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
strategies cannot all score the same.

A citation reaches a strategy through one of **three independent channels**. Each
of the 28 PDF-reachable edges is flagged for all three (the 2 edges from the work
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
and a byte-identical PDF. Scored at work level the set has 28 edges; an
item-level scorer that expands the duplicate on both sides sees 34. That
six-edge gap is the duplicate-merging penalty, and it is why
`summary.edgesItemLevel` is recorded alongside `summary.edges`.

**Three bibliographies defeat entry splitting in three different ways.**
`rondin2014` has no reference heading and 147 entries whose markers abut their
authors; `barry2016`'s extracted section begins at marker 31; `odmrManual` is
LaTeX output with `[1]Alexios`-style markers. They are the reason
`edges/refStrings.js` can be measured against `title-match` at all — see the
history below.

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
  exactly one year past 2020. Nor would tightening that slack be right —
  Blais 2021 was on arXiv as `2005.12667` in May 2020, so Magnard *could* have
  cited it, and a date rule strict enough to reject the pair would break real
  preprint citations to get this one right by luck.

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
year comparison alone — but `magnard2020 → blais2021` is not one of them, as
above.

The last trap is for whoever extends the set: `barry2020 → gruber1997` looks
like it must exist — a 454-reference NV review that does not cite the 1997 paper
that started single-defect microscopy is surprising. It does not. The string
"gruber" occurs zero times in that PDF. It is recorded because the tempting
correction is to add the edge from memory, and that would corrupt the answer key.

## Extending it

Add the item to the collection in the test profile, then add the work to `works`
and its outgoing edges to `edges` — including `doi`/`title`/`authorYear` for
each, since those flags are what make per-strategy ceilings computable rather
than guessed. Read the citing PDF's reference list; do not resolve the references
through a metadata API, or the answer key stops being independent of the thing it
measures. Then `npm run bench-ref:external` to rebuild tier 2, and update the
counts in `summary`.

If a probe flags a pair you then reject, put it in `expectedNonEdges` with the
reason. The rejected matches are worth as much as the accepted ones.

---

# History

What the benchmark has actually caught, kept because each one is a class of
defect rather than a single bug.

## OpenAlex corrected the answer key

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

## Six defects in DOI extraction, found and fixed (0.63.1)

The benchmark grades only provable defects. Its first tier-2 run found six, all
minting ghost nodes for works that exist under no such identifier — not a near
miss, but a node in the graph permanently unresolvable by any enricher.

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

Line breaks inside a DOI are the fifth strand: `flattenPdfText` rejoins wrapped
lines with a space, so `10.` + `1073/…` becomes `10. 1073/…` and matches
nothing. `healDoiLineBreaks` closes only gaps a DOI cannot legally contain, and
each rule demands the continuation look like one — a digit must follow — so a
reference ending `…nature12373. Smith et al.` is left alone. It took `text-doi`
from 7 of its 11 printed DOIs to all 11.

## A seventh, still open

`magnard2020` prints its supplemental-material note as
`http://link.aps.org/supplemental/10.1103/PhysRevLett .125.260502` — extraction
put a space before `.125`, so `findDois` stops at `10.1103/physrevlett` and mints
a ghost node under a string that names nothing.

Same family as the six above, same strand as the line-break gap:
`healDoiLineBreaks` demands a **digit** after the gap it closes, and this
continuation begins with `.`. (The scorer's "should be" column reports whichever
set member that prefix matches first, which is *not* the right DOI here.)

## The entry splitter was failing open on three bibliographies

`ref-strings` was scoring 15 tier-1 TPs against `title-match`'s 19, which is
backwards: an entry-level parser sees everything a substring scan over the same
text sees, plus the boundaries. Measured, the two matched exactly wherever
`splitEntries` produced anything at all — 14 of 14 — and the whole deficit came
from three documents where it produced **nothing** and `ref-strings` declined the
document by design.

Two over-strict rules in `refParse.js`, both since relaxed:

1. **`MARKER_G` demanded whitespace between the marker and the author.** Real
   extractions frequently have none — `[1]Alexios Beveratos` in `odmrManual`,
   `[117]E. Rittweger` in `rondin2014` — so not one marker was found in either.
2. **`markerRun` demanded that the run start at 1 or 2.** `barry2016`'s
   extracted section begins at marker 31, so its 59 regular references could
   never anchor a run.

Relaxing them needed a third fix, because the guard that should have caught the
resulting over-reach was dead code: `clean()` truncates every entry to
`MAX_ENTRY_CHARS`, and `accept()` then tested the median entry length against
`MAX_ENTRY_CHARS` — `x <= x`, true always. It now measures the lengths before
truncation, which is what stops a four-marker run splitting a 454-reference
bibliography.

```
work          entries: before -> after
rondin2014          0 -> 147   (of 148 references)
barry2016           0 ->  45   (of  59)
odmrManual          0 ->  13   (of  14)
adam2017            6 ->  21   (of  23)
barry2020           8 ->   0   (4-marker run and 8-entry blank split both rejected)
blais2021           9 ->   0   (same)

ref-strings   15 TP, 0 FP  ->  20 TP, 0 FP
```

`ref-strings` is now a strict superset of `title-match` — all 19 of its true
edges plus `sturner2019 → rondin2014`, which `title-match` cannot reach because
that title is damaged in the citing PDF. It also declines the
`magnard2020 → blais2021` trap that `title-match` takes, and structurally rather
than by luck: it does an exact-equality lookup on a parsed entry's own title
where `title-match` scans a blob for a substring.

The two `0`s are not a loss. Those are the author-year RMP bibliographies with
no markers at all, and 8 "entries" for 454 references was never a split — it was
the dead gate letting nonsense through. Both works' edges come through
`pdf-links`, which reads their link layer.
