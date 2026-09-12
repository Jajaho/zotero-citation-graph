'use strict';

/**
 * An alternate text source for the reference benchmark: the PDF read with
 * GEOMETRY, laid back out as text.
 *
 * Why this exists. Every offline strategy reads `.zotero-ft-cache`, which
 * Zotero has already reflowed into one line per paragraph. Measured over 336
 * PDFs in the sample library, only 20 retain a single indented line and 145
 * have page breaks at all -- so `refParse.byIndent` decides the layout for 7
 * documents out of 336, and 99 sections still split into nothing. The
 * hypothesis that follows is that the splitter is not short of rules but short
 * of SIGNAL, and that the signal was thrown away before we ever saw the text.
 *
 * `muise-destiny-zotero-reference` is the evidence for taking it seriously: its
 * whole reference extractor is geometric -- it reads pdf.js text items and
 * reasons about indent sign and magnitude, font-height runs and column boxes.
 * None of that is available to us from the ft-cache. Rather than port their
 * engine to find out whether geometry is what makes the difference, this puts
 * geometry into OUR pipeline and changes nothing else, so the comparison
 * isolates the input.
 *
 * What it reconstructs, and why only these three things:
 *
 *   INDENTATION -- each line is prefixed with spaces proportional to its x
 *     offset from the column's left edge. This is the one signal `byIndent`
 *     wants and never gets, and it is what carries a hanging-indent
 *     bibliography that prints no markers.
 *   LINE STRUCTURE -- items are grouped into lines by baseline, so an entry
 *     spanning two lines is two lines rather than one blob, and the markers
 *     `markerRun` scans for keep their positions.
 *   COLUMNS -- items are split into columns by x-gap before being read, so a
 *     two-column page is read down one column and then the other. The
 *     extraction order of the ft-cache interleaves them, which is the documented
 *     cause of the Bertet 2001 failure in refSection.js.
 *
 * It is deliberately NOT a better text extractor in general. It does not undo
 * hyphenation, fix ligatures or repair diacritics -- the ft-cache is often
 * better at those, and improving them would confound the measurement. The only
 * variable here is layout.
 *
 * pdfjs-dist is OPTIONAL. It is a devDependency and nothing in the plugin
 * touches it; if it is missing, `load()` returns null and the caller reports the
 * text source as skipped rather than failing. That keeps `npm test` and an
 * ordinary bench run working in a checkout with no node_modules at all, which
 * is how this repo otherwise operates.
 */

const fs = require('fs');
const path = require('path');

// Same baseline counts as one line. PDF leading is well above this; a
// superscript marker or a subscript sits well inside it, which is what keeps
// "1H. Zhang" one line rather than two.
const LINE_TOLERANCE = 2.5;
// An x-gap wider than this, with nothing bridging it, is a column boundary
// rather than word spacing. Expressed in points, which is what the text-item
// transform is in.
const COLUMN_GAP = 36;
// One space per this many points of indent. Two spaces is what byIndent's
// /^\s{2,}/ needs to see, and a hanging indent is conventionally 9-18pt.
const POINTS_PER_SPACE = 4;

let pdfjs = null;
let loadFailed = null;

/**
 * The pdfjs module, or null when it is not installed.
 *
 * Resolved lazily and cached, including the failure: the bench asks once per
 * document and there is no point re-paying an import that cannot succeed.
 *
 * `PDFJS_PATH` is an escape hatch for a copy that lives outside node_modules --
 * a pdfjs shipped inside some other tool. It is for trying the idea out without
 * an install, not the supported path.
 */
async function load() {
	if (pdfjs || loadFailed) return pdfjs;
	const override = process.env.PDFJS_PATH;
	const candidates = override ? [override] : ['pdfjs-dist/legacy/build/pdf.mjs'];
	for (const c of candidates) {
		try {
			stubDom();
			const from = override ? pathToFileUrl(c) : c;
			pdfjs = await import(from);
			return pdfjs;
		}
		catch (e) { loadFailed = e; }
	}
	return null;
}

/** Why `load()` returned null, for the caller's skip message. */
function loadError() {
	return loadFailed ? (loadFailed.message || String(loadFailed)) : null;
}

function pathToFileUrl(p) {
	const abs = path.resolve(p).replace(/\\/g, '/');
	return 'file:///' + abs.replace(/^\//, '');
}

/**
 * pdfjs 6 reaches for three browser globals while its module body runs, none of
 * which text extraction ever uses -- they are on the rasterising path. Without
 * them the import throws `DOMMatrix is not defined` before a single page is
 * read.
 */
function stubDom() {
	if (!globalThis.DOMMatrix) {
		globalThis.DOMMatrix = class {
			constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
			translate() { return this; }
			scale() { return this; }
			multiply() { return this; }
			invertSelf() { return this; }
			transformPoint(p) { return p; }
		};
	}
	if (!globalThis.Path2D) globalThis.Path2D = class { addPath() {} };
	if (!globalThis.ImageData) globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; } };
}

/**
 * One PDF as layout-preserved text, or null when pdfjs is unavailable or the
 * file cannot be read.
 *
 * Pages are separated by a form feed, which is what a page-aware reader expects
 * and what the ft-cache supplies for only 43% of files.
 */
async function extract(file) {
	const lib = await load();
	if (!lib) return null;
	let doc;
	try {
		const data = new Uint8Array(fs.readFileSync(file));
		doc = await lib.getDocument({
			data,
			useWorkerFetch: false,
			isEvalSupported: false,
			useSystemFonts: false,
			// The bench reads text, never glyph outlines, and a missing standard
			// font otherwise logs on every page of every file.
			standardFontDataUrl: undefined,
		}).promise;
	}
	catch (e) { return null; }

	const pages = [];
	for (let n = 1; n <= doc.numPages; n++) {
		try {
			const page = await doc.getPage(n);
			const content = await page.getTextContent();
			const items = content.items.filter((i) => i.str && i.str.trim());
			pages.push(items.length ? layoutPage(items, page.view[2] - page.view[0]) : "");
			page.cleanup();
		}
		catch (e) { pages.push(''); }
	}
	try { await doc.destroy(); } catch (e) { /* nothing to release */ }
	return pages.join('\n\f\n');
}

/**
 * One page's items into indented lines, in READING order.
 *
 * Reading order is the whole difficulty, and it is where both obvious answers
 * fail. The ft-cache reflows the page and throws the indentation away.
 * `pdftotext -layout` keeps the indentation and the physical arrangement, which
 * on a two-column paper means the left and right columns stay side by side on
 * one text line -- measured on this benchmark it drove Barry 2020 and Blais 2021
 * from a 'heading' segmentation down to 'tail', so it is worse than the
 * ft-cache, not better.
 *
 * So the page is cut into horizontal BANDS at every full-width line, and each
 * band is read left column then right column. That is how a paper is actually
 * laid out -- a spanning title, two columns, a wide figure, two columns again --
 * and it is the arrangement under which a bibliography reads as one sequence.
 */
function layoutPage(items, pageWidth) {
	const boxes = items.map((i) => {
		// A negative width means right-to-left; normalise so x is always the
		// left edge, as mergeSameLine in their pdf.ts also has to do.
		let x = i.transform[4];
		let w = i.width;
		if (w < 0) { x += w; w = -w; }
		return { x, y: i.transform[5], w, h: i.height, str: i.str };
	});
	// Order matters and is easy to get backwards: the GUTTER has to be found
	// from the items, before anything is grouped into lines. Group first and
	// every "line" already straddles both columns, so its extent is the full
	// page width and the search for a narrow column finds nothing at all.
	const gutter = findGutter(boxes, pageWidth);
	if (gutter == null) return emitAll([lines(boxes)]);

	const left = [], right = [], span = [];
	for (const b of boxes) {
		if (b.x < gutter - COLUMN_GAP / 2 && b.x + b.w > gutter + COLUMN_GAP / 2) span.push(b);
		else (b.x + b.w / 2 < gutter ? left : right).push(b);
	}
	// A spanning line -- a title, a wide figure caption, a table rule -- closes
	// the band above it. Without that, a caption halfway down the page is read
	// between two halves of a sentence.
	const spanRows = lines(span).sort((a, b) => b[0].y - a[0].y);
	const groups = [];
	let ceiling = Infinity;
	for (const row of spanRows) {
		const y = row[0].y;
		groups.push(lines(left.filter((b) => b.y < ceiling && b.y > y)));
		groups.push(lines(right.filter((b) => b.y < ceiling && b.y > y)));
		groups.push([row]);
		ceiling = y;
	}
	groups.push(lines(left.filter((b) => b.y < ceiling)));
	groups.push(lines(right.filter((b) => b.y < ceiling)));
	return emitAll(groups);
}

/** Each group's lines, indented from that group's own left edge. */
function emitAll(groups) {
	const out = [];
	for (const g of groups) if (g.length) emit(g, out);
	return out.join('\n');
}

/**
 * The x of the column gutter, or null on a single-column page.
 *
 * Found from the lines that do NOT span the page: a spanning title or figure
 * caption crosses every candidate gutter, so including them would hide the very
 * gap being looked for. What is left is body text, and the gutter is the widest
 * vertical band in the middle of the page that no body line crosses.
 *
 * Restricted to the middle third because that is where a two-column gutter is,
 * and because the whitespace either side of a narrow centred table would
 * otherwise win.
 */
function findGutter(boxes, pageWidth) {
	const spans = boxes.filter((b) => b.w < pageWidth * 0.6).map((b) => ({ x: b.x, w: b.w }));
	if (spans.length < 20) return null;
	let best = null;
	for (let x = pageWidth * 0.35; x <= pageWidth * 0.65; x += 2) {
		if (spans.some((s) => x > s.x && x < s.x + s.w)) continue;
		if (best && x - best.end <= 2) { best.end = x; continue; }
		if (!best || best.end - best.start < 2) best = { start: x, end: x };
	}
	if (!best || best.end - best.start < COLUMN_GAP / 3) return null;
	return (best.start + best.end) / 2;
}

/**
 * The page as bands, each band a list of groups to emit in order.
 *
 * A line wider than the gutter on both sides is a spanning line and closes the
 * band before it: everything above belongs to the two columns, everything below
 * starts fresh. Without that, a mid-page figure caption would be read between
 * two halves of a sentence.
 */
function bands(rows, gutter) {
	const sorted = [...rows].sort((a, b) => b[0].y - a[0].y);
	if (gutter == null) return [[sorted]];
	const out = [];
	let left = [], right = [];
	const flush = () => {
		if (left.length || right.length) out.push([left, right].filter((g) => g.length));
		left = []; right = [];
	};
	for (const r of sorted) {
		const s = extent(r);
		if (s.x < gutter - COLUMN_GAP / 2 && s.x + s.w > gutter + COLUMN_GAP / 2) {
			flush();
			out.push([[r]]);
			continue;
		}
		(s.x + s.w / 2 < gutter ? left : right).push(r);
	}
	flush();
	return out;
}

/** One column's lines as indented text, measured from that column's own edge. */
function emit(group, out) {
	if (!group.length) return;
	const left = Math.min(...group.map((r) => extent(r).x));
	for (const r of group) {
		const indent = Math.max(0, Math.round((extent(r).x - left) / POINTS_PER_SPACE));
		const text = [...r].sort((a, b) => a.x - b.x).map((b) => b.str).join(' ').replace(/\s+/g, ' ').trim();
		if (text) out.push(' '.repeat(indent) + text);
	}
}

/** A line's horizontal extent. */
function extent(row) {
	let x = Infinity, r = -Infinity;
	for (const b of row) { if (b.x < x) x = b.x; if (b.x + b.w > r) r = b.x + b.w; }
	return { x, w: r - x };
}

/** Group one column's items into lines by baseline, top of page first. */
function lines(boxes) {
	const sorted = [...boxes].sort((a, b) => b.y - a.y);
	const out = [];
	let cur = [];
	for (const b of sorted) {
		if (!cur.length || Math.abs(cur[0].y - b.y) <= LINE_TOLERANCE) cur.push(b);
		else { out.push(cur); cur = [b]; }
	}
	if (cur.length) out.push(cur);
	return out;
}

module.exports = { extract, load, loadError };
