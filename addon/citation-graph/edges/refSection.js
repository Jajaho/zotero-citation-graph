'use strict';

const { flattenPdfText } = require('../core/normalize');
const { markerRun } = require('./refParse');

/**
 * Reference-section segmentation.
 *
 * Measured on the sample library: a heading regex alone finds the bibliography
 * in only 48% of PDFs, and the tail-of-document fallback used for the rest is
 * the prime suspect for the title matcher's false positives (see the
 * feasibility study, "The precision caveat"). Segmentation therefore lives in
 * its own module with a declared quality level, so callers can require a
 * confident segmentation and providers can down-weight edges drawn from a
 * guessed one.
 *
 * @returns {{text: string, flat: string, quality: 'heading'|'numbered'|'tail'|'none'}}
 */

const HEADING = /^\s*(\d+\.?\s*)?(references|bibliography|literature cited|works cited|references and notes|reference list)\s*:?\s*$/i;
// A numbered entry: [1] / 1. / (1) at the head of a line. The marker's NUMBER
// is captured, because what chains one entry to the next is that the numbers
// climb rather than that the lines are adjacent -- see step 2.
const NUMBERED = /^\s*[\[(]?(\d{1,3})[\]).]\s+\S/;

function segment(text, { tailFraction = 0.4, minNumberedRun = 5, maxNumberedFraction = 0.5 } = {}) {
	if (!text || text.length < 200) return { text: '', flat: '', quality: 'none' };
	const lines = text.split(/\r?\n/);

	// 1. Explicit heading, searched from the end (papers cite the word
	//    "references" in body text far more often than they head a section
	//    with it).
	for (let i = lines.length - 1; i >= 0; i--) {
		if (HEADING.test(lines[i])) {
			const t = lines.slice(i + 1).join('\n');
			if (t.trim().length > 100) return finish(t, 'heading');
		}
	}

	// 2. No heading: the last run of numbered entries, from where it really
	//    starts.
	//
	//    Runs are chained by their MARKER NUMBERS rather than by the lines
	//    between them, because what separates one entry from the next in a
	//    bibliography is nothing at all -- an entry wraps onto a continuation
	//    line, and whether that line is indented is a fact about the PDF
	//    extractor, not about the document. Counting consecutive numbered
	//    LINES made every unindented wrap end the run and start a new one, so
	//    the last surviving run was whatever tail of the list happened to be
	//    typeset without a wrap. Two Wiley papers in the sample library lost
	//    references [1] through [21] that way: the section began at [22],
	//    which is a reference list with its first twenty-one entries cut off.
	//
	//    Ascending, and by a small step, is what keeps this from chaining
	//    across a document: a bibliography numbers 1, 2, 3 in order, while the
	//    stray bracketed numbers in body text do not climb.
	const marks = [];
	for (let i = 0; i < lines.length; i++) {
		const m = NUMBERED.exec(lines[i]);
		if (m) marks.push({ line: i, n: Number(m[1]) });
	}
	const chains = [];
	for (const mark of marks) {
		const last = chains.length ? chains[chains.length - 1] : null;
		const prev = last && last[last.length - 1];
		// A gap in LINES is allowed and expected -- that is the wrapped text of
		// the entry before -- but a gap of forty says the list ended and
		// something else began.
		if (prev && mark.n > prev.n && mark.n - prev.n <= 3 && mark.line - prev.line <= 40) {
			last.push(mark);
		}
		else { chains.push([mark]); }
	}
	// The last chain long enough to be a bibliography, preferring later ones:
	// a paper's own reference list sits below any numbered list in its body.
	// A chain whose start would claim most of the document is not one -- see
	// the Bertet 2001 note below, which is the same failure a step earlier.
	let bestStart = -1;
	for (let i = chains.length - 1; i >= 0; i--) {
		if (chains[i].length < minNumberedRun) continue;
		const start = chains[i][0].line;
		const t = lines.slice(start).join('\n');
		if (t.length <= text.length * maxNumberedFraction) { bestStart = start; break; }
	}
	if (bestStart >= 0) {
		const t = lines.slice(bestStart).join('\n');
		if (t.trim().length > 100) return finish(t, 'numbered');
	}

	// 2b. A whole bibliography on ONE line, which the run above cannot see
	//     because it counts lines rather than markers. Britton 2012 is the case:
	//     the word "references" does not occur anywhere in its extracted text,
	//     so step 1 has nothing to find, and all forty entries sit on a single
	//     line, so step 2 sees a run of one. It was falling through to the tail
	//     and taking half the body text with it.
	//
	//     The earliest such line wins: a reference list is followed by methods
	//     and supplementary material often enough that the last one would be a
	//     different list entirely.
	//
	//     Bounded to a minority of the document, which is what stops this from
	//     firing on body text. Bertet 2001 is the case: a two-column Nature page
	//     whose extraction interleaves the neighbouring article, so a numbered
	//     run appears near the top and an unbounded match claimed 96% of the
	//     file and called its own body text a reference list. A real
	//     bibliography is a tail, not a document.
	for (let i = 0; i < lines.length; i++) {
		const run = markerRun(lines[i], { minRun: minNumberedRun });
		if (!run) continue;
		const t = lines.slice(i).join('\n');
		if (t.trim().length > 100 && t.length <= text.length * maxNumberedFraction) {
			return finish(t, 'numbered');
		}
	}

	// 3. Last resort: the tail of the document. Low quality by construction --
	//    it sweeps in body text, appendices and footnotes.
	return finish(text.slice(Math.floor(text.length * (1 - tailFraction))), 'tail');
}

function finish(t, quality) {
	return { text: t, flat: flattenPdfText(t), quality };
}

/**
 * One attachment's reference section, or null when it has no text.
 *
 * `memo` is the per-build cache graphBuilder hands every provider as
 * ctx.refSection: two strategies read the same attachments, and each used to
 * read the file and segment it again for itself. Without one this does
 * exactly that, so a provider driven from outside build() still works.
 *
 * @returns {Promise<?{flat: string, quality: string}>}
 */
async function readSection(adapter, attKey, memo) {
	if (memo) return memo(attKey);
	const text = await adapter.getAttachmentText(attKey);
	return text ? segment(text) : null;
}

module.exports = { segment, readSection };
