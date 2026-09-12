'use strict';

/**
 * Shared normalization. Every provider must use these so that identifiers
 * produced by different strategies compare equal.
 */

// `<` and `>` are in the body class because DOIs registered before about 2005
// embed them: 10.1002/1521-396X(200009)181:1<99::AID-PSSA99>3.0.CO;2-5 is one
// DOI, not a DOI followed by markup. Leaving them out truncated every legacy
// Wiley reference at the bracket, which does not fail loudly -- it mints a
// plausible-looking node that resolves to nothing.
const DOI_RE = /10\.\d{4,9}\/[-._;()\/:<>a-zA-Z0-9]+/;
const DOI_RE_G = new RegExp(DOI_RE.source, 'g');

// Tails of a publisher's URL, not of the DOI inside it. Frontiers links read
// .../10.3389/fncom.2013.00137/abstract and Wiley's .../00445.x/epdf, so a DOI
// harvested out of a link annotation arrives with the page kind glued on.
const URL_TAIL_RE = /\/(abstract|epdf|full|pdf|meta|html|summary)$/;

/**
 * Strip resolver prefixes and URL tails, lowercase, drop trailing sentence
 * punctuation.
 */
function normDoi(raw) {
	if (!raw) return null;
	// Decoded here as well as in findDois, because callers hand this a whole
	// URL: a DOI that reached us as a link is percent-encoded, and normalizing
	// without decoding first leaves two spellings of one identifier.
	let d = decodePercentEscapes(String(raw).trim()).toLowerCase()
		.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
		.replace(/^doi:\s*/, '')
		.replace(/[.,;:\]]+$/, '')
		.replace(URL_TAIL_RE, '');
	d = stripUnmatchedCloser(d);
	return /^10\.\d{4,9}\//.test(d) ? d : null;
}

/**
 * Drop a trailing `)` only when it closes nothing the DOI itself opened.
 *
 * Both spellings occur and they need opposite treatment. A DOI written inside
 * a parenthesis -- "(see 10.1234/abc)" -- picks up a closer that is the
 * sentence's, not its own. A 1960s Elsevier DOI carries its own:
 * 10.1016/0017-9310(69)90011-8. Stripping unconditionally, as this did, cut
 * that one to `10.1016/0017-9310(69` -- a string no resolver knows, minting a
 * ghost node for a paper that does exist and is cited right there.
 *
 * Counting is enough to tell them apart: strip while there are more closers
 * than openers. Measured against the 8,107 DOIs Crossref deposited for the
 * sample library, not one has unbalanced parentheses.
 */
function stripUnmatchedCloser(d) {
	let s = d;
	for (;;) {
		if (!s.endsWith(')')) return s;
		const open = (s.match(/\(/g) || []).length;
		const close = (s.match(/\)/g) || []).length;
		if (close <= open) return s;
		s = s.slice(0, -1).replace(/[.,;:\]]+$/, '');
	}
}

/**
 * Percent-escapes, decoded. A DOI reaching us through a link annotation is a
 * URL, so its reserved characters arrive encoded -- %3C for the `<` above. The
 * DOI pattern stops dead at the `%`, so this has to happen before matching, not
 * after. Malformed escapes are left alone rather than throwing.
 */
function decodePercentEscapes(s) {
	return String(s).replace(/%[0-9A-Fa-f]{2}/g, (m) => {
		try { return decodeURIComponent(m); } catch (_) { return m; }
	});
}

/**
 * Repair a DOI broken across a line break.
 *
 * flattenPdfText joins wrapped lines with a space, which is right for prose and
 * wrong inside an identifier: `https://doi.org/10.\n1073/pnas.1601513113`
 * becomes `10. 1073/pnas...` and matches nothing at all, while `10.1038/\nlsa…`
 * becomes `10.1038/ lsa…` and matches a prefix that is not a DOI anyone holds.
 *
 * Each rule below only closes a gap that a DOI cannot legally contain, and each
 * demands evidence that what follows is a continuation rather than the next
 * sentence:
 *
 *   after the `10.` prefix   -- the registrant code is digits, so digits follow
 *   after the prefix slash   -- a DOI is never empty there, and the suffix that
 *                               follows must contain a digit, which keeps prose
 *                               ("10.1038/ and see...") from being swallowed
 *   after an interior . or / -- only when a DIGIT follows, so a reference ending
 *                               "...nature12373. Smith et al." is left alone
 *   before a . and a digit   -- APS prints `10.1103/PhysRevLett .125.260502`,
 *                               and a DOI followed by " .5" is not a sentence
 *   after a BALANCED )       -- `10.1016/0017-9310(69) 90011-8` continues; the
 *                               closer the DOI opened itself is the evidence,
 *                               which is what keeps "(see 10.1234/abc) 5" out
 *   after an interior .      -- when a word CARRYING A DIGIT follows, for
 *                               Elsevier's `10.1016/j. ijthermalsci.2021` and
 *                               OSA's `10.1364/CLEO_SI.2019. STu4O.7`. The
 *                               digit is the whole guard: it has to fall before
 *                               the next space, so "...nature12373. Smith et
 *                               al." and "...nature12373. See also" are left
 *                               alone, having none
 *   before a ( that continues -- `10.1016/S1369-8001 (03)00075-1`, where the
 *                               bracket group is followed by a digit. A year in
 *                               parentheses is not: "nature12373 (2013)." ends
 *                               at the closer, and is left alone
 *
 * These are not hypotheses. Each was read out of a PDF in the sample library
 * whose citation went missing because of it, and each cost a real edge.
 */
function healDoiLineBreaks(s) {
	return String(s)
		.replace(/(\b10\.)[ \t]+(?=\d{4,9})/g, '$1')
		.replace(/(\b10\.\d{4,9}\/)[ \t]+(?=[-._;()\/:<>a-zA-Z0-9]*\d)/g, '$1')
		.replace(/(\b10\.\d{4,9}\/[-._;()\/:<>a-zA-Z0-9]*[.\/])[ \t]+(?=\d)/g, '$1')
		.replace(/(\b10\.\d{4,9}\/[-._;()\/:<>a-zA-Z0-9]*[a-zA-Z0-9])[ \t]+(?=\.\d)/g, '$1')
		.replace(/(\b10\.\d{4,9}\/[-._;()\/:<>a-zA-Z0-9]*\))[ \t]+(?=\d)/g,
			(m, doi) => ((doi.match(/\(/g) || []).length === (doi.match(/\)/g) || []).length ? doi : m))
		.replace(/(\b10\.\d{4,9}\/[-._;()\/:<>a-zA-Z0-9]*\.)[ \t]+(?=[A-Za-z]{2,}[-._;()\/:<>A-Za-z0-9]*\d)/g, '$1')
		.replace(/(\b10\.\d{4,9}\/[-._;()\/:<>a-zA-Z0-9]*[a-zA-Z0-9])[ \t]+(?=\(\d{1,4}\)\d)/g, '$1');
}

/**
 * XML character entities, decoded.
 *
 * A link annotation is not always clean URL text. AIP deposits the legacy
 * Wiley DOI 10.1002/1521-3978(200009)48:9/11<771::AID-PROP771>3.0.CO;2-E with
 * its angle brackets written `&tnqx3c;` and `&tnqx3e;` -- their typesetting
 * system's spelling of `&#x3c;` -- and the DOI pattern stops dead at the `&`,
 * cutting the identifier in half. Numeric and named forms are decoded too,
 * since the same round trip produces all three.
 */
function decodeXmlEntities(s) {
	return String(s)
		.replace(/&(?:tnqx|#x)([0-9a-fA-F]{2,4});/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/&#(\d{2,5});/g, (m, dec) => String.fromCharCode(Number(dec)))
		.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

/**
 * All DOIs occurring in a blob of text, de-duplicated and normalized.
 *
 * A match whose suffix carries no digit at all is dropped. Every DOI that
 * reaches us cut short by an extraction artefact ends that way -- `10.1016/j`,
 * `10.1103/physrevlett` -- and of the 8,107 DOIs Crossref deposited for the
 * sample library, not one does. Emitting them is worse than emitting nothing:
 * a truncated DOI is not a missing edge but a ghost node, a work that exists
 * under no such identifier and that nobody can have cited.
 */
function findDois(text) {
	if (!text) return [];
	const prepared = healDoiLineBreaks(decodeXmlEntities(decodePercentEscapes(text)));
	const out = new Set();
	for (const m of prepared.match(DOI_RE_G) || []) {
		const d = normDoi(m);
		if (d && /\d/.test(d.slice(d.indexOf('/') + 1))) out.add(d);
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

module.exports = { DOI_RE, normDoi, findDois, findArxivIds, normTitle, flattenPdfText, firstYear,
	decodePercentEscapes, healDoiLineBreaks };
