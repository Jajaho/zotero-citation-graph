# Contributing

Bug reports, pull requests and translations are all welcome. Work happens on
`dev`; `main` is what CI gates.

## Translations

The plugin ships `en-US` and `de-DE`. Adding a language is the most useful
contribution that needs no knowledge of the codebase — it is one text file and a
one-word edit.

> [!WARNING]  
> If you graciously decide to contribute a translation I expect you to be a native speaker or at least be highly fluent in the language. Feel free to use AI for assistance but you yourself should be able to verify it's correctness. 

### Where the strings live

```
addon/locale/en-US/zotero-citation-graph.ftl   <- the source of truth
addon/locale/de-DE/zotero-citation-graph.ftl   <- a complete translation to copy from
```

They are [Fluent](https://projectfluent.org/) (`.ftl`) files: one message per
line, `id = text`. Every id is prefixed `zotero-citation-graph-`, because Zotero
loads a plugin's `.ftl` into the main window's own bundle alongside core's
strings and every other plugin's.

### Adding a language

1. Copy `addon/locale/en-US/zotero-citation-graph.ftl` to
   `addon/locale/<code>/zotero-citation-graph.ftl`, where `<code>` is a BCP-47
   tag such as `fr-FR` or `pt-BR`.
2. Translate the values on the right of each `=`. **Leave every id unchanged.**
3. Add `<code>` to `LOCALES` in [`addon/lib/l10n.js`](addon/lib/l10n.js):
   ```js
   const LOCALES = ['en-US', 'de-DE', 'fr-FR'];
   ```
   This is needed for the translation to take effect in Zotero.
4. Run `npm test`. It checks that every shipped locale is declared in
   `l10n.js` and vice versa, that every locale carries the same message list as
   `en-US`, and that every message fills the same variables as its `en-US`
   original. A translation that drops a message or a `{ $variable }` fails the
   suite.
5. Open a pull request against `dev`, saying which Zotero version and OS you
   tried it on. Zotero picks the locale through
   `Utilities.Internal.resolveLocale`, so exact tag → same language → `en-US`;
   testing means running Zotero in your language and clicking through the graph
   tab, the sidebar sections, the node menu and the *What's missing?* pane (canvas context menu -> right sidebar).

### Rules the file has to keep

- **One message per line.** A wrapped line is joined back with a space, which is
  right for prose and wrong for anything that meant to keep a line break.
- **Keep the ids.** Call sites look messages up by id; changing one removes the
  string from the UI.
- **Keep the variables.** `{ $count }`, `{ $shown }`, `{ $total }` and friends
  are filled in at runtime. They may be reordered to suit your grammar, but all
  of them must appear.
- **Plurals are Fluent selectors**, and your language's categories are not
  necessarily English's:
  ```
  zotero-citation-graph-stats-edges = { $count -> [one] { $count } edge *[other] { $count } edges }
  ```
  The starred variant is the default and must be present. Languages with more
  than two categories may add `[few]`, `[many]` and so on.
- **The graph page formats these with a Fluent subset**
  ([`addon/content/ftl.js`](addon/content/ftl.js)). Variables and plural
  selectors work; message references, nested selectors and functions do not.
  Do not reach for them.
- **Do not translate the English fallbacks in markup.** Static elements in
  `addon/content/graph.html` carry `data-zg-str="<id without the prefix>"` and an
  English body as the fallback shown before the bundle resolves. The translation
  belongs in the `.ftl`, not there.
- **Match Zotero's capitalisation conventions** as your language uses them.
  English keeps section titles in Title Case and every label, option and legend
  entry under them in sentence case.
- Comments in the `.ftl` (lines starting with `#`) explain where a string is
  shown and are worth reading before translating one. Translate them or keep
  them in English, whichever helps the next translator; `de-DE` keeps its own.

### Fixing an existing translation

Same flow, minus steps 1 and 3: edit the file, run `npm test`, open a PR. Small
wording fixes are welcome and do not need a bug report first if you want to fix them yourself. Otherwise feel free to open an issue and I'll fix them.
