#!/usr/bin/env node
/**
 * Print how to open the rendering benchmark inside Zotero.
 *
 * There is only one place worth running it: Zotero itself, over resource://,
 * which is why the page lives under addon/content/bench/ rather than here. A
 * file:// copy opened in a browser would measure a different rasteriser at a
 * different devicePixelRatio and report it in the same table, which is worse
 * than not measuring at all.
 *
 * The first attempt at this pointed openDialog() at a file:// URL and got a
 * blank window: a chrome-privileged window will not load a top-level file://
 * document, and the CSP it carries blocks inline <script> besides. Both are
 * fixed by serving the page out of the plugin -- resource: is exactly what
 * that CSP does allow -- so the snippet below is the one that works.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const RES_ROOT = 'zotero-citation-graph';
const page = path.join(__dirname, '..', '..', 'addon', 'content', 'bench', 'bench.html');
if (!fs.existsSync(page)) {
	console.error('missing ' + page);
	process.exit(1);
}
const url = `resource://${RES_ROOT}/content/bench/bench.html`;

console.log(`
Label rendering benchmark

  Zotero -> Tools -> Developer -> Run JavaScript, then run:

    Zotero.getMainWindow().openDialog(
        '${url}',
        'zg-bench', 'chrome,centerscreen,resizable,width=1150,height=950');

  The window should come up titled "Label rendering benchmark - ready".
  If it is blank, the plugin build you are running does not carry the page:

    dev install   tools/install-dev.ps1 serves addon/ directly and always has it
    packed XPI    npm run build -- --with-bench

  A release XPI leaves the benchmark out on purpose -- see tools/build-xpi.js.
  What it measures, and why the numbers can be trusted: tools/bench/README.md
`);
