'use strict';

/**
 * Shared normalization. Every provider must use these so that identifiers
 * produced by different strategies compare equal.
 */

const DOI_RE = /10\.\d{4,9}\/[-._;()\/:a-zA-Z0-9]+/;
const DOI_RE_G = new RegExp(DOI_RE.source, 'g');

/** Strip resolver prefixes, lowercase, drop trailing sentence punctuation. */
function normDoi(raw) {
	if (!raw) return null;
	let d = String(raw).trim().toLowerCase()
		.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
		.replace(/^doi:\s*/, '')
		.replace(/[.,;:)\]]+$/, '');
	return /^10\.\d{4,9}\//.test(d) ? d : null;
}

/** All DOIs occurring in a blob of text, de-duplicated and normalized. */
function findDois(text) {
	if (!text) return [];
	const out = new Set();
	for (const m of String(text).match(DOI_RE_G) || []) {
		const d = normDoi(m);
		if (d) out.add(d);
	}
	return [...out];
}

function findArxivIds(text) {
	if (!text) return [];
	const out = new Set();
	const re = /arxiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?/gi;
	let m;
	while ((m = re.exec(String(text)))) out.add(m[1]);
	return [...out];
}

/**
 * Aggressive title normalization for substring matching: fold accents, drop all
 * punctuation, collapse whitespace. Deliberately lossy -- it must survive
 * hyphenation, ligatures and inconsistent casing across PDF extractors.
 */
function normTitle(s) {
	return String(s || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Undo PDF line wrapping so titles and DOIs are not split across lines. */
function flattenPdfText(s) {
	return String(s || '')
		.replace(/-\r?\n\s*/g, '')
		.replace(/\r?\n/g, ' ')
		.replace(/\s+/g, ' ');
}

function firstYear(s) {
	const m = String(s || '').match(/\b(1[89]\d\d|20\d\d)\b/);
	return m ? Number(m[1]) : null;
}

module.exports = { DOI_RE, normDoi, findDois, findArxivIds, normTitle, flattenPdfText, firstYear };
