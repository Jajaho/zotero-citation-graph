# Citation Graph for Zotero -- user-facing strings.
#
# Every id is prefixed `zotero-citation-graph-`, because Zotero loads a plugin's .ftl
# into the main window's own bundle, alongside core's strings and every other
# plugin's. Both sides of the bridge prepend the prefix themselves, so call
# sites read t('legend-outside') while the file keeps the qualified name.
#
# The graph page formats these with content/ftl.js, a Fluent subset. Variables
# and plural selectors work; message references, nested selectors and functions
# do not. Keep each message on one line -- a wrapped line is joined back with a
# space, which is right for prose and wrong for anything that meant to keep a
# line break.
#
# Adding a locale: create locale/<code>/zotero-citation-graph.ftl and add <code> to
# LOCALES in lib/l10n.js. `npm test` checks the two against each other, and
# against this file's message list.


## The collection menu.
#
# This one is resolved by Zotero's own Fluent, not by ftl.js: MenuManager reads
# it from the main window's bundle through the l10nID on the menu entry.

zotero-citation-graph-view-citation-graph =
    .label = View Citation Graph


## The sidebar's sections.
#
# The settings are four collapsible sections down the sidebar rather than one
# panel called "settings", so a question has a section to be asked in and the
# answer is not four scrolls away from it. The two tooltips below are shared by
# all four: the title beside the twisty already says which one is being folded.
#
# Capitalised as Zotero capitalises its own panes: section titles in Title Case,
# every label, option and legend entry under them in sentence case.

zotero-citation-graph-section-collapse = Collapse this section
zotero-citation-graph-section-expand = Show this section

# What each anchor, edge and node is pulled by. Layout only: nothing enters or
# leaves the graph when one of these moves.
zotero-citation-graph-section-forces = Force Adjustment
# Which items are on the canvas at all.
zotero-citation-graph-section-items = Item Selection
# How the items that are there are drawn.
zotero-citation-graph-section-display = Graph Display
# Where the edges between them are read from.
zotero-citation-graph-section-strategies = Referencing Strategies

zotero-citation-graph-scope-subcollections = Subcollections
zotero-citation-graph-scope-subcollections-hint = Include items from every subcollection
zotero-citation-graph-scope-external = Outside refs
zotero-citation-graph-scope-external-hint = Show cited works that are not in the collection
zotero-citation-graph-scope-min-cites = Cited by ≥
zotero-citation-graph-scope-min-cites-hint = Hide outside works cited by fewer than this many of your papers
zotero-citation-graph-scope-enrich = Query node metadata
zotero-citation-graph-scope-enrich-hint = Look up citation counts, and titles and authors for outside works (uses the OpenAlex API)

# Whether the names an outside reference already has are left off the canvas.
# Nothing is fetched for this one -- that is the entry above.
zotero-citation-graph-scope-hide-external-names = Hide outside names
zotero-citation-graph-scope-hide-external-names-hint = Leave the names off every outside reference, so they are drawn as unlabelled dots.

zotero-citation-graph-color-by = Colour
zotero-citation-graph-color-by-year = Year
zotero-citation-graph-color-by-collection = Collection
zotero-citation-graph-color-by-cluster = Subfield
zotero-citation-graph-color-by-author = First author
zotero-citation-graph-color-by-publication = Publication
zotero-citation-graph-color-by-type = Item type

zotero-citation-graph-size-by = Size
zotero-citation-graph-size-by-here = Cited here
zotero-citation-graph-size-by-global = Global citations

zotero-citation-graph-link-pull = Edge pull
zotero-citation-graph-link-pull-hint = How hard a link pulls its two nodes together. Lower spreads a crowded graph out.

zotero-citation-graph-center-pull = Centre pull
zotero-citation-graph-center-pull-hint = How hard the middle of the canvas holds every node. At 0 unconnected papers drift away; higher packs the graph tighter.

# Every anchor's strength at once, not one anchor's own: the flags are planted
# on the canvas, but how hard they pull is a layout setting like the two above.
zotero-citation-graph-group-pull = Group pull
zotero-citation-graph-group-pull-hint = How hard every anchor pulls the papers it names. At 0 they name them without moving them.

zotero-citation-graph-pin-pull = Pin pull
zotero-citation-graph-pin-pull-hint = How much harder a pinned node's own citation links pull. At 0 a pin holds only the node it is on.
zotero-citation-graph-settle = Stop at energy
zotero-citation-graph-settle-hint = The energy below which the layout stops moving. Higher stops sooner, before every node has found its place; at 0 it never stops.
zotero-citation-graph-settle-never = never

# What a big collection gives up in order to stay smooth. The hint names the
# losses rather than promising a gain: what it buys back depends on the graph and
# the machine, and only the user can see both.
zotero-citation-graph-perf-mode = Performance mode
zotero-citation-graph-perf-hint = Draw a big graph faster: the layout is struck once and stands still instead of settling for fifteen seconds, and edges give up their arrows, their curve and their strategy colours. Names are untouched, and nodes still move when you drag them.

zotero-citation-graph-item-pane-failed = Could not open Zotero's item pane here.

zotero-citation-graph-filter-placeholder = Filter — author:, year:, …
zotero-citation-graph-filter-hint = Type a term, or field:value. Filters stack: each one narrows what is left.

zotero-citation-graph-min-confidence = Min confidence
zotero-citation-graph-hide-isolated = Hide unconnected
zotero-citation-graph-isolate-depth = Isolation depth
zotero-citation-graph-isolate-depth-hint = How many edges out from an isolated node stays lit. 0 lights the isolated nodes and nothing else.
zotero-citation-graph-rebuild = Rebuild

# Tooltips for the sidebar controls that had none. One per strategy, because
# the page only ever sees their ids; strategy-other-hint is for any new one.
zotero-citation-graph-min-confidence-hint = Hide edges less certain than this. Every strategy rates how sure it is of each edge it finds; at 0 all of them are drawn.
zotero-citation-graph-hide-isolated-hint = Leave out papers that have no edge left on the graph as it is filtered now.
zotero-citation-graph-size-by-hint = What a node's size shows: how many papers here cite it, or how often it is cited worldwide (turns on "Query node metadata").
zotero-citation-graph-color-by-hint = What a node's colour shows. The key underneath lists the colours on screen.
zotero-citation-graph-rebuild-hint = Build the graph again from the collection as it is now.
zotero-citation-graph-strategy-pdf-links-hint = DOI hyperlinks inside your PDFs. Untick to hide the edges only this strategy found.
zotero-citation-graph-strategy-text-doi-hint = DOIs printed in the reference lists of your papers' indexed text. Untick to hide the edges only this strategy found.
zotero-citation-graph-strategy-title-match-hint = Titles of papers in this collection found in another paper's reference section. Untick to hide the edges only this strategy found.
zotero-citation-graph-strategy-openalex-hint = The works OpenAlex lists as referenced by each paper. Untick to hide the edges only this strategy found.
zotero-citation-graph-strategy-openalex-run = OpenAlex references
zotero-citation-graph-strategy-openalex-run-hint = Ask OpenAlex which works each paper with a DOI cites, which finds references in PDFs that neither link nor print DOIs (uses the OpenAlex API; answers are cached for 30 days). The outside works it finds are named only with "Query node metadata" on.
zotero-citation-graph-strategy-other-hint = Untick to hide the edges only this strategy found.

zotero-citation-graph-reframe-hint = Fit the whole graph in view

## The top bar: the two pane toggles, and the search field.

zotero-citation-graph-side-toggle-hide = Hide the sidebar
zotero-citation-graph-side-toggle-show = Show the sidebar

# The button that brings the item pane back, at the other end of the bar. Only
# one string, because the button is only there while the pane is away: putting
# it away is done from the pane's own sidenav, which is Zotero's "Toggle Item
# Pane" and is on screen exactly when this button is not.
zotero-citation-graph-pane-toggle-show = Show the item pane

zotero-citation-graph-search-placeholder = Search
zotero-citation-graph-search-hint = Find a paper on the canvas and go to it (Ctrl+F). This does not filter the graph — Advanced Search (Ctrl+Shift+F) and the filter box in the sidebar do that.
zotero-citation-graph-search-mode = Quick Search mode
zotero-citation-graph-search-advanced = Advanced Search
zotero-citation-graph-adv-collapse = Collapse Advanced Search
zotero-citation-graph-adv-expand = Expand Advanced Search
zotero-citation-graph-adv-close = Close Advanced Search
zotero-citation-graph-search-clear = Clear
zotero-citation-graph-search-empty = No paper on screen matches


## Status line.

zotero-citation-graph-status-loading = Loading…
zotero-citation-graph-status-rebuilding = Rebuilding…
zotero-citation-graph-status-looking-up = Looking up names…
zotero-citation-graph-status-dropping-names = Dropping looked-up names…
zotero-citation-graph-bad-payload = Bad payload: { $message }

# The counts under the panel. Joined with " · " in the order they appear here.
zotero-citation-graph-stats-items = { $shown } / { $total } items
zotero-citation-graph-stats-outside = { $count } outside
zotero-citation-graph-stats-named = ({ $count } named)
zotero-citation-graph-stats-edges = { $count -> [one] { $count } edge *[other] { $count } edges }
zotero-citation-graph-stats-building = Building…


## The legend.

zotero-citation-graph-legend-outside = Outside refs
zotero-citation-graph-legend-no-date = No date
zotero-citation-graph-legend-more = +{ $count } more
zotero-citation-graph-legend-row-hint = { $label } — { $count -> [one] { $count } node *[other] { $count } nodes }
# How trustworthy the subfield split is: modularity below about 0.3 means the
# clusters are more the algorithm than the library.
zotero-citation-graph-legend-cluster-quality = { $count -> [one] { $count } subfield *[other] { $count } subfields }, modularity { $q }

# Colour keys for held items missing the facet being coloured by.
zotero-citation-graph-color-no-collection = (No collection)
zotero-citation-graph-color-no-cluster = (No subfield)
# A subfield whose members share no word worth naming it after.
zotero-citation-graph-color-cluster-n = Subfield { $n }
zotero-citation-graph-color-no-author = (No author)
zotero-citation-graph-color-no-publication = (No publication)
zotero-citation-graph-color-unknown-type = (Unknown type)


## Node tooltips.

zotero-citation-graph-tooltip-not-in-collection = Not in collection — { $title }
zotero-citation-graph-tooltip-cited-here = cited by { $count } here
zotero-citation-graph-tooltip-citations-total = { $count } citations total
zotero-citation-graph-tooltip-pinned = pinned
zotero-citation-graph-tooltip-et-al = { $names } et al.
zotero-citation-graph-tooltip-actions = click to pick (Ctrl to add) · double-click to isolate · right-click for actions


## Filter chips and the completion list.

# Two names per facet, and they are not the same thing.
#
# field-* is the label: a noun phrase, shown on the chip and beside a value in
# the completion list, and free to be as long as it needs to be.
#
# fieldkey-* is the keyword the filter box parses -- what goes before the colon.
# One word, no space and no colon in it, because everything up to the first
# colon is the field name and a space in the middle would make the mask
# unreadable; nodeFilters.js falls back to the English keyword for anything that
# breaks that rule. Capitalise it however the language does -- English writes
# its keywords in lower case, German capitalises its nouns and writes "Jahr" -- since
# what is typed is matched case-insensitively either way. The English keywords
# are always accepted as well as the translated ones, so a mask written in one
# language still opens in another.
zotero-citation-graph-field-author = Author
zotero-citation-graph-field-year = Year
zotero-citation-graph-field-tag = Tag
zotero-citation-graph-field-type = Item type
zotero-citation-graph-field-publication = Publication
zotero-citation-graph-field-collection = Collection
zotero-citation-graph-field-cluster = Subfield
zotero-citation-graph-field-title = Title

zotero-citation-graph-fieldkey-author = author
zotero-citation-graph-fieldkey-year = year
zotero-citation-graph-fieldkey-tag = tag
zotero-citation-graph-fieldkey-type = type
zotero-citation-graph-fieldkey-publication = publication
zotero-citation-graph-fieldkey-collection = collection
zotero-citation-graph-fieldkey-cluster = subfield
zotero-citation-graph-fieldkey-title = title

# The chip's own short label for a mask that is not scoped to one field.
zotero-citation-graph-field-any-short = Any
# The same mask, spelled out in the chip's tooltip.
zotero-citation-graph-field-any = Any field

zotero-citation-graph-chip-remove = Lift this mask
zotero-citation-graph-chip-click-to-edit = Click to edit
# The terms of one mask, joined. They widen the mask, hence "or".
zotero-citation-graph-chip-or-join = { ", or " }
zotero-citation-graph-chip-is = is { $value }
zotero-citation-graph-chip-between = is between { $lo } and { $hi }
zotero-citation-graph-chip-or-later = is { $year } or later
zotero-citation-graph-chip-or-earlier = is { $year } or earlier
zotero-citation-graph-chip-is-exactly = is exactly "{ $value }"
zotero-citation-graph-chip-contains = contains "{ $value }"

zotero-citation-graph-suggest-filter-by = Filter by { $field }
zotero-citation-graph-suggest-year-span = A span of years
zotero-citation-graph-suggest-free = Anything containing this


## Groups: the flag on the canvas and the card that names it.

zotero-citation-graph-group-here = Group here
zotero-citation-graph-group-existing = Group
zotero-citation-graph-group-drag-hint = Drag to move this card
zotero-citation-graph-group-placeholder = what belongs here — author:, year:, …
zotero-citation-graph-group-hint = Type a term, or field:value. Filters stack: each one narrows what this anchor pulls.
zotero-citation-graph-group-remove = Remove
zotero-citation-graph-group-done = Done
zotero-citation-graph-group-empty = say what belongs here
zotero-citation-graph-group-pulls = pulls { $count -> [one] { $count } paper here *[other] { $count } papers here }
# The same anchor, with the panel's group pull turned all the way down.
zotero-citation-graph-group-names = names { $count -> [one] { $count } paper, and moves it nowhere *[other] { $count } papers, and moves them nowhere }
# What a flag says before anything has been said about it.
zotero-citation-graph-group-flag-empty = nothing yet


## The context menus.

zotero-citation-graph-menu-zoom-to-fit = Zoom to fit
zotero-citation-graph-menu-zoom-to-fit-hint = put the whole graph back in view
zotero-citation-graph-menu-edit-group = Edit group
zotero-citation-graph-menu-edit-group-hint = change what this anchor pulls
zotero-citation-graph-menu-remove-group = Remove group
zotero-citation-graph-menu-remove-group-hint = let these papers go back to the layout
zotero-citation-graph-menu-group-here = Group here
zotero-citation-graph-menu-group-here-hint = plant an anchor, and say what belongs at it

zotero-citation-graph-menu-isolate = Isolate node
zotero-citation-graph-menu-show-whole-graph = Show whole graph
zotero-citation-graph-menu-isolate-hint-undim = undim everything
zotero-citation-graph-menu-isolate-hint-only = dim everything but this node
zotero-citation-graph-menu-isolate-hint-depth = dim everything more than { $depth -> [one] { $depth } edge *[other] { $depth } edges } away
zotero-citation-graph-menu-add-to-isolation = Add to isolation
zotero-citation-graph-menu-add-to-isolation-hint = light the neighbourhood around this node too, keeping the rest — or Ctrl-double-click it
zotero-citation-graph-menu-remove-from-isolation = Remove from isolation
zotero-citation-graph-menu-remove-from-isolation-hint = stop lighting the neighbourhood around this node — or Ctrl-double-click it

zotero-citation-graph-menu-pin = Pin node
zotero-citation-graph-menu-pin-hint = hold it at this spot; drag it to move the pin — or select it and press P
zotero-citation-graph-menu-unpin = Unpin node
zotero-citation-graph-menu-unpin-hint = let the layout move it again — or select it and press P

zotero-citation-graph-menu-show-details = Show details
zotero-citation-graph-menu-open-in-browser = Open in browser
zotero-citation-graph-menu-open-in-browser-no-id = no resolvable identifier
zotero-citation-graph-menu-add-to-zotero = Add to Zotero


## The outside-reference card.

zotero-citation-graph-action-add = Add to Zotero
zotero-citation-graph-action-adding = Adding…
zotero-citation-graph-action-close = Close


## The card an empty collection gets in place of a graph.

zotero-citation-graph-empty-title = Nothing to graph
zotero-citation-graph-empty-body = This collection has no regular items — only attachments, notes, or nothing at all.
zotero-citation-graph-empty-sub = Not included: { $count -> [one] one subcollection *[other] { $count } subcollections }.
zotero-citation-graph-empty-include-sub = Include subcollections


## Build phases, reported on the status line from chrome.

zotero-citation-graph-build-loading-collection = Loading collection…
zotero-citation-graph-build-loading-collection-recursive = Loading collection and subcollections…
zotero-citation-graph-build-reading-text = Reading indexed text…
zotero-citation-graph-build-reading-text-progress = Reading indexed text… { $done }/{ $total } ({ $provider })
zotero-citation-graph-build-scanning-pdfs = Scanning PDFs…
zotero-citation-graph-build-scanning-pdfs-count = Scanning { $count } PDFs for DOI links…
zotero-citation-graph-build-scanning-pdfs-progress = Scanning PDFs for DOI links… { $done }/{ $total }
zotero-citation-graph-build-openalex-references = Asking OpenAlex for references…
zotero-citation-graph-build-openalex-progress = Asking OpenAlex for references… { $done }/{ $total }
zotero-citation-graph-lookup-works = Looking up { $count -> [one] { $count } work *[other] { $count } works }…
zotero-citation-graph-lookup-progress = Looking up works… { $done }/{ $total } ({ $provider })
zotero-citation-graph-lookup-nothing = Nothing to look up: no DOIs in this graph.


## Adding an outside reference to the library.

zotero-citation-graph-add-tag-label = Tag
zotero-citation-graph-add-collection-label = Collection
zotero-citation-graph-add-new-collection = New Collection…
zotero-citation-graph-add-cancel = Cancel
zotero-citation-graph-add-confirm = Add
zotero-citation-graph-add-bad-doi = Not a usable DOI: { $doi }
zotero-citation-graph-add-adding = Adding { $doi }…
zotero-citation-graph-add-failed = Could not add { $doi }: { $message }
zotero-citation-graph-add-no-metadata = No metadata found for { $doi }
zotero-citation-graph-add-done = Added "{ $title }"
zotero-citation-graph-add-elsewhere = Added "{ $title }" to another collection — this graph is unchanged.
zotero-citation-graph-add-rebuilding = Added "{ $title }" — rebuilding…


## The tab.

zotero-citation-graph-tab-title = { $collection } — Citation Graph

## The gap list: works the collection cites and does not hold.

zotero-citation-graph-menu-gaps = What is missing
zotero-citation-graph-menu-gaps-hide = Hide what is missing
zotero-citation-graph-menu-gaps-hint = works your papers cite that this library does not hold
zotero-citation-graph-gaps-title = Missing works
zotero-citation-graph-gaps-close = Close
zotero-citation-graph-gaps-caption = The number is how many of your items cite the work.
zotero-citation-graph-gaps-empty = Nothing is cited by two of your papers and missing.
zotero-citation-graph-gaps-building = Still reading the collection…
zotero-citation-graph-gaps-row-hint = { $count -> [one] { $count } of your papers cites this *[other] { $count } of your papers cite this } — click to light it, double-click to isolate, Ctrl to add
zotero-citation-graph-gaps-off-screen = That work is not on the graph — a filter is hiding it.
zotero-citation-graph-gaps-add = Add to Zotero
zotero-citation-graph-gaps-add-no-doi = No DOI to add this by
zotero-citation-graph-gaps-mixed = across { $count } subfields
zotero-citation-graph-gaps-more = +{ $count } more below the cut
zotero-citation-graph-gaps-lookup-hint = With "query node metadata" on, these are ranked by how specific each one is to your library rather than by count alone.
