#!/usr/bin/env node
/**
 * Print how to open the rendering benchmark, and open it in the default
 * browser if asked.
 *
 * Deliberately not "just open it": the numbers that matter come from Zotero's
 * own engine, and silently launching Chrome would hand back Skia's figures
 * under a heading that says Zotero. So the Zotero route is printed first and
 * the browser is opt-in.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const page = path.join(__dirname, 'labels.html');
if (!fs.existsSync(page)) {
	console.error('missing ' + page);
	process.exit(1);
}
const url = 'file:///' + page.replace(/\\/g, '/');

console.log('\nLabel rendering benchmark\n');
console.log('  In Zotero (accurate) -- Tools > Developer > Run JavaScript:\n');
console.log("    Zotero.getMainWindow().openDialog(");
console.log("        '" + url + "',");
console.log("        'zg-bench', 'chrome,centerscreen,resizable,width=1100,height=900');\n");
console.log('  In Firefox (close proxy; Zotero 7 is Firefox 115 ESR):\n');
console.log('    ' + url + '\n');
console.log('  See tools/bench/README.md for what is measured and why.\n');

if (!process.argv.includes('--open')) {
	console.log('  Re-run with --open to launch it in the default browser.\n');
	return;
}

// Whatever the default browser is, which may well not be Gecko -- the page
// detects that and says so in its own header rather than trusting this.
const cmd = process.platform === 'win32'
	? { file: 'cmd', args: ['/c', 'start', '', url] }
	: process.platform === 'darwin'
		? { file: 'open', args: [url] }
		: { file: 'xdg-open', args: [url] };
execFile(cmd.file, cmd.args, (err) => {
	if (err) console.error('could not open a browser: ' + err.message);
});
