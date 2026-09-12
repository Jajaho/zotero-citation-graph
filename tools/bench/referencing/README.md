# The referencing benchmark

Measures whether the edges the strategies in `addon/citation-graph/edges/` draw
are **true**, against a hand-built collection whose citations are known
independently of the strategies being graded. (`tools/bench/rendering/` measures
how fast the graph draws; this measures whether it is right.)

- **run it** → [Running it](#running-it)
- **read the output** → [Reading the report](#reading-the-report)
- **what is in the collection, and why** → [COLLECTION.md](COLLECTION.md)
- **the current standing** → [REPORT.md](REPORT.md)

## Running it

The collection lives in its own Zotero profile so it can be opened, rebuilt and
thrown at the plugin without touching a real library:
`C:\Users\you\Zotero citation_graph_testing`. Open it with
`zotero.exe -datadir "C:\Users\you\Zotero citation_graph_testing"`.

```
npm run bench-ref -- --data-dir "C:/Users/me/Zotero citation_graph_testing"
npm run bench-ref -- --data-dir <dir> --db ./snap.sqlite      # Zotero running
npm run bench-ref -- --data-dir <dir> --enable openalex --api-key KEY
npm run bench-ref -- --data-dir <dir> --report REPORT.md    # -> REPORT-<date>-<time>.md
npm run bench-ref -- --data-dir <dir> --report REPORT.md --overwrite   # replace it instead
npm run bench-ref -- --data-dir <dir> --baseline baseline.json
npm run bench-ref -- --data-dir <dir> --no-external           # tier 1 only
npm run bench-ref:external                                    # rebuild tier 2
```

Zotero holds a write lock on `zotero.sqlite` while it runs, so point `--db` at a
copy if it is open.

`--enable` picks the strategies; without it, every strategy that needs no
network. To reproduce the committed standing:

```
npm run bench-ref -- --data-dir <dir> --db ./run.sqlite \
  --enable pdf-links,text-doi,title-match,ref-strings,openalex \
  --report tools/bench/referencing/REPORT.md --overwrite \
  --json tools/bench/referencing/baseline.json
```

`--report` stamps the filename with the run's date and time and never replaces
an earlier report: a report describes one commit against one database hash and
one PDF set, and the run you most want to read is usually the one before the
number moved. `--overwrite` is for the case above — deliberately refreshing the
committed standing, which is the one report that has a fixed name because
`REPORT.md` is what the repo shows.

`--json` is not stamped. It is written to be read back by `--baseline`, so a
name you chose has to be a name you can still type afterwards.

### The caches

`.crossref-cache/` (the raw deposited reference lists) and
`.openalex-doi-cache.json` are committed on purpose: with them, everything
except the `openalex` strategy itself scores with no network at all, and tier 2
is rebuildable byte-for-byte rather than being whatever Crossref returns today.

`openalex` returns its references as OpenAlex work IDs, not DOIs, so scoring it
against tier 2 needs an ID→DOI map. That resolution is cached and is **identity
only** — which DOI is `W123`. The truth about who cites whom stays Crossref's.
`--no-resolve` skips it and scores from the cache alone.

## The two tiers

The benchmark grades against two answer keys, known to different standards, and
the difference decides what a wrong answer means in each.

| | tier 1 | tier 2 |
|---|---|---|
| file | `ground-truth.json` | `external-refs.json` |
| covers | 30 citations **between** the 14 held works | 1366 works they cite and the collection does **not** hold |
| built by | hand, from each citing PDF | machine, from Crossref deposited reference lists |
| exhaustive? | yes — cross-checked against Crossref | **no** — publishers deposit incomplete lists |
| a wrong edge is | a false positive | *not* judged; reported as `unconf` |

Tier 1 is small enough to be complete, so it can call a strategy **wrong**.
Tier 2 is 45× bigger and gives the external-facing strategies — `ref-strings`
and `openalex`, which mint ghost nodes — something to be measured against, but it
cannot prove a negative.

**Presence is reliable, absence is not.** If Crossref says A cites X, A cites X.
The converse fails: `barry2016` prints 59 numbered references and Crossref holds
what it holds, so some of that paper's real citations are missing from the set
through no fault of any strategy. Tier-2 recall is therefore a **lower bound**,
and an emitted DOI that is not in the set is `unconf`, never an error.

Two things *are* graded as defects there, because both are provable despite the
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

## Reading the report

`--report <file.md>` writes [REPORT.md](REPORT.md); `--json <file>` writes the
same run machine-readably, and `--baseline <that file>` compares a later run
against it. Both committed files are the current standing, so a change in
strategy code shows up as a diff.

### Conditions

The report leads with the conditions, because a score without them cannot be
compared with a score taken later: the commit and whether the tree was dirty,
node and OS versions, the **sha256 of the database and of the PDF set**, the
sha256 and size of both answer keys, whether the network was used and whether an
API key was supplied, and every strategy's confidence and full options object as
it actually ran.

That is what makes a comparison honest rather than hopeful. If the dataset hash
or the key hash moved between two runs, the report says so above the diff and
warns that the difference is not attributable to the code — which is exactly the
mistake a benchmark is otherwise built to invite.

### Tier 1 columns

| column | means |
|---|---|
| `pred` | distinct in-collection edges the strategy emitted |
| `TP` | of those, edges the key holds |
| `uniq` | TPs **no other strategy in this run found**. Zero means the strategy carries nothing the rest do not already carry |
| `FP` | emitted edges the key says are not citations. Tier 1 is exhaustive, so these are wrong, not unverified |
| `precision` | `TP / pred` |
| `recall` | `TP / 30` — against every edge, including the two whose citing work is held without a PDF |
| `rec/pdf` | `TP / 28` — against only the edges a PDF-reading strategy can reach. The fair figure for an offline strategy |
| `F1` | harmonic mean of precision and recall |
| `dup` | edges between the two copies of the work held twice. A self-loop after merging, so a duplicate-merging failure rather than a wrong citation |
| `traps` | FPs that are in `expectedNonEdges` — a pair the collection was built to bait |

`uniq` is blank for the union rows: every edge in them came from a row above.

### The two union rows

- **`OFFLINE (union)`** — every enabled strategy that needs no network. This is
  what a default install actually draws, since `openalex` is opt-in.
- **`ALL (union)`** — every enabled strategy.

The gap between them is the price of staying offline. `OFFLINE` is omitted when
it would be identical to `ALL`.

A union row takes each edge from whichever strategy emitted it, so **one
strategy's false positive is the union's false positive** — no strategy declining
an edge can outvote another asserting it. That is the behaviour of the real
build, not an artefact of scoring.

### Tier 2 columns

| column | means |
|---|---|
| `emitted by namespace` | outside nodes minted, by key namespace: `doi:`, `arxiv:`, `openalex:`, `ref:` |
| `TP` | emitted DOIs that Crossref's deposited lists confirm |
| `missed` | DOIs in the set the strategy did not emit |
| `unconf` | emitted DOIs the set does not contain. **Not errors** — the set is incomplete |
| `defects` | suffix artifacts and truncations, listed underneath. Provable, so these are errors |
| `recall ≥` | `TP / 1366`, a lower bound |
| `ref: nodes` | nodes keyed by a title slug rather than an identifier, with how many a Crossref-deposited reference title corroborates |

### Scoring is at work level

The collection holds one work twice on purpose; an item-level count would let a
strategy score the same citation twice and would punish one that correctly merged
the duplicate. An edge between the two copies collapses to a self-loop and is
reported in `dup` rather than as a false positive. Edges to works the collection
does not hold are tier 2's business and are never graded as tier-1 errors.
