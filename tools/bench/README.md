# Label rendering benchmark

`labels.html` answers the one question the Node-side benchmarks cannot: how
long does the engine actually take to rasterise the labels we ask it to draw?

The placement pass is pure arithmetic, so `tools/test-cjs-shim.js` can time it
in Node and the number means something. Painting is not — it is glyph
rasterisation, a halo stroke, a compositing path and whatever the GPU is doing,
and none of that exists in Node. A Cairo or Skia figure would be *a* number
measured on the wrong rasteriser, which is worse than no number, because it
looks like an answer.

## Running it

**In Zotero** — the only place the numbers are literally right. Open
Tools → Developer → Run JavaScript and run:

```js
Zotero.getMainWindow().openDialog(
    'file:///C:/Users/you/Repositories/zotero-graph-plugin/tools/bench/labels.html',
    'zg-bench', 'chrome,centerscreen,resizable,width=1100,height=900');
```

**In Firefox** — a good proxy, and much easier. Zotero 7 is built on Firefox
115 ESR, so the rasteriser is the same family. `npm run bench` prints the URL.

**Anywhere else** — Chrome, Edge and friends will run it and report Skia's
numbers, not Gecko's. The page says so in its header when it detects a
non-Gecko engine. Useful for spotting a 10× regression, useless for tuning.

## What it measures

Three phases per frame, timed separately and reported as percentiles rather
than means, because frame time is skewed and the tail is what people see:

| phase | what it is |
|---|---|
| `pass` | `reserveLabels()` — the real `labelLayout.js`, deciding which names fit |
| `paint` | `drawLabel()`'s sequence for every winner: halo stroke, then fill |
| `backdrop` | circles and edges, so a frame total means something |

Three buttons:

- **Run benchmark** — frame cost across four zoom levels.
- **Sweep label counts** — what the halo costs, as a share of paint time. The
  halo is a second full rasterisation of every glyph with a wide round-joined
  stroke; if it dominates, dropping it below some type size is the cheapest win
  available.
- **A/B the box rule** — the shipped rule (names reserve their glyphs) against
  the one it replaced (names reserved their node's circle too), on the same
  canvas in the same session. The names column is the point; the paint columns
  are what it costs.

## Two things that make the numbers real

**The pipeline is flushed.** `fillText` queues work and returns long before a
glyph reaches a pixel, so timing the calls alone measures command submission
and reports a fiction — usually a flattering one. Every phase ends with a
one-pixel `getImageData`, which forces the queue to drain. Its own cost is
measured at the top of each run and subtracted from every figure.

**The input is seeded.** Same seed, same graph, so an A/B compares two rules
rather than two random layouts. Local citation counts are heavy-tailed, like a
real collection.

Check `devicePixelRatio` in the header before comparing across machines — text
fill rate scales with it, and a HiDPI display is drawing four times the pixels.

## Keeping it honest

The page copies the label constants out of `graph.js`, because that file is one
IIFE with no exports and a benchmark is not a good enough reason to carve it
up. A copy that drifts turns the whole tool into a confident measurement of
code nobody runs — so `npm test` asserts the two agree, including the halo
width, which is a bare literal in `drawLabel` and half of what a label costs.

The backdrop is *not* force-graph's own drawing. It is circles and edges at the
right count and roughly the right cost, there to put the label figures in a
frame budget. Don't read it as what the graph costs to draw.
