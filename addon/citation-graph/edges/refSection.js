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
// A numbered-entry run: several lines starting [1] / 1. / (1) close together.
const NUMBERED = /^\s*[\[(]?\d{1,3}[\]).]\s+\S/;

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

	// 2. No heading: find the last sustained run of numbered entries.
	let runStart = -1, run = 0, bestStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (NUMBERED.test(lines[i])) {
			if (run === 0) runStart = i;
			run++;
			if (run >= minNumberedRun) bestStart = runStart;
		}
		else if (lines[i].trim() === '') {
			// blank lines do not break a run
		}
		else if (run > 0 && !/^\s{2,}\S/.test(lines[i])) {
			run = 0;
		}
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
