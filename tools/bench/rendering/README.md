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
npm run bench -- --perf '{"physics":false}'   with a renderer switch off
npm run bench -- --headed                  watch it drive the page
npm run bench:sweep                        every performance switch, one at a time
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

## Measuring a performance switch

The renderer carries a set of named switches — `PERF` in `graph.js` — each
turning off one thing the picture would otherwise have: the force engine, the
arrow heads, the edge curvature, the strategy colours on the edges, the names,
their halo, their fade. `--perf` sets them for a whole run, through the same
`window.zgPerf` bridge the panel's checkbox uses, before the first payload and
before anything is measured, so no scenario ever straddles the switch.

```
npm run bench -- --json base.json
npm run bench -- --baseline base.json --perf '{"tint":false}'
```

`npm run bench:sweep` runs the whole matrix for you: a baseline, then every
switch on its own, then the combinations that are actually proposed, and prints
what each one bought. **One at a time is the point.** Switched together they
cannot be told apart, and a performance mode assembled out of switches nobody
measured is a mode that gives parts of the picture away for free — several of
the eight turned out to be exactly that, and they are not in the mode because
of that table.

Which scenarios a variant runs is a claim, not a saving: a switch that only
changes what is *painted* cannot move the time a fresh collection takes to
settle, and the table shows the ones it never ran as gaps rather than as zeroes.

### One session, variants interleaved

All of it happens in **one browser**, with the variants interleaved inside each
repeat — every variant once, then every variant again — and never all the
repeats of one variant before the next begins.

That is not a speed optimisation, it is the measurement. The first version ran
each variant as its own browser, one after another, and reported the edge tint
at −32% and the label halo at **+13%**. The halo is 0.46 ms of an 18.4 ms frame
by ablation, so +13% is not a slow halo, it is a busy machine: every variant
after the fourth was measured on a machine progressively more loaded than the
one the baseline got, and best-of-repeats cannot rescue a comparison in which
every repeat of the later side is contaminated and none of the earlier side is.
The scenarios already had this right one level down, for exactly the same
reason; the variants needed it too, and could have it, because a switch is only
a `zgPerf` call — nothing about a variant requires a browser of its own.

Two smaller things follow from being in one session. A variant states its
**whole** switch configuration rather than only what it turns off, so the last
row cannot be measuring all the ones before it. And every variant anneals the
**same** fresh collection within a repeat, so two cold layouts differ by the
switch rather than by the dice.

## What the matrix turned up that is not fixed yet

**The label placement pass costs about three times what drawing the labels
costs.** Ablation puts `fillText`/`strokeText` at ~3% of a frame; the `labels`
switch, which also removes `reserveLabels()`, is worth ~13%. The difference is
the greedy occlusion walk — every node, every frame, into screen space and
through the packing grid — and it runs on a graph that has not moved since the
last frame just as eagerly as on one that has.

It is a placement, so it is only stale when something moves: a node, or the
view transform. Both are knowable. Nobody has written that down yet, and the
number above is the argument for doing so.

## Time to a settled graph

Every scenario here measures a frame, and a frame is the right unit for *does
this feel smooth*. It is the wrong unit entirely for *how long do I watch a
graph fly into place before I can read it* — and that is most of what the force
engine costs someone opening a collection.

So a run also times, in wall clock, from handing the page a fresh collection to
the last frame the renderer drew. Timed to the last **paint**, not to the poll
that noticed it: `quiesce()` deliberately waits out twenty quiet frames before
it believes the graph has stopped, and charging that patience to the layout
would put a third of a second on every figure.

The number it reports for the default build is force-graph's `cooldownTime`
almost exactly, which is the finding: the engine runs the clock out whether or
not the layout has converged. `--no-wall` skips it, which is worth doing for a
switch that cannot touch a layout — it costs a full anneal per repeat.

## Shipping

The page lives under `addon/` because that is the only way to reach it over
`resource://` inside Zotero. It is still a developer tool, so a release build
leaves it out; `npm run build -- --with-bench` packs it, and a dev install
serves `addon/` directly and always has it.
