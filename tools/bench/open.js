#!/usr/bin/env node
'use strict';

/**
 * Print how to open the rendering benchmark by hand.
 *
 * Two places, and they answer different questions. Zotero itself gives the
 * absolute numbers, because it is the thing being tuned. Firefox gives the
 * comparisons, because it can be driven from a script -- that is `npm run
 * bench`, and it is the one used far more often.
 *
 * The first version of this pointed openDialog() at a file:// URL and got a
 * blank window: a chrome-privileged window will not load a top-level file://
 * document, and the CSP it carries blocks inline <script> besides. Serving the
 * page out of the plugin fixes the first, and keeping the harness in its own
 * file fixes the second -- resource: is exactly what that CSP allows.
 */

const fs = require('fs');
const path = require('path');

const RES_ROOT = 'zotero-citation-graph';
const page = path.join(__dirname, '..', '..', 'addon', 'content', 'bench', 'bench.html');
if (!fs.existsSync(page)) {
	console.error('missing ' + page);
	process.exit(1);
}
const url = `resource://${RES_ROOT}/content/bench/bench.html`;

console.log(`
Graph rendering benchmark

  Automated, in Firefox -- what you want for "did that change help?":

    npm run bench                          all scenarios
    npm run bench -- --json before.json    keep a baseline
    npm run bench -- --baseline before.json    compare against it

  By hand, in Zotero -- what you want for absolute numbers, since this is
  the renderer being tuned. Tools -> Developer -> Run JavaScript:

    Zotero.getMainWindow().openDialog(
        '${url}',
        'zg-bench', 'chrome,centerscreen,resizable,width=1250,height=980');

  The window should come up titled "Graph rendering benchmark - ready".
  If it is blank, the build you are running does not carry the page:

    dev install   tools/install-dev.ps1 serves addon/ directly and always has it
    packed XPI    npm run build -- --with-bench

  By hand, in Firefox, without the runner:

    npm run bench:serve      then open the URL it prints

  A release XPI leaves the benchmark out on purpose -- see tools/build-xpi.js.
  What it measures and why the numbers can be trusted: tools/bench/README.md
`);
