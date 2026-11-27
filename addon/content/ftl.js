/**
 * The plugin's strings, formatted by Fluent's own runtime on both sides of the
 * bridge.
 *
 * The plugin's strings live in addon/locale/<locale>/zotero-citation-graph.ftl, which is
 * where Zotero already looks: plugins.js registerLocales() reads every .ftl
 * under a plugin's locale/ into a global L10nRegistry source, with a per-file
 * fallback chain (exact locale -> same language -> en-US). That machinery is
 * what renders the collection menu's label, and it is not duplicated here.
 *
 * What IS duplicated is the formatting, and for one reason: the graph page runs
 * with an ordinary content principal inside a <browser type="content">. The
 * Localization constructor is [ChromeOnly], and document.l10n -- if a
 * resource:// content document gets one at all -- formats asynchronously, which
 * a canvas tooltip accessor called sixty times a second cannot wait for. So
 * chrome reads the .ftl for the resolved locale, hands the source across the
 * bridge as a string like every other payload, and both sides format from it
 * synchronously through this module.
 *
 * That constraint rules out Gecko's Fluent, not Fluent: @fluent/bundle, the
 * official JavaScript implementation (vendor/fluent-bundle.js), formats
 * synchronously and needs no privilege. This file only adapts it to what the
 * callers have always asked for. The .ftl files are therefore full Fluent --
 * selects, nested selects, message references, NUMBER() -- and `npm test`
 * checks them with the reference parser (tools/vendor/fluent-syntax.js), the
 * grammar Zotero's own bundle reads the same files with.
 *
 * What this adds on top of a FluentBundle:
 *
 *   - Ids are asked for without the plugin's prefix, and an attribute as
 *     "id.attribute"; see bundle().
 *   - A missing id comes back as the id itself, and a missing variable as
 *     `{$name}`: either is visible on screen, which is the point.
 *   - Formatting errors go to a reporter, once per message, instead of being
 *     thrown or dropped.
 *   - Callers pass numbers as numbers, never pre-formatted. A number prints
 *     as String() prints it unless the message asks for { NUMBER($x) }, which
 *     groups it in the bundle's locale (1,234 / 1.234); see value(). Today
 *     progress-count, tooltip-cited-here, tooltip-cited-global and
 *     tooltip-citations-total ask for it.
 *   - No bidi isolation marks: the strings are drawn on a canvas and into
 *     chrome text, where FSI/PDI would show as boxes or stray spacing.
 *
 * Dual-mode: a plain <script> in the graph page (window.ZGFtl, after
 * vendor/fluent-bundle.js has set window.FluentBundle) and a CommonJS module in
 * the chrome sandbox (lib/l10n.js requires it, and it requires the runtime).
 * Same file either way, the way nodeFilters.js is the same file under Zotero
 * and under Node.
 */
(function (root, factory) {
	'use strict';
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = factory(require('./vendor/fluent-bundle.js'));
	}
	else root.ZGFtl = factory(root.FluentBundle);
}(typeof window !== 'undefined' ? window : this, function (Fluent) {
	'use strict';

	var FluentBundle = Fluent.FluentBundle;
	var FluentResource = Fluent.FluentResource;
	var FluentNumber = Fluent.FluentNumber;
	var FluentType = Fluent.FluentType;

	/** Where errors go when a caller names nowhere else. */
	function consoleReport(e) {
		if (typeof console !== 'undefined' && console.error) console.error(e);
	}

	/**
	 * The locale list for a FluentBundle, which is what its Intl.PluralRules
	 * are built for. No locale means the runtime's own; a malformed one means
	 * English rules rather than a RangeError out of every select.
	 */
	function localesFor(locale) {
		if (!locale) return [];
		try {
			return Intl.getCanonicalLocales(locale);
		}
		catch (e) {
			return ['en-US'];
		}
	}

	// Parsed sources, newest last. A handful, because the same file is turned
	// into a bundle by both l10n modules and by every check that tests one; the
	// point is that nothing parses a source twice in a row.
	var _compiled = new Map();
	var COMPILED_MAX = 8;

	/**
	 * A FluentBundle for `source`, parsed once.
	 *
	 * The runtime's parser skips what it cannot read, as Gecko's does: a broken
	 * message is missing from the bundle, so its id shows on screen. `npm test`
	 * is where a broken message is reported, by the reference parser.
	 */
	function compile(source, locale, report) {
		var key = (locale || '') + '\u0000' + source;
		var hit = _compiled.get(key);
		if (hit) {
			// Refresh its place, so the eviction below takes the stalest.
			_compiled.delete(key);
			_compiled.set(key, hit);
			return hit;
		}
		var fb = new FluentBundle(localesFor(locale), { useIsolating: false });
		var errors = fb.addResource(new FluentResource(source));
		// A duplicate id: the first definition wins, which a translator who
		// meant the second would never find out about otherwise.
		for (var i = 0; i < errors.length; i++) safely(report, errors[i]);
		_compiled.set(key, fb);
		if (_compiled.size > COMPILED_MAX) _compiled.delete(_compiled.keys().next().value);
		return fb;
	}

	function safely(report, e) {
		try {
			(report || consoleReport)(e);
		}
		catch (ignored) {
			// A reporter that throws must not take the string down with it.
		}
	}

	/** toString() for a number as its caller wrote it. See value(). */
	function asWritten() {
		return this.text;
	}

	// A string of plain ASCII digits is taken for the number it spells, so "3"
	// picks a plural variant the way 3 does. Nothing with a separator in it:
	// "1.000" is a thousand in German and one in English, and a string a
	// caller has already formatted is not a number this can know.
	var DIGITS = /^[0-9]+$/;

	/**
	 * One argument, as the runtime is to see it.
	 *
	 * A number stays a FluentNumber, so a select still picks its variant by the
	 * locale's CLDR plural rules -- but it prints as String() prints it, not as
	 * Intl.NumberFormat would. Years are numbers here ("is 2013 or later"), and
	 * grouping would print 2,013. Where a count reads better grouped, the
	 * message says so with NUMBER($count), which Fluent formats in the bundle's
	 * locale -- so callers pass the number, never toLocaleString(), which would
	 * group it in whatever locale the runtime happens to have and leave
	 * nothing for a select or NUMBER() to read.
	 *
	 * Anything else that is not a string is printed with String() too, as it
	 * always was, rather than becoming a "type not supported" hole.
	 */
	function value(v) {
		if (typeof v === 'string') {
			if (!DIGITS.test(v)) return v;
			var s = new FluentNumber(Number(v));
			s.text = v;
			s.toString = asWritten;
			return s;
		}
		if (typeof v === 'number') {
			var n = new FluentNumber(v);
			n.text = String(v);
			n.toString = asWritten;
			return n;
		}
		if (v instanceof FluentType) return v;
		return String(v);
	}

	/**
	 * The arguments for one call: shared ones first, the caller's over them.
	 *
	 * A null or undefined argument is left out, so the runtime reports it as
	 * missing and prints `{$name}` -- a hole that says which variable it is,
	 * rather than an empty string that says nothing.
	 */
	function fill(args, shared) {
		var out = Object.create(null);
		var name;
		if (shared) for (name in shared) if (shared[name] != null) out[name] = value(shared[name]);
		if (args) {
			for (name in args) {
				if (args[name] == null) delete out[name];
				else out[name] = value(args[name]);
			}
		}
		return out;
	}

	/**
	 * Format one pattern, reporting what went wrong at most once per `key`.
	 *
	 * The runtime never throws here when given an errors array: it formats what
	 * it can -- `{$count}` for a missing variable, `{NAME()}` for an unknown
	 * function -- and lists the rest. Those reach the reporter once per message,
	 * because a tooltip formats sixty times a second and one bad string would
	 * otherwise fill the console.
	 */
	function run(fb, pattern, args, key, seen, report) {
		var errors = [];
		var out = fb.formatPattern(pattern, args, errors);
		if (errors.length && !seen.has(key)) {
			seen.add(key);
			var why = [];
			for (var i = 0; i < errors.length; i++) why.push(errors[i] && errors[i].message);
			safely(report, new Error('Fluent: ' + key
				+ (fb.locales.length ? ' (' + fb.locales.join(', ') + ')' : '') + ': ' + why.join('; ')));
		}
		return out;
	}

	/**
	 * Source text to { id: pattern source }, attributes as "id.attribute".
	 *
	 * Not used to format anything: bundle() formats from the runtime's own
	 * parse. This is a view of the file for checks that read the strings as a
	 * translator wrote them -- which variables a message uses, whether it names
	 * a key -- and the text it returns is what format() accepts.
	 *
	 * It splits the file at the lines that start an entry or an attribute and
	 * keeps each pattern's lines as written, so a multi-line select stays one.
	 * A message with no value of its own, one that exists only to carry
	 * attributes, is not listed under its bare id. `npm test` checks that this
	 * lists exactly the messages and attributes the runtime does.
	 */
	function parse(source) {
		var out = Object.create(null);
		var lines = String(source == null ? '' : source).split(/\r?\n/);
		var key = null;   // where the lines being collected will be stored
		var base = null;  // the message an attribute line would hang off
		var buf = [];

		function flush() {
			if (key !== null) {
				var text = buf.join('\n').replace(/\s+$/, '');
				if (/\S/.test(text)) out[key] = text;
			}
			key = null;
			buf = [];
		}

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			var m;
			if ((m = line.match(/^([A-Za-z][\w-]*) *= *(.*)$/))) {
				flush();
				base = key = m[1];
				buf.push(m[2]);
			}
			else if (base !== null && (m = line.match(/^ *\.([A-Za-z][\w-]*) *= *(.*)$/))) {
				flush();
				key = base + '.' + m[1];
				buf.push(m[2]);
			}
			// Fluent continues a pattern on an indented or blank line, and on
			// one that starts a variant or closes a select.
			else if (base !== null && /^(?: |[}[*]|$)/.test(line)) {
				buf.push(line);
			}
			// Anything else at the start of a line -- a comment, a term -- ends
			// the entry.
			else {
				flush();
				base = null;
			}
		}
		flush();
		return out;
	}

	// format()'s parsed patterns, by locale and text, and the ones already
	// reported. Both are emptied together at PATTERNS_MAX, so a caller feeding
	// format() ever-new text cannot grow either without bound; a pattern
	// reported before the reset may be reported once more after it.
	var _patterns = new Map();
	var PATTERNS_MAX = 500;
	var _patternsSeen = new Set();

	/**
	 * Format one pattern's source text, as parse() returns it.
	 *
	 * For checks and one-off strings; a caller formatting the same file over
	 * and over wants bundle(), which parses it once. A pattern the runtime
	 * cannot read comes back as written, so it is visible, and is reported.
	 */
	function format(pattern, args, locale) {
		var text = String(pattern == null ? '' : pattern);
		var key = (locale || '') + '\u0000' + text;
		var hit = _patterns.get(key);
		if (!hit) {
			// A line the pattern continues on has to be indented to be one.
			var src = 'x =' + (text.charAt(0) === '\n' ? '' : ' ')
				+ text.replace(/\n(?=[^ \n])/g, '\n ') + '\n';
			var fb = new FluentBundle(localesFor(locale), { useIsolating: false });
			fb.addResource(new FluentResource(src));
			var msg = fb.getMessage('x');
			hit = { fb: fb, value: msg && msg.value };
			if (_patterns.size >= PATTERNS_MAX) {
				_patterns.clear();
				_patternsSeen.clear();
			}
			_patterns.set(key, hit);
		}
		if (!hit.value) {
			if (!_patternsSeen.has(text)) {
				_patternsSeen.add(text);
				safely(null, new Error('Fluent: cannot parse ' + JSON.stringify(text)));
			}
			return text;
		}
		return run(hit.fb, hit.value, fill(args, null), text, _patternsSeen, null);
	}

	/**
	 * A parsed file, ready to be asked for strings.
	 *
	 * `prefix` is prepended to every id on the way in, so call sites read
	 * `t('legend-outside')` while the file keeps the fully qualified
	 * `zotero-citation-graph-legend-outside` -- ids reach a shared bundle when Zotero
	 * loads the .ftl into a window document, and a plugin has no business
	 * claiming a bare name there.
	 *
	 * A missing id comes back as the id itself. Blank would hide the mistake at
	 * exactly the moment it matters; the id on screen says which string is
	 * missing and from which file.
	 *
	 * `report`, if given, receives an Error for each message that formatted
	 * with errors, once per message; without it they go to console.error.
	 */
	function bundle(source, locale, prefix, report) {
		var src = String(source == null ? '' : source);
		var fb = compile(src, locale, report);
		var pre = prefix || '';
		var shared = null;
		var seen = new Set();
		var messages = null;

		/** The runtime's pattern for "id" or "id.attribute", or null. */
		function lookup(key) {
			var dot = key.indexOf('.');
			var msg = fb.getMessage(dot < 0 ? key : key.slice(0, dot));
			if (!msg) return null;
			if (dot < 0) return msg.value;
			return msg.attributes[key.slice(dot + 1)] || null;
		}

		var api = {
			locale: locale || null,
			/** parse() of the source, for reading; worked out when first asked. */
			get messages() {
				if (!messages) messages = parse(src);
				return messages;
			},
			has: function (id) {
				return lookup(pre + id) !== null;
			},
			/**
			 * A variable every message may use without its caller passing it.
			 * A caller's own argument of the same name still wins.
			 */
			share: function (name, value) {
				if (!shared) shared = Object.create(null);
				shared[name] = value;
			},
			/**
			 * Share `$mod`, the key that adds to a pick: Ctrl, and Cmd on a
			 * Mac, where the page has always read either and the strings said
			 * "Ctrl" regardless -- the one key that does something else there,
			 * since Ctrl-click raises the context menu. Each locale names the
			 * two itself (key-mod, key-mod-mac); "Strg" is a translation.
			 */
			shareModifier: function (mac) {
				var id = mac ? 'key-mod-mac' : 'key-mod';
				api.share('mod', api.has(id) ? api.t(id) : (mac ? '⌘' : 'Ctrl'));
			},
			t: function (id, args) {
				var key = pre + id;
				var pattern = lookup(key);
				if (pattern === null) return id;
				// A plain string has nothing to fill, and is most of the file.
				if (typeof pattern === 'string') return fb.formatPattern(pattern);
				return run(fb, pattern, fill(args, shared), key, seen, report);
			},
		};
		return api;
	}

	return { parse: parse, format: format, bundle: bundle };
}));
