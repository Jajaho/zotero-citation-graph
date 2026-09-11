'use strict';

const { findDois, findArxivIds, normTitle, firstYear } = require('../core/normalize');

/**
 * Reference-string parsing: a bibliography section into individual works.
 *
 * `refSection.js` finds WHERE the references are; this decides what each one
 * SAYS. The two are separate because they fail separately -- a section found by
 * its heading can still be split wrongly, and a section guessed from the tail of
 * the document can still yield clean entries once split.
 *
 * Everything here is pure string work over text the build has already read, and
 * none of it touches the adapter, so the whole module is exercised directly by
 * tools/test-cjs-shim.js without a fixture library behind it.
 *
 * The design constraint that shapes all of it: a parsed reference has no
 * identifier. Its node key is derived from its own title (see refSignature), so
 * a title parsed two different ways out of two different PDFs is two nodes for
 * one work. Precision of the TITLE field therefore matters more here than
 * completeness of any other -- an entry we cannot title confidently is dropped,
 * never guessed at.
 */

// An entry shorter than this is page furniture -- a running header, a page
// number, a stray line of the body text above the section.
const MIN_ENTRY_CHARS = 40;
// Longer than this and the split has failed: real references, even book
// chapters with long editor lists, do not run this long. A blob this size is
// several entries that were never separated.
const MAX_ENTRY_CHARS = 1500;
// Below this a section is too short for "did the split work?" to be a
// meaningful question, so the gate does not ask it.
const GATE_MIN_SECTION = 1500;
const MIN_ENTRIES = 3;

// [1] / 1. / (1) at the head of a line, with the number captured so the run can
// be checked for ascent. The number is what tells a marker from a year.
const MARKER = /^\s*[[(]?(\d{1,3})[\]).]\s+(\S)/;
// "Smith, J." / "Smith, John" -- an author-year entry opening at column 0.
// Two forms because a style either abbreviates the given name or does not.
const SURNAME_INITIAL = /^[A-Z][a-zA-Z'\u2019-]{1,20},\s+[A-Z]\./;
const SURNAME_FULL = /^[A-Z][a-zA-Z'\u2019-]{1,20},\s+[A-Z][a-z]+/;

/**
 * Divide a reference section into one string per work.
 *
 * Tried in order of how much the layout actually tells us: an explicit marker
 * beats indentation, indentation beats blank lines, and a line that merely
 * LOOKS like the start of a reference is the last resort. Each detector either
 * produces a plausible split or declines, so a bibliography that carries no
 * structure at all ends as `layout: 'none'` rather than as one enormous entry.
 *
 * @param {string} sectionText  the section WITH its line breaks -- not the
 *   flattened form, which has thrown away every signal this reads.
 * @returns {{entries: string[], layout: 'numbered'|'hanging'|'blank'|'none'}}
 */
function splitEntries(sectionText) {
	const text = String(sectionText || '');
	if (!text.trim()) return { entries: [], layout: 'none' };
	const lines = text.split(/\r?\n/);

	for (const [layout, split] of [
		['numbered', byMarker],
		['hanging', byIndent],
		['blank', byBlankLine],
		['hanging', byLooksLikeAuthor],
	]) {
		const raw = split(lines);
		if (!raw) continue;
		const entries = clean(raw);
		if (accept(entries, text)) return { entries, layout };
	}
	return { entries: [], layout: 'none' };
}

/**
 * Is this split believable?
 *
 * The question only has an answer for a section big enough to have needed
 * splitting at all. Below that a bibliography of two entries is perfectly
 * normal and the gate must not reject it.
 */
function accept(entries, text) {
	if (!entries.length) return false;
	if (text.length < GATE_MIN_SECTION) return true;
	if (entries.length < MIN_ENTRIES) return false;
	// The median rather than the max: one over-long entry is a split that missed
	// a single boundary, which costs one work. A median this size means the
	// splitter found almost no boundaries at all.
	const lens = entries.map(e => e.length).sort((a, b) => a - b);
	return lens[lens.length >> 1] <= MAX_ENTRY_CHARS;
}

/** Trim, drop furniture, and cap the runaways. */
function clean(groups) {
	const out = [];
	for (const g of groups) {
		const s = g.join(' ').replace(/\s+/g, ' ').trim();
		if (s.length < MIN_ENTRY_CHARS) continue;
		out.push(s.length > MAX_ENTRY_CHARS ? s.slice(0, MAX_ENTRY_CHARS) : s);
	}
	return out;
}

/**
 * Numbered entries. The ascent check is the whole of the precision here: page
 * numbers, years and "3. Results" all match MARKER, and only a real reference
 * list counts 1, 2, 3... from near the top.
 */
function byMarker(lines) {
	const marks = [];
	for (let i = 0; i < lines.length; i++) {
		const m = MARKER.exec(lines[i]);
		if (m) marks.push({ i, n: Number(m[1]) });
	}
	if (marks.length < MIN_ENTRIES) return null;
	if (marks[0].n > 3) return null;
	// "Mostly" ascending: a list that restarts its numbering per section still
	// splits correctly, and one stray mis-read digit must not disqualify 60 good
	// boundaries.
	let ascending = 0;
	for (let k = 1; k < marks.length; k++) if (marks[k].n > marks[k - 1].n) ascending++;
	if (ascending < (marks.length - 1) * 0.7) return null;
	return groupAt(lines, marks.map(m => m.i));
}

/**
 * Hanging indent: an entry starts at column 0, its continuations are indented.
 * Read as "a zero-indent line that follows an indented one opens an entry", so
 * a section whose every line is flush left declines rather than claiming one
 * entry per line.
 */
function byIndent(lines) {
	const starts = [];
	let sawIndent = false;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		const indented = /^\s{2,}/.test(lines[i]);
		if (indented) { sawIndent = true; continue; }
		starts.push(i);
	}
	if (!sawIndent || starts.length < 2) return null;
	return groupAt(lines, starts);
}

/** Blank-line separated entries, which is what some extractors produce. */
function byBlankLine(lines) {
	const groups = [];
	let cur = [];
	for (const line of lines) {
		if (!line.trim()) {
			if (cur.length) groups.push(cur);
			cur = [];
			continue;
		}
		cur.push(line.trim());
	}
	if (cur.length) groups.push(cur);
	return groups.length >= 2 ? groups : null;
}

/**
 * Last resort: split before every line that reads like the head of an
 * author-year reference. This is what carries an APA or Chicago bibliography
 * whose extractor threw the indentation away.
 */
function byLooksLikeAuthor(lines) {
	const starts = [];
	for (let i = 0; i < lines.length; i++) {
		const s = lines[i].trim();
		if (SURNAME_INITIAL.test(s) || SURNAME_FULL.test(s)) starts.push(i);
	}
	return starts.length >= 2 ? groupAt(lines, starts) : null;
}

/** Collect lines into one group per start index, dropping anything before the
 *  first -- a section heading, a page header, the tail of the body text. */
function groupAt(lines, starts) {
	const groups = [];
	for (let k = 0; k < starts.length; k++) {
		const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
		const g = [];
		for (let i = starts[k]; i < end; i++) {
			const s = lines[i].trim();
			if (s) g.push(s);
		}
		if (g.length) groups.push(g);
	}
	return groups;
}

// --- style detection ------------------------------------------------------

/**
 * Words that end in a period without ending a sentence. Single capital letters
 * (author initials) are handled separately, since they cannot be enumerated.
 *
 * The second half is the ISO 4 journal-word vocabulary, and it is not padding:
 * a venue is written "Inf. Process. Lett." far more often than it is spelled
 * out, and every one of those periods is a field boundary this would otherwise
 * invent. Missing one does not merely mis-read the venue -- for the inferred
 * styles the venue is whatever follows the title, so a break inside it truncates
 * the TITLE, which is the field the node's identity is made of.
 */
const ABBREV = new Set([
	// Bibliographic furniture.
	'proc', 'proceedings', 'vol', 'no', 'nos', 'pp', 'p', 'ed', 'eds', 'edn', 'al',
	'jr', 'sr', 'st', 'trans', 'conf', 'natl', 'rev', 'univ', 'dept', 'inst',
	'inc', 'ltd', 'co', 'fig', 'figs', 'ch', 'chap', 'sec', 'suppl', 'approx', 'cf',
	'vs', 'repr', 'transl', 'tech', 'rep', 'ser', 'pt', 'esp', 'etc', 'ibid', 'diss',
	'symp', 'intl', 'abstr', 'pers', 'unpubl',
	// Journal words that cannot also be an ordinary English word in a title.
	// Anything that can -- Cell, Nature, Brain, Science, Health -- is left OUT
	// deliberately and handled by the abbreviation-run rule below: putting
	// 'cell' in here truncated "...thermometry in a living cell." at the word
	// the title ends on, which is exactly the failure this vocabulary exists to
	// prevent, aimed at the wrong field.
	'soc', 'assoc', 'sci', 'mag', 'bull', 'ann', 'int', 'inf', 'commun',
	'syst', 'comput', 'eng', 'technol', 'phys', 'chem', 'biol', 'lett', 'appl',
	'adv', 'opt', 'math', 'stat', 'educ', 'psychol', 'econ', 'manag', 'softw',
	'pract', 'exper', 'netw', 'autom', 'robot', 'mech', 'electr', 'electron',
	'environ', 'geosci', 'astron', 'nucl', 'mater', 'magn', 'spectrosc', 'anal',
	'inorg', 'polym', 'cryst', 'mol', 'neurosci', 'genet', 'immunol', 'microbiol',
	'pharmacol', 'clin', 'epidemiol', 'acad', 'philos', 'anthropol', 'linguist',
]);

/**
 * Is the period at `i` part of a run of abbreviations, as in "Inf. Process.
 * Lett."?
 *
 * The vocabulary above can never be complete -- every field abbreviates its own
 * journals -- so this catches the shape instead of the words: a short
 * capitalized token, a period, and another short capitalized token that is
 * ITSELF followed by a period. That second condition is what keeps a real title
 * intact. "...activity in the Brain. Nature, 500" has a short capitalized token
 * either side of the period too, but "Nature" is followed by a comma, so the
 * run does not continue and the period is read as the break it is.
 *
 * The residual risk is the other way round -- a title left too LONG because a
 * venue got swallowed -- and that is the safe direction here: refSignature keys
 * on the first eight words, so a title with extra tail still lands on the same
 * node, while a truncated one lands on a different one.
 */
function inAbbrevRun(s, i) {
	const before = /([A-Z][a-z]{1,6})$/.exec(s.slice(Math.max(0, i - 8), i));
	if (!before) return false;
	const after = /^\s+([A-Z][a-z]{1,6})\./.exec(s.slice(i + 1));
	return !!after;
}

/**
 * Index of the period that ends the sentence starting at `from`, or -1.
 *
 * The whole difficulty of parsing a reference string is that the period is both
 * the field separator and a character that occurs freely INSIDE two of the
 * fields -- author initials ("Smith, J. D.") and abbreviated venues ("Inf.
 * Process. Lett."). A naive indexOf('.') cuts almost every title in the corpus
 * short at its first initial, so this is the load-bearing helper here.
 */
function nextSentenceBreak(s, from) {
	for (let i = from; i < s.length; i++) {
		if (s[i] !== '.') continue;
		// A period mid-token is a decimal, a URL or an ellipsis -- never a break.
		if (i + 1 < s.length && !/[\s)\]"”]/.test(s[i + 1])) continue;
		const before = /([A-Za-z]+)$/.exec(s.slice(Math.max(0, i - 24), i));
		if (before) {
			const w = before[1];
			// A lone capital is an initial; a known abbreviation is a venue word.
			if (w.length === 1 && w === w.toUpperCase()) continue;
			if (ABBREV.has(w.toLowerCase())) continue;
		}
		if (inAbbrevRun(s, i)) continue;
		return i;
	}
	return -1;
}

const QUOTED = /[“"]([^”"]{10,300})[,.;]?[”"]/;
const PAREN_YEAR = /\((?:19|20)\d\d[a-z]?\)/;
const ACM_HEAD = /^(.+?)\.\s*((?:19|20)\d\d[a-z]?)\.\s+/;
// "Nature. 2013;500(7460):54-58." -- the year-semicolon-volume tail is the one
// thing no other style produces, so it identifies Vancouver on its own.
const VANCOUVER_TAIL = /(?:19|20)\d\d\s*;\s*\d/;

/**
 * Which grammar this bibliography is written in, decided ONCE for the whole
 * section by majority vote.
 *
 * Per-entry detection was the obvious alternative and is worse: a stylesheet
 * formats every entry in a section the same way, so an entry that looks like
 * another style is evidence of a parse problem rather than of a second style.
 * Voting lets the 39 well-formed entries decide how the 40th is read.
 */
function detectStyle(entries) {
	const n = (entries || []).length;
	if (!n) return 'generic';
	let quoted = 0, parenYear = 0, acm = 0, vancouver = 0;
	for (const e of entries) {
		if (QUOTED.test(e)) quoted++;
		if (PAREN_YEAR.test(e)) parenYear++;
		if (ACM_HEAD.test(e)) acm++;
		if (VANCOUVER_TAIL.test(e)) vancouver++;
	}
	const most = 0.4 * n;
	// Order matters: a quoted title is the strongest signal there is, because it
	// is an explicit delimiter rather than an inference about punctuation.
	if (quoted >= most) return 'ieee';
	if (vancouver >= most) return 'vancouver';
	// ACM before APA: "Smith. 2019. Title." has no parenthesised year, and an
	// APA entry never matches ACM_HEAD, so a tie cannot go the wrong way.
	if (acm >= most) return 'acm';
	if (parenYear >= most) return 'apa';
	return 'generic';
}

// --- field parsing ---------------------------------------------------------

// Venue tails that disqualify a segment from being the title, for the styles
// where the title is inferred rather than delimited.
const VENUE_MARK = /\b(vol|no|pp|pages|edition|eds?|in press|retrieved|available|doi|isbn|issn)\b\.?/i;

/**
 * One reference string into fields.
 *
 * Every field but `title` may come back null; `title` coming back null is what
 * tells the strategy to drop the entry rather than invent a node for it.
 *
 * @param {string} entry
 * @param {string} style  from detectStyle
 * @returns {{authors: ?string, surname: ?string, year: ?number, title: ?string,
 *            venue: ?string, doi: ?string, arxivId: ?string, parseConfidence: number}}
 */
function parseEntry(entry, style) {
	const raw = String(entry || '').replace(/\s+/g, ' ').trim();
	const doi = findDois(raw)[0] || null;
	const arxivId = findArxivIds(raw)[0] || null;
	// The identifier tail belongs to no field and derails the inferred parsers,
	// which would read "https://doi.org/10.1038/nature12373" as a sentence.
	// The list marker goes too, and must go HERE rather than in tidyTitle: it
	// sits in front of the author list, so leaving it on defeats every
	// anchored pattern in firstSurname and costs the first author.
	const s = raw
		.replace(/^\s*[[(]?\d{1,3}[\]).]\s+/, '')
		.replace(/\bdoi:\s*\S+/gi, ' ')
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/\barxiv:\s*\S+/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	const out = byStyle(s, style);
	out.doi = doi;
	out.arxivId = arxivId;
	out.title = tidyTitle(out.title);
	if (!out.title) out.parseConfidence = 0;
	out.surname = firstSurname(out.authors);
	if (out.year == null) out.year = firstYear(s);
	return out;
}

function byStyle(s, style) {
	switch (style) {
		case 'ieee': return parseQuoted(s);
		case 'acm': return parseAcm(s);
		case 'apa': return parseApa(s);
		case 'vancouver': return parseVancouver(s);
		default: return parseGeneric(s);
	}
}

function blank(conf) {
	return { authors: null, surname: null, year: null, title: null, venue: null, parseConfidence: conf || 0 };
}

/** IEEE and Chicago: the title is delimited, which is as good as it gets. */
function parseQuoted(s) {
	const m = QUOTED.exec(s);
	if (!m) return parseGeneric(s);
	const o = blank(0.9);
	o.title = m[1];
	o.authors = s.slice(0, m.index).replace(/[,;\s]+$/, '') || null;
	o.venue = s.slice(m.index + m[0].length).replace(/^[,.\s]+/, '') || null;
	// The LAST year in the entry, not the first: a quoted title can contain one
	// ("The 2008 crisis"), and the publication year is always in the tail.
	const years = s.match(/\b(?:19|20)\d\d\b/g);
	if (years) o.year = Number(years[years.length - 1]);
	return o;
}

/** ACM: "Jane Smith and Kim Jones. 2019. Title of the work. In Proc. X." */
function parseAcm(s) {
	const m = ACM_HEAD.exec(s);
	if (!m) return parseGeneric(s);
	const o = blank(0.85);
	o.authors = m[1] || null;
	o.year = Number(String(m[2]).slice(0, 4));
	const from = m[0].length;
	const end = nextSentenceBreak(s, from);
	o.title = end < 0 ? s.slice(from) : s.slice(from, end);
	if (end >= 0) o.venue = s.slice(end + 1).replace(/^[,.\s]+/, '') || null;
	return o;
}

/** APA: "Smith, J., & Jones, K. (2019). Title of the work. Journal, 12(3)." */
function parseApa(s) {
	const m = PAREN_YEAR.exec(s);
	if (!m) return parseGeneric(s);
	const o = blank(0.85);
	o.authors = s.slice(0, m.index).replace(/[,.\s]+$/, '') || null;
	o.year = Number(m[0].slice(1, 5));
	let from = m.index + m[0].length;
	while (from < s.length && /[.\s]/.test(s[from])) from++;
	const end = nextSentenceBreak(s, from);
	o.title = end < 0 ? s.slice(from) : s.slice(from, end);
	if (end >= 0) o.venue = s.slice(end + 1).replace(/^[,.\s]+/, '') || null;
	return o;
}

// "Smith JD, Jones K." -- a Vancouver author block, terminated by the period
// after the last author's initials. It needs its own pattern because those
// initials are exactly what nextSentenceBreak refuses to break on: a lone
// trailing capital is an initial everywhere else in a reference string, and
// here it is the one thing that ENDS the field. Reading the block instead of
// scanning for a period is what keeps "Jones K. A survey of..." from being
// swallowed whole and the venue from being returned as the title.
const VANCOUVER_AUTHORS = /^((?:[A-Z][a-zA-Z'’-]+(?:\s+[A-Z]{1,3})?,\s*)*[A-Z][a-zA-Z'’-]+\s+[A-Z]{1,3})\.\s+/;

/** Vancouver: "Smith J, Jones K. Title of the work. J Name. 2019;12:54-8." */
function parseVancouver(s) {
	const block = VANCOUVER_AUTHORS.exec(s);
	const a = block ? block[1].length : nextSentenceBreak(s, 0);
	if (a < 0) return parseGeneric(s);
	const o = blank(0.75);
	o.authors = s.slice(0, a) || null;
	const from = a + 1;
	const end = nextSentenceBreak(s, from);
	o.title = end < 0 ? s.slice(from) : s.slice(from, end);
	if (end >= 0) o.venue = s.slice(end + 1).replace(/^[,.\s]+/, '') || null;
	return o;
}

/**
 * No recognised grammar: take the most title-shaped segment there is.
 *
 * Deliberately the lowest confidence in the table. It is the difference between
 * reading a title and guessing one, and the strategy carries that difference
 * all the way to the min-confidence slider.
 */
function parseGeneric(s) {
	const segs = [];
	let from = 0;
	for (;;) {
		const end = nextSentenceBreak(s, from);
		const seg = (end < 0 ? s.slice(from) : s.slice(from, end)).trim();
		if (seg) segs.push(seg);
		if (end < 0) break;
		from = end + 1;
	}
	const o = blank(0.5);
	// Never the first segment: that is the author list in every style that gets
	// this far.
	let best = null;
	for (let i = 1; i < segs.length; i++) {
		const t = segs[i];
		if (t.split(/\s+/).filter(Boolean).length < 4 || t.length < 25) continue;
		if (VENUE_MARK.test(t)) continue;
		// Digit-heavy reads as a volume/page tail rather than as a title.
		if ((t.replace(/[^0-9]/g, '').length / t.length) > 0.15) continue;
		if (!best || t.length > best.length) best = t;
	}
	if (!best) return o;
	o.title = best;
	o.authors = segs[0] || null;
	return o;
}

/** Strip the leading marker, quotes and trailing separators a title carries. */
function tidyTitle(t) {
	if (!t) return null;
	const s = String(t)
		.replace(/^\s*[[(]?\d{1,3}[\]).]\s+/, '')
		.replace(/^["“‘']+|["”’']+$/g, '')
		.replace(/[,;:\s]+$/, '')
		.trim();
	return s.length >= 10 ? s : null;
}

/**
 * The first author's surname, which the four orderings in use put in four
 * different places: "Smith, J." (APA), "J. Smith" (IEEE), "Smith J"
 * (Vancouver), "Jane Smith" (ACM).
 *
 * Used only to corroborate a title match, never to identify a work -- see
 * refSignature for why it is kept out of the key.
 */
function firstSurname(authors) {
	if (!authors) return null;
	let a = String(authors)
		.replace(/\bet\s+al\.?/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	// The first author only: everything past the first separator is someone else.
	a = a.split(/\s+(?:and|&)\s+|;/)[0].trim();
	let m;
	// "Smith, J." / "Smith, John" -- surname first, comma-delimited.
	if ((m = /^([A-Z][a-zA-Z'’-]{1,24}),/.exec(a))) return m[1];
	// "J. Smith" / "K. M. Jones" -- initials first.
	if ((m = /^(?:[A-Z]\.\s*){1,4}([A-Z][a-zA-Z'’-]{1,24})/.exec(a))) return m[1];
	// "Smith J" / "Smith JD" -- Vancouver, no punctuation at all.
	if ((m = /^([A-Z][a-zA-Z'’-]{1,24})\s+[A-Z]{1,3}\b/.exec(a))) return m[1];
	// "Jane Smith" -- given name spelled out, so the surname is the last token
	// of the FIRST author. The comma cut matters: this style lists authors
	// "Mathieu Bastian, Sebastien Heymann, and Mathieu Jacomy", and without it
	// the scan from the right returns the second author's surname. The three
	// patterns above are anchored and ran already, so narrowing here cannot
	// take anything away from them.
	const parts = a.split(',')[0].split(/\s+/).filter(Boolean);
	for (let i = parts.length - 1; i >= 0; i--) {
		if (/^[A-Z][a-zA-Z'’-]{1,24}$/.test(parts[i])) return parts[i];
	}
	return null;
}

// --- identity --------------------------------------------------------------

// Under this a title is too generic to BE an identity -- "Introduction",
// "Ibid.", a truncated fragment. Such an entry is dropped, not keyed.
const MIN_TITLE_CHARS = 20;
// Enough of a title to be unique in practice, short enough that a difference in
// the tail -- a subtitle one style prints and another drops -- does not split
// one work into two nodes.
const SIGNATURE_WORDS = 8;
const SIGNATURE_CHARS = 60;

/**
 * The node key for a work known only by its reference string.
 *
 * Keyed on the TITLE ALONE, deliberately. The surname is the flakiest field
 * here -- four orderings, initials or not, OCR damage on the accented ones --
 * and the year is routinely absent or belongs to a reprint. Putting either in
 * the key fragments one work into several ghosts far more often than it tells
 * two works apart, and a fragmented ghost is an invisible one: it is the
 * citedBy count that decides whether a node is drawn at all.
 *
 * Two genuinely different works agreeing on their first eight title words is
 * rare enough to accept. A preprint and its published version merging into one
 * node is the known cost, and for a citation graph that is arguably right.
 *
 * Readable rather than hashed, because this string is what the debug log, the
 * CLI comparison output and ghostLabel's fallback all show.
 *
 * @returns {?string} the id half of a 'ref:' key, or null when unusable
 */
function refSignature(parsed) {
	const nt = normTitle(parsed && parsed.title);
	if (nt.length < MIN_TITLE_CHARS) return null;
	let slug = nt.split(' ').filter(Boolean).slice(0, SIGNATURE_WORDS).join('-');
	if (slug.length > SIGNATURE_CHARS) slug = slug.slice(0, SIGNATURE_CHARS).replace(/-[^-]*$/, '');
	return slug || null;
}

module.exports = {
	splitEntries,
	detectStyle,
	parseEntry,
	refSignature,
	nextSentenceBreak,
	MIN_ENTRY_CHARS,
	MAX_ENTRY_CHARS,
	MIN_TITLE_CHARS,
};
