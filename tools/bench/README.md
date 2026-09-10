# Graph rendering benchmark

Times what the plugin actually costs to draw: settling a layout, dragging a
node, isolating a neighbourhood, adding papers, zooming, panning, filtering.

It drives the **real** graph page. `addon/content/bench/bench.html` loads
`../graph.html` in an iframe, unmodified, and feeds it through the same
`zgSetData` string-in / `zg-event`-out bridge chrome uses. Nothing here
re-implements the renderer, so nothing here can drift away from it — which the
label-only benchmark this replaced could, and needed a test to police.

```
npm run bench                              all scenarios, headless Firefox
npm run bench -- --json before.json        keep a baseline
npm run bench -- --baseline before.json    compare against it
npm run bench -- --only steady,zoom --n 5000
npm run bench -- --headed                  watch it drive the page
npm run bench:open                         run it by hand, in Zotero
npm run bench:serve                        serve it for a browser, no runner
```

## Which numbers, from where

**Firefox, automated** — for *did this change help?* Zotero 7 is Firefox 115
ESR: same rasteriser, same text shaping, same compositor family. For two runs
on one machine minutes apart, this is exactly the right instrument, and it is
the question asked far more often.

**Zotero, by hand** — for *how fast is it really?* Absolute figures belong to
the application being tuned. `npm run bench:open` prints the snippet.

Headless runs render in software, so absolute frame times are slower than a
GPU-composited Zotero. Comparisons are unaffected — both sides pay it.

## Scenarios

| id | what it exercises |
|---|---|
| `settle` | cold layout: a fresh payload annealed until the engine cools |
| `steady` | a settled graph repainting — the floor everything else sits on |
| `drag-node` | hit test, reheat and re-layout every frame |
| `pan` | no layout work; pure redraw at a new transform |
| `zoom` | every screen-space size recomputed per frame |
| `isolate` | the whole graph repainted into a wash, and back out |
| `add-papers` | a build phase landing: a bigger payload over a settled graph |
| `filter` | an already-built graph re-filtered by the confidence slider |

Gestures are real events on the real canvas — d3-zoom's listeners, force-graph's
hit test, the page's own handlers. `drag-node` and `isolate` find a node by
asking force-graph's own hit test (it puts a `clickable` class on the canvas
when it is over something) rather than aiming at the middle and hoping, because
a "drag a node" scenario that actually panned the background would be worse
than no scenario.

## Reading the output

```
scenario      best     p50     p95  noise  fps@best  was p50           delta  verdict
settle      13.899  14.819  18.219   ±23%        72   14.160  -0.260 (-1.8%)    noise
pan         12.219  14.159  17.179   ±25%        82   11.540  +0.680 (+5.9%)    noise
```

**`best` is the headline, and it is not the median.** Every source of noise on
a desktop — another process, a GC, the compositor picking that moment to act —
can only *add* time to a frame. None can make the renderer faster than it is.
So the fastest repeat is the least contaminated and the cleanest estimate of
what the code costs; a median averages the interference in instead.

This is not a stylistic preference. Measured on pooled medians, two runs of an
**identical build** disagreed by up to **63%**, which made any real
optimisation indistinguishable from a background job. On best-of-3 the same
comparison came back 0.0%–5.9%. That is the entire difference between a tool
you can optimise against and a random number generator.

**`noise`** is the spread across repeats of the one build — a health signal. If
it is large the machine is busy; the `best` column is still usable, but raise
`--repeat`.

**`verdict`** calls anything inside ±8% noise. That bar is calibrated, not
guessed: two identical builds drifted 4.3% and 5.9% on two of eight scenarios,
so a 5% bar reported that drift as a regression. Raise `--repeat` and lower
`--noise-pct` together if you need to resolve something smaller.

## Where the time goes

The run ends with an attribution:

```
subsystem   frame without  its cost  share
everything         11.640         -   100%
labels             10.740     0.900     8%
edges               8.760     2.880    25%
```

Measured by **ablation**: the canvas primitives a subsystem paints through are
turned into no-ops in the frame's own realm, and the frame time that disappears
is its share. Labels are `fillText`/`strokeText`, the circles are `arc`, the
edges are `stroke`. This needs no hooks in `graph.js`, so it cannot rot when
`graph.js` moves — the reason it is done this way rather than by instrumenting
the renderer.

Shares do not sum to 100%: some work is shared, and some is neither drawing nor
attributable to one subsystem.

A subsystem whose whole cost is smaller than the spread between repeats of the
same measurement is reported as **under noise**, with the floor it fell under,
rather than as a number. Rounded to "0%" it would read as a claim that the
subsystem is free; it is not a claim, it is an absence of one. Raise `--n`
until a subsystem matters enough to resolve, or `--repeat` until the floor
drops below it.

## How it is wired

No browser-driver dependency, and no `about:config` surgery to explain.

`serve.js` serves `addon/` over http on loopback and takes a `POST /results`.
Two problems, one answer: over `file://` Firefox gives every document its own
opaque origin, so the harness could not read into the iframe at all — served
over http they share an origin. And a headless run has to get its numbers back
out; posting to the server that served the page beats a driver dependency or
parsing `dump()` off stdout.

`run.js` finds Firefox, writes a throwaway profile (so nothing from your own
browsing can move a number, and so this never touches that profile), opens the
page with `?auto=1`, waits for the POST, and prints the table.

## Settling, and why it is worth waiting for

Every scenario but `settle` measures a graph that has stopped moving, so the
harness has to know when that is. It waits for force-graph to stop *painting* —
counted by patching `clearRect` in the frame's realm, since force-graph
reschedules its animation frame whether or not it draws, and counting frames
cannot tell a live layout from a cooled one.

The first version watched the harness's own recorded-frame array, which only
grows while a measurement is running — so during a settle it never grew, the
loop read that as "already quiet", and returned after about a dozen frames.
Every number calling itself a settled-graph measurement was taken off a graph
still flying into place. Fixing it dropped `steady`'s run-to-run noise from
±30% to ±3%, which is most of the difference between a tool that can resolve a
5% change and one that cannot.

This is why a full run takes minutes: force-graph's default cooldown is 15
seconds, and a scenario that disturbs the layout has to pay it again on each
repeat.

## Two things that make the numbers real

**The pipeline is flushed.** `fillText` queues work and returns long before a
glyph reaches a pixel, so timing the calls alone measures command submission
and reports a flattering fiction. Every frame ends with a one-pixel
`getImageData`, which forces the queue to drain — inside the timed region,
because that is the point, with its own fixed cost calibrated per run and
subtracted.

**The input is seeded and shaped.** Same seed, same collection, so an A/B
compares two builds and not two dice rolls. Citation counts are heavy-tailed
and edges preferentially attached, because a few hubs is the shape the layout,
the collision force and the label ranking are all tuned against — uniform
random degrees would make every one of them look easier than it is. `npm test`
checks the fixture is a payload the renderer can actually read, since a
malformed one does not fail loudly: it draws an empty graph and reports
excellent frame times for rendering nothing.

## Shipping

The page lives under `addon/` because that is the only way to reach it over
`resource://` inside Zotero. It is still a developer tool, so a release build
leaves it out; `npm run build -- --with-bench` packs it, and a dev install
serves `addon/` directly and always has it.
