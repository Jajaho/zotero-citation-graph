# Third-party notices

Citation Graph for Zotero is distributed under the GNU Affero General Public
License v3.0 or later; see `LICENSE` beside this file.

It bundles and reuses the material below. Each entry names what is included,
where it came from, and the notice its licence requires be carried with it.
The MIT and ISC licences both require the copyright notice and the permission
text to travel with every copy of the software, which is why this file ships
inside the XPI rather than only in the source repository.

---

## 1. force-graph (bundled) — MIT

`content/lib/force-graph.min.js` is force-graph v1.51.4, unmodified apart from
the notice banner prepended to it, from <https://github.com/vasturiano/force-graph>.

It is a pre-built UMD bundle, so the libraries force-graph itself depends on are
compiled into that one file and are covered by the notices in this section.
Copyright holders, by package:

| Package | Licence | Copyright |
|---|---|---|
| `force-graph` | MIT | Copyright (c) 2018 Vasco Asturiano |
| `d3-force-3d` | MIT | Copyright (c) 2017 Vasco Asturiano |
| `kapsule` | MIT | Copyright (c) 2017 Vasco Asturiano |
| `accessor-fn` | MIT | Copyright (c) 2017 Vasco Asturiano |
| `index-array-by` | MIT | Copyright (c) 2018 Vasco Asturiano |
| `canvas-color-tracker` | MIT | Copyright (c) 2018 Vasco Asturiano |
| `float-tooltip` | MIT | Copyright (c) 2022 Vasco Asturiano |
| `bezier-js` | MIT | Copyright (c) 2023 Pomax |
| `@tweenjs/tween.js` | MIT | Copyright (c) 2010-2012 Tween.js authors |
| `lodash-es` | MIT | Copyright OpenJS Foundation and other contributors <https://openjsf.org/>, based on Underscore.js, copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors |
| `d3-array` | ISC | Copyright 2010-2023 Mike Bostock |
| `d3-drag` | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-scale` | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-scale-chromatic` | ISC | Copyright 2010-2024 Mike Bostock |
| `d3-selection` | ISC | Copyright 2010-2021 Mike Bostock |
| `d3-zoom` | ISC | Copyright 2010-2021 Mike Bostock |

`d3-scale-chromatic` carries a second licence for the ColorBrewer colour
schemes (Apache-2.0, by Cynthia Brewer, Mark Harrower and The Pennsylvania
State University). Those schemes are **not** present in this build — the
bundle contains none of the ColorBrewer palette literals, and this plugin
draws with its own colours — so the Apache-2.0 terms are not reproduced here.
Re-check this if the bundle is ever regenerated.

### MIT License

Applies to every package marked MIT above, with that package's copyright line.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License

Applies to every package marked ISC above, with that package's copyright line.

```
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

---

## 2. Zotero menu icons (copied) — AGPL-3.0-or-later

Copyright (c) Corporation for Digital Scholarship.

`content/icons.js` holds the SVG path data of twenty-three icons copied verbatim
from Zotero itself, so that a menu, a toolbar button or a section twisty drawn
in this plugin matches the same thing drawn anywhere else in the application.
They are copied rather than referenced because the graph is a content document
at a `resource://` URL, from which `chrome://zotero/skin/...` is not reachable.

Source: <https://github.com/zotero/zotero>, under
`chrome/skin/default/zotero/{8,16,20}/universal/`. Verified byte-identical
against a Zotero 7 installation on 2026-09-09, and the last five rows against
Zotero 10.0.2 on 2026-09-11:

| Name in `icons.js` | Zotero source file |
|---|---|
| `show-item` | `16/universal/show-item.svg` |
| `open-pane` | `20/universal/sidebar.svg` |
| `new-tab` | `16/universal/new-tab.svg` |
| `open-link` | `16/universal/open-link.svg` |
| `add-to-zotero` | `20/universal/save-to-zotero.svg` |
| `show-all` | `16/universal/view.svg` |
| `plus-circle` | `16/universal/plus-circle.svg` |
| `minus-circle` | `16/universal/minus-circle.svg` |
| `pin` | `16/universal/pin.svg` |
| `unpin` | `16/universal/pin-remove.svg` |
| `zoom-to-fit` | `20/universal/maximize.svg` |
| `gaps` | `16/universal/library-lookup.svg` |
| `hide` | `16/universal/hide.svg` |
| `group-here` | `16/universal/new-collection.svg` |
| `edit` | `16/universal/edit.svg` |
| `magnifier` | `16/universal/magnifier.svg` |
| `clear` | `16/universal/x-8.svg` |
| `chevron-12` | `16/universal/chevron-12.svg` |
| `filter` | `16/universal/filter.svg` |
| `chevron-6` | `8/universal/chevron-6.svg` |
| `collapse` | `20/universal/minimize.svg` |
| `expand` | `20/universal/maximize.svg` |
| `close` | `20/universal/x.svg` |

The only changes are mechanical: `fill="context-fill"` becomes `currentColor`,
because `context-fill` is understood by the chrome image loader and not by a
content document; and `magnifier.svg`’s `<clipPath>` is dropped, since it clips
to the full 16px box and so clips nothing.

Zotero is licensed under the GNU Affero General Public License v3.0
(`zotero/zotero`, `COPYING`), which is why this plugin is too. None of these
twenty-three files carries a licence header of its own, so the repository licence
governs them.

These are Zotero's own artwork, not Mozilla's Acorn set. Earlier revisions of
`icons.js`, and commit 6f6162e, said otherwise; that was checked against
<https://github.com/FirefoxUX/acorn-icons> and is wrong. Acorn has no icon of
any of these names, and its nearest equivalents (`edit-16`, `filter-16`,
`pin-16`) are entirely different path data in a different drawing style. The
distinction matters: Acorn is MPL-2.0 marked "Incompatible With Secondary
Licenses", which cannot be relicensed under the AGPL, whereas Zotero's own
AGPL artwork can simply be carried under this plugin's licence.

The twenty-fourth entry in `icons.js`, `isolate`, is **not** Zotero's. Nothing in
Zotero's set means what isolating a neighbourhood means, so it is drawn here:
a spotlight, on Zotero's 16px grid and at its stroke width so that it sits in
the same menu without looking borrowed. `content/icons/spotlight.svg` is the
same drawing as a file, for the chrome-side menu that cannot read the page's
copy. It is named here so the table above can be read as exhaustive:

| Name in `icons.js` | Origin |
|---|---|
| `isolate` | original to this plugin |

`content/icons/graph.svg`, the plugin's own toolbar icon, and
`content/icons/spotlight.svg` beside it are original work and are covered by
this plugin's licence.

---

## 3. Zotero platform APIs (called, not copied)

The plugin calls Zotero's own APIs at run time — `Zotero.Translate.Search`,
`Zotero.Utilities.Internal.createMenuForTarget()`, `newCollectionDialog.xhtml`
and others. Calling a published interface copies nothing and carries no notice
requirement; the entry is here only so the distinction from section 2 is on
the record.

One small exception is noted in the source: `normDoi()` in
`content/nodeLinks.js` and in `citation-graph/core/normalize.js` follows the
same normalisation rule as Zotero's own, deliberately, so that the two cannot
disagree about what a DOI is. Zotero's licence and this plugin's are the same,
so nothing further is required.

---

## 4. Data sources

Bibliographic metadata and citation counts are fetched at run time, only when
the user switches enrichment on, from the OpenAlex API
(<https://openalex.org>). OpenAlex data is released under CC0. No OpenAlex
data is redistributed with this plugin; it is fetched by the user's own
installation and cached locally.

---

## Trademark

Zotero is a registered trademark of the Corporation for Digital Scholarship.
This plugin is an independent project and is not affiliated with, endorsed by,
or sponsored by the Corporation for Digital Scholarship. See
<https://www.zotero.org/support/terms/trademark>.
