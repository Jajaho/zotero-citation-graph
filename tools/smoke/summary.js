'use strict';

/**
 * A smoke report (tools/smoke/run.js) as Markdown, for a GitHub job summary.
 *
 * The run's page is where a failed weekly job gets looked at first, so it has
 * to say there which Zotero it met, which locale failed which case, and what
 * the console said about the plugin -- without downloading the report. The
 * allow.json entries are listed even on a pass: they are known bugs (#34)
 * that only stay visible if something keeps showing them.
 *
 * Usage: node tools/smoke/summary.js <report.json> [--label <which Zotero>]
 *        --label is shown as given, e.g. "beta channel"; --channel beta is
 *        the same as --label "beta channel".
 * Prints to stdout. A report that is missing or unreadable is said so, not
 * thrown: the summary step must never be what fails a job.
 */

const fs = require('fs');

const argv = process.argv.slice(2);
const valueOf = (name) => {
	const i = argv.indexOf('--' + name);
	return i === -1 ? null : argv[i + 1];
};
const reportPath = argv.find((a, i) => !a.startsWith('--') && !['--channel', '--label'].includes(argv[i - 1]));
const label = valueOf('label') || (valueOf('channel') && valueOf('channel') + ' channel');

/** One line of message text, safe inside a Markdown code span. */
function code(s, max = 200) {
	let t = String(s == null ? '' : s).replace(/\r/g, '\\r').replace(/\n/g, '\\n').trim();
	if (t.length > max) t = t.slice(0, max) + '…';
	return '`' + t.replace(/`/g, '\'') + '`';
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

/** Messages grouped by level and text: "62x `Parser error: …` (de-DE, en-US)". */
function grouped(list, withReason) {
	const groups = new Map();
	for (const m of list) {
		const key = m.level + ' ' + m.message;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(m);
	}
	return [...groups.values()].map((ms) => {
		const locales = [...new Set(ms.map((m) => m.locale).filter(Boolean))].sort();
		return '- ' + ms[0].level + ', ' + (ms.length > 1 ? ms.length + 'x ' : '') + code(ms[0].message)
			+ (locales.length ? ' (' + locales.join(', ') + ')' : '')
			+ (withReason && ms[0].reason ? ': ' + ms[0].reason : '');
	});
}

function render(r) {
	const out = [];
	const z = r.zotero || {};
	const con = r.console || {};
	const list = (k) => (Array.isArray(con[k]) ? con[k] : []);
	const count = (k) => (Array.isArray(con[k]) ? con[k].length : Number(con[k]) || 0);

	const about = [label, z.gecko && 'Gecko ' + z.gecko].filter(Boolean);
	out.push('### Smoke test on Zotero ' + (z.version || '?') + (about.length ? ' (' + about.join(', ') + ')' : '')
		+ ': ' + (r.ok ? 'PASS' : 'FAIL'));
	out.push('');
	if (r.error) out.push('**Error:** ' + code(r.error, 600), '');

	// Locales in the order run.js ran them; cases carry theirs as "[xx-YY] ".
	const cases = Array.isArray(r.cases) ? r.cases : [];
	const localeOf = (name) => (String(name).match(/^\[([^\]]+)\] /) || [])[1] || '';
	const locales = [...new Set([...(r.runs || []).map((x) => x.locale), ...cases.map((c) => localeOf(c.name))])]
		.filter(Boolean);
	if (locales.length) {
		out.push('| Locale | Cases passed | Plugin errors | Plugin warnings | Allowed |');
		out.push('|---|---|---|---|---|');
		for (const l of locales) {
			const cs = cases.filter((c) => localeOf(c.name) === l);
			const n = (k) => list(k).filter((m) => m.locale === l).length;
			out.push('| ' + cell(l) + ' | ' + cs.filter((c) => c.ok).length + ' / ' + cs.length
				+ ' | ' + n('errors') + ' | ' + n('warnings') + ' | ' + n('allowed') + ' |');
		}
		out.push('');
	}

	const failed = cases.filter((c) => !c.ok);
	if (failed.length) {
		out.push('**Failed cases**', '');
		for (const c of failed) out.push('- ' + cell(c.name) + ' (' + c.ms + ' ms)' + (c.error ? ': ' + code(c.error) : ''));
		out.push('');
	}
	if (list('errors').length) out.push('**Plugin errors**', '', ...grouped(list('errors')), '');
	if (list('warnings').length) out.push('**Plugin warnings**', '', ...grouped(list('warnings')), '');
	if (list('allowed').length) {
		out.push('**Allowed by tools/smoke/allow.json** (not failing)', '', ...grouped(list('allowed'), true), '');
	}

	const net = Array.isArray(r.network) ? r.network : [];
	const blocked = net.filter((x) => !x.allowed);
	if (blocked.length) {
		out.push('**Requests that left the machine**', '');
		for (const x of blocked.slice(0, 20)) {
			out.push('- ' + code((x.method || '') + ' ' + x.url) + (x.ours ? ' (the plugin\'s)' : ' (Zotero\'s own)'));
		}
		if (blocked.length > 20) out.push('- … and ' + (blocked.length - 20) + ' more');
		out.push('');
	}

	const notes = [];
	if (count('droppedMatching')) notes.push(count('droppedMatching') + ' plugin messages dropped by the helper');
	if (count('unattributed')) notes.push(count('unattributed') + ' unattributed errors');
	notes.push(count('ignored') + ' of Zotero\'s own errors ignored');
	if (r.cleanupFailed) notes.push('**cleanup failed**: a Zotero process or temp directory was left behind');
	out.push(notes.join('; ') + '.');
	return out.join('\n');
}

let text;
try {
	text = render(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
}
catch (e) {
	text = '### Smoke test' + (label ? ' (' + label + ')' : '') + ': no readable report\n\n'
		+ code(e.message, 400) + '\n\nThe run ended before it wrote one; see the step\'s log.';
}
process.stdout.write(text + '\n');
