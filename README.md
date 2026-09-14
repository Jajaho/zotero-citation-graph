<div align="center">

<img src="logo-concepts/01-z-graph.svg" width="120" height="120" alt="Citation Graph for Zotero">

# Citation Graph for Zotero

**A force-directed citation graph for your Zotero library — offline by default, FOSS, and native to Zotero.**

[![CI](https://github.com/Jajaho/zotero-citation-graph/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Jajaho/zotero-citation-graph/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Jajaho/zotero-citation-graph)](https://github.com/Jajaho/zotero-citation-graph/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Jajaho/zotero-citation-graph/total)](https://github.com/Jajaho/zotero-citation-graph/releases)
![Zotero 10+](https://img.shields.io/badge/Zotero-10+-CC2936)
[![License: AGPL-3.0](https://img.shields.io/github/license/Jajaho/zotero-citation-graph)](../LICENSE)

<!-- TODO: drop a screenshot or GIF of a settled graph here. Upload it to a GitHub
     issue or release and paste the user-attachments URL, the same way the videos
     further down are embedded. -->

</div>

Have you ever looked at your library and felt the fear that you might be missing an important work in the field?
Have you wondered how the research in your field is related, who is building on the same work and who is developing separate ideas?

Have you looked at all the cool tools like ConnectedPapers, Research Rabbit and Inciteful but hoped there was a FOSS solution that is native to your Zotero library, something that integrates seamlessly with your existing workflow?

Then fear no longer, Citation Graph for Zotero is for you.

## Features

- Native Zotero User Interface: Context, Info pane, Locate, Plugins, (Advanced) Search, Keyboard Shortcuts
- Extensive Node Structuring: Filters, Grouping, Colouring and Sizing
- Dynamical Graph Layout through Physical Simulation (like Obsidian)
- Highly customizable graph rendering: Performance Mode, Adjustable Forces, Configurable Node Visibility
- Multi-strategy Citation Graph Builder:
    - fully offline:
        - pdf-links
        - text-doi
        - title-match
        - locator-match
        - ref-strings
    - online options:
        - OpenAlex API
- Capable of referencing cited articles not in your library.
  - Automatic identification and metadata query (authors, year, global citations)
  - Quick `Open in Browser`
  - One click `Add to Zotero`
- Advanced Analysis Functions:
  - Automatic clustering of articles by topic
  - Gap Detection: `What's missing?` produces a ranked list of articles relevant to your research but your library does not contain
- Localization
  - en-US
  - de-DE
  - ([help needed](CONTRIBUTING.md#translations) to translate to more languages)

## Requirements

| | |
|---|---|
| [Zotero Desktop](https://www.zotero.org/download/#) (Windows, macOS or Linux) | Version 10.0 or later |
| Network | Not necessary for connecting locally held papers, required for some additional features; see [Privacy and network use](#privacy-and-network-use) |

Offline edge building reads the PDF attachments you already have. Items with no
attachment still appear as nodes, they just cannot contribute edges from the
offline strategies.

## Installation for Users

1. Download `zotero-citation-graph-x.x.x.xpi` from the [latest release](https://github.com/Jajaho/zotero-citation-graph/releases/latest).
2. Open Zotero, navigate to Tools > Plugins.
3. Select the ⚙️ (gear) icon > Install Plugin from File... and select the `.xpi` file.
4. Congratulations, your installation is complete. Verify it by right clicking on a collection in your library: it should show *View Citation Graph* with the plugin icon in front of it.

### Updating

Zotero checks for plugin updates on its own and on demand (Tools > Plugins >
⚙️ > Check for Updates). The manifest points its `update_url` at `updates.json`
in this repository.

### Uninstalling

Tools > Plugins, then ⚙️ > Remove next to *Citation Graph for Zotero*, and
restart Zotero. The plugin keeps its preferences and its caches in the Zotero
profile; removing it leaves your library itself untouched — no item, attachment,
tag or collection is modified by uninstalling.

## Getting Started

This is still a work in progress and will always lag behind the newest UI changes and feature additions, but it should provide a good overview of all functions and serve as a starting point in learning how to use this plugin effectively.
Please turn on the audio on the videos below.

### Constructing a Graph

There are two ways to construct a graph, both accessible from the context menu (right mouse click).
1. From a collection.
2. From a selection of items in your library/collection.



https://github.com/user-attachments/assets/da8b9b74-19a6-4155-9c91-7e1939c33b2c



### Managing Sources considered by the Graph

This is done in the *Item Selection* pane of the left settings sidebar.
- Enable the *Subcollections* option to include items from all subcollections of the collection you build the graph on.
- Enable *External refs* to display references to items not in your selected items or collection. This can be filtered by *Cited by* setting to include only items that are referenced by more than one item in your library.

### Isolating Nodes

Large graphs can have a lot of edges and nodes obfuscating a node you actually want to look at.
To solve this, you can isolate a node and take a closer look at its references and the items that reference it.


https://github.com/user-attachments/assets/79f0c8c2-b1de-490c-a257-d825b06df044



### Group Pins

You can physically separate groups of nodes from the rest of the graph with *Groups*.
Which nodes are attracted to the set location is masked with filters.

https://github.com/user-attachments/assets/7fd185e2-5008-477c-a845-8d4b94e4a69e



## Privacy and Network Use

The plugin has no telemetry, no analytics and no account. It phones nothing
home, ever. The only code in it that can open a network connection is the
OpenAlex provider, and it is **off by default**.

| Strategy | Network | On by default | What leaves your machine |
|---|---|---|---|
| `pdf-links` | offline | yes | nothing |
| `text-doi` | offline | yes | nothing |
| `title-match` | offline | yes | nothing |
| `locator-match` | offline | yes | nothing |
| `ref-strings` | offline | no | nothing |
| `openalex` (edges) | **network** | **no** | DOIs only |
| `openalex` (metadata enricher) | **network** | **no** | DOIs and OpenAlex IDs only |

The following UI actions will result in a request to OpenAlex:
- *OpenAlex references* - Referencing strategy
- *Query node metadata*
- Setting node *size* to *global citations*, will automatically enable *Query node metadata*. 

These will send bare DOIs (or OpenAlex work IDs) as a filter on
`https://api.openalex.org/works`. They will **NEVER** expose your titles, authors, notes, tags,
annotations, collection names, PDF text, library size or anything identifying
you. The retired `mailto` polite-pool parameter is not sent. If you configure an
API key it travels in an `Authorization` header rather than the query string, so
it stays out of URLs, logs and error messages.

Answers are cached, so a paper is asked about once: a warm rebuild of the same
graph makes no request at all. Requests go through Zotero's own HTTP stack,
which honours your proxy settings and Zotero's offline mode.

Everything else — reading PDFs, extracting DOIs, matching titles, clustering,
gap detection, layout — happens locally, on your machine, from files you already
have.

## Building from Source

```sh
git clone https://github.com/Jajaho/zotero-citation-graph.git
cd zotero-citation-graph
npm test          # no `npm install` needed: the tests and the packer are plain Node
npm run build     # writes dist/zotero-citation-graph-<version>.xpi
```

Requirements: Node ≥ 18. The plugin has **zero runtime dependencies**; the one
`devDependency` (`pdfjs-dist`) is used only by the offline benchmarking tools, so
`npm install` is optional and is not needed to test or build.

`npm run verify` runs the version gate (`package.json` and `addon/manifest.json`
must agree) plus the test suite — the same checks CI runs before it builds.
Because the packer writes fixed timestamps and a fixed entry order, building the
same commit twice produces byte-identical XPIs, which is what makes the
published `SHA256SUMS` verifiable by anyone.

Development setup, the edit/restart loop and the project's invariants are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Known limitations

This is a public beta release. Don't worry your data is safe, but expect some minor bugs or visual artifacts and know that the interface is still a work in progress.

Offline citation extraction is inference from whatever the publisher happened to
put in the PDF, so its yield varies a lot by field and by publisher. Concretely:

- **A PDF with a text layer is required.** Scanned pages with no OCR give the
  offline strategies nothing to read. Items with no attachment at all still
  appear as nodes; they just have no outgoing edges.
- **`pdf-links` is publisher-dependent.** Embedded DOI hyperlinks are plentiful
  for APS, Nature, AIP and IOP, and sparse to absent elsewhere.
- **`text-doi` is weak on its own.** Most publishers hyperlink DOIs instead of
  printing them: on the sample library the median PDF had zero visible DOIs and
  only 23% had any at all.
- **`title-match` only finds papers you already hold.** It looks for your items'
  titles inside reference sections, so it cannot discover anything outside the
  graph's item set, and very short titles are skipped deliberately.
- **OpenAlex needs DOIs.** Items without one contribute nothing to, and gain
  nothing from, the online strategy. Its coverage also overlaps the offline stack
  only partly — that complementarity is why both exist.
- **Scale.** The renderer is benchmarked at 1,500 items / ~2,700 edges and stays
  interactive there. Larger graphs are usable with *Performance Mode* on. The slow part is the first build, which is
  bounded by how many PDFs have to be read; later builds reuse the cache.
- **Missing and wrong edges happen.** A citation graph built this way is a
  research aid, not a bibliographic record. Use the confidence slider to see how
  much of the graph rests on the weaker strategies.

Found something broken or missing? Please open an
[issue](https://github.com/Jajaho/zotero-citation-graph/issues) — include your
Zotero version, your OS and what you clicked.

## Contributing

Bug reports, pull requests and especially **translations** are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md), and
[Translations](CONTRIBUTING.md#translations) if you want to add a language.

## License and Third-Party Code

Citation Graph for Zotero is free software, licensed under the
[GNU Affero General Public License v3.0 or later](../LICENSE). This guarantees to you that all current and future features will be free for everyone, now and forever. This plugin will never come with a paywall, you will always be able to verify the code's integrity and know exactly what it's doing.

It bundles and reuses material from the sources below, redistributed here in
accordance with their respective licences. The full notices ship inside the XPI
as [`addon/THIRD-PARTY-NOTICES.md`](../addon/THIRD-PARTY-NOTICES.md).

| What | Where | Licence |
|---|---|---|
| force-graph 1.51.4 + its bundled d3 modules | `addon/content/lib/force-graph.min.js` | MIT / ISC |
| Sixteen Zotero menu icons | `addon/content/icons.js` | AGPL-3.0, © Corporation for Digital Scholarship |
| Everything else | | AGPL-3.0-or-later, © 2026 Jakob Holz |

Zotero is a registered trademark of the Corporation for Digital Scholarship.
This plugin is independent and is not affiliated with, endorsed by, or sponsored by them.

## Credits

- **[OpenAlex](https://openalex.org/)** — Priem, J., Piwowar, H., & Orr, R. (2022). *OpenAlex: A fully-open
  index of scholarly works, authors, venues, institutions, and concepts.* [arXiv:2205.01833](https://arxiv.org/abs/2205.01833). It provides the optional online referencing strategy, and the
  metadata for cited works. OpenAlex is an open catalogue run by [OurResearch](https://ourresearch.org/).
- **[force-graph](https://github.com/vasturiano/force-graph)** by Vasco
  Asturiano, and the **[d3](https://d3js.org/)** force and scale modules by Mike
  Bostock that it builds on — the layout and the canvas renderer.
- **[Zotero](https://www.zotero.org/)** and the Corporation for Digital
  Scholarship — the application this plugin lives inside, and the menu icons it
  reuses.
- **[pdf.js](https://mozilla.github.io/pdf.js/)** (Mozilla) — PDF text and link
  extraction in the offline benchmarking tools.
- Everyone who has reported a bug, sat through a usability session or sent in a
  translation. My special thanks go to:
    - Victor Joss for suggesting the "Group Pins" feature.
    - Sofia Navas Gohlke for providing valuable feedback on usability and suggesting the builtin PDF viewer.
    - Alina Niggli for providing extensive feedback on usability.
