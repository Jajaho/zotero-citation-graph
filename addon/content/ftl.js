/**
 * A small Fluent reader, shared by both sides of the bridge.
 *
 * The plugin's strings live in addon/locale/<locale>/zotero-graph.ftl, which is
 * where Zotero already looks: plugins.js registerLocales() reads every .ftl
 * under a plugin's locale/ into a global L10nRegistry source, with a per-file
 * fallback chain (exact locale -> same language -> en-US). That machinery is
 * what renders the collection menu's label, and it is not duplicated here.
 *
 * What IS duplicated is the reading of a pattern, and for one reason: the graph
 * page runs with an ordinary content principal inside a <browser type="content">.
 * The Localization constructor is [ChromeOnly], and document.l10n -- if a
 * resource:// content document gets one at all -- formats asynchronously, which
 * a canvas tooltip accessor called sixty times a second cannot wait for. So
 * chrome reads the .ftl for the resolved locale, hands the source across the
 * bridge as a string like every other payload, and both sides format from it
 * synchronously through this module. One source of truth, no async in a render
 * path, and nothing that depends on privilege the page does not have.
 *
 * The subset is deliberately small -- it is a plugin's UI strings, not a
 * localisation runtime:
 *
 *     id = plain text
 *     id = a { $variable } in it
 *     id = { $count -> [one] one thing *[other] { $count } things }
 *     id =
 *         .attribute = for XUL, stored as "id.attribute"
 *     id = { " leading and trailing space is quoted " }
 *
 * Not supported, and not needed by this plugin: message and term references,
 * selectors nested inside a variant, functions (NUMBER, DATETIME), and multiline
 * patterns that mean to keep their line breaks. A placeable this cannot read is
 * left in the output verbatim, so it shows up as `{ whatever }` on screen rather
 * than silently becoming an empty string.
 *
 * Dual-mode: a plain <script> in the graph page (window.ZGFtl) and a CommonJS
 * module in the chrome sandbox (lib/l10n.js requires it). Same file either way,
 * the way nodeFilters.js is the same file under Zotero and under Node.
 */
(function (root, factory) {
	'use strict';
	var api = factory();
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.ZGFtl = api;
}(typeof window !== 'undefined' ? window : this, function () {
	'use strict';

	/**
	 * Source text to { id: pattern }.
	 *
	 * Attributes are flattened into the same map under "id.attribute", which is
	 * all this needs them for -- nothing here ever asks for a message and its
	 * attributes as one object.
	 */
	function parse(source) {
		var out = Object.create(null);
		var lines = String(source == null ? '' : source).split(/\r?\n/);
		var key = null;   // where the lines being collected will be stored
		var base = null;  // the message an attribute line would hang off
		var buf = [];

		function flush() {
			// A message with no value of its own -- one that exists only to carry
			// attributes -- is not stored, so asking for it reads as missing
			// rather than as the empty string.
			if (key !== null && buf.length) out[key] = buf.join('\n');
			key = null;
			buf = [];
		}

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			var m;
			// Comments and blank lines end whatever was being collected: in
			// Fluent a pattern cannot have a hole in it.
			if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
				flush();
				continue;
			}
			if ((m = line.match(/^([A-Za-z][\w-]*)\s*=[ \t]*(.*)$/))) {
				flush();
				base = m[1];
				key = m[1];
				if (m[2] !== '') buf.push(m[2]);
				continue;
			}
			if (base !== null && (m = line.match(/^[ \t]+\.([A-Za-z][\w-]*)\s*=[ \t]*(.*)$/))) {
				flush();
				key = base + '.' + m[1];
				if (m[2] !== '') buf.push(m[2]);
				continue;
			}
			// A continuation: a translator's wrapped line. Joined with a space
			// rather than a newline, because every pattern in this plugin is one
			// line of prose that happened to be too long for the file.
			if (key !== null && /^[ \t]/.test(line)) {
				buf.push(line.trim());
				continue;
			}
			flush();
		}
		flush();

		// Re-join wrapped lines. Done here rather than in flush() so the buffer
		// stays a plain list of lines while it is being collected.
		for (var id in out) out[id] = out[id].split('\n').join(' ');
		return out;
	}

	/** The index of the '}' closing the '{' at `start`, or -1. */
	function closing(s, start) {
		var depth = 0;
		for (var i = start; i < s.length; i++) {
			if (s[i] === '{') depth++;
			else if (s[i] === '}' && --depth === 0) return i;
		}
		return -1;
	}

	function format(pattern, args, locale) {
		var s = String(pattern == null ? '' : pattern);
		var out = '';
		var i = 0;
		while (i < s.length) {
			if (s[i] !== '{') {
				out += s[i++];
				continue;
			}
			var end = closing(s, i);
			if (end < 0) {
				// An unbalanced brace is a broken translation, not a reason to
				// lose the rest of the string.
				out += s.slice(i);
				break;
			}
			out += placeable(s.slice(i + 1, end), args || {}, locale);
			i = end + 1;
		}
		return out;
	}

	function placeable(inner, args, locale) {
		var s = inner.trim();
		var m;
		if ((m = s.match(/^\$([A-Za-z][\w-]*)\s*->\s*([\s\S]*)$/))) {
			return select(args[m[1]], m[2], args, locale);
		}
		if ((m = s.match(/^\$([A-Za-z][\w-]*)$/))) {
			return args[m[1]] == null ? '' : String(args[m[1]]);
		}
		// The Fluent way to write a pattern whose edges are whitespace, which
		// the file format would otherwise trim away.
		if ((m = s.match(/^"([\s\S]*)"$/))) return m[1];
		return '{' + inner + '}';
	}

	/**
	 * Pick a variant for `value`.
	 *
	 * An exact key wins over a plural category, so `[0] nothing yet` can special-
	 * case a count that the CLDR category `other` would otherwise swallow. The
	 * starred variant is the fallback, which Fluent requires every selector to
	 * have -- but a file missing one still resolves to something rather than
	 * throwing, since a translation error must not take the UI down.
	 */
	function select(value, body, args, locale) {
		var variants = [];
		var re = /(\*)?\[[ \t]*([^\]]*?)[ \t]*\]/g;
		var m;
		var last = null;
		while ((m = re.exec(body))) {
			if (last) last.text = body.slice(last.at, m.index);
			last = { def: !!m[1], key: m[2], at: re.lastIndex, text: '' };
			variants.push(last);
		}
		if (last) last.text = body.slice(last.at);
		if (!variants.length) return '';

		var want = value == null ? '' : String(value);
		var pick = null;
		for (var i = 0; i < variants.length && !pick; i++) {
			if (variants[i].key === want) pick = variants[i];
		}
		if (!pick) {
			var cat = category(value, locale);
			for (var j = 0; j < variants.length && !pick; j++) {
				if (variants[j].key === cat) pick = variants[j];
			}
		}
		for (var k = 0; k < variants.length && !pick; k++) {
			if (variants[k].def) pick = variants[k];
		}
		if (!pick) pick = variants[0];
		return format(pick.text.trim(), args, locale);
	}

	var _rules = Object.create(null);

	/** The CLDR plural category, so a translator can write the forms their own
	 *  language needs rather than the two English happens to have. */
	function category(value, locale) {
		if (value == null || value === '' || !isFinite(value)) return null;
		var key = locale || '';
		if (!(key in _rules)) {
			try {
				_rules[key] = new Intl.PluralRules(locale || undefined);
			}
			catch (e) {
				_rules[key] = null;
			}
		}
		if (!_rules[key]) return Number(value) === 1 ? 'one' : 'other';
		return _rules[key].select(Number(value));
	}

	/**
	 * A parsed file, ready to be asked for strings.
	 *
	 * `prefix` is prepended to every id on the way in, so call sites read
	 * `t('legend-outside')` while the file keeps the fully qualified
	 * `zotero-graph-legend-outside` -- ids reach a shared bundle when Zotero
	 * loads the .ftl into a window document, and a plugin has no business
	 * claiming a bare name there.
	 *
	 * A missing id comes back as the id itself. Blank would hide the mistake at
	 * exactly the moment it matters; the id on screen says which string is
	 * missing and from which file.
	 */
	function bundle(source, locale, prefix) {
		var messages = parse(source);
		var pre = prefix || '';
		return {
			locale: locale || null,
			messages: messages,
			has: function (id) {
				return (pre + id) in messages;
			},
			t: function (id, args) {
				var pattern = messages[pre + id];
				if (pattern == null) return id;
				return format(pattern, args, locale);
			},
		};
	}

	return { parse: parse, format: format, bundle: bundle };
}));
