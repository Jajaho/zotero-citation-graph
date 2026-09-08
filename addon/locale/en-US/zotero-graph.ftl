# Zotero Citation Graph -- user-facing strings.
#
# Every id is prefixed `zotero-graph-`, because Zotero loads a plugin's .ftl
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
# Adding a locale: create locale/<code>/zotero-graph.ftl and add <code> to
# LOCALES in lib/l10n.js. `npm test` checks the two against each other, and
# against this file's message list.


## The collection menu.
#
# This one is resolved by Zotero's own Fluent, not by ftl.js: MenuManager reads
# it from the main window's bundle through the l10nID on the menu entry.

zotero-graph-view-citation-graph =
    .label = View Citation Graph


## The control panel.

zotero-graph-panel-title = settings
zotero-graph-panel-collapse = Collapse controls
zotero-graph-panel-expand = Show controls

zotero-graph-scope-subcollections = subcollections
zotero-graph-scope-subcollections-hint = Include items from every subcollection
zotero-graph-scope-external = outside refs
zotero-graph-scope-external-hint = Show cited works that are not in the collection
zotero-graph-scope-min-cites = cited by ≥
zotero-graph-scope-min-cites-hint = Hide outside works cited by fewer than this many of your papers
zotero-graph-scope-enrich = look up names
zotero-graph-scope-enrich-hint = Look up citation counts, and titles and authors for outside works (uses the OpenAlex API)

zotero-graph-color-by = colour
zotero-graph-color-by-year = year
zotero-graph-color-by-collection = collection
zotero-graph-color-by-cluster = subfield
zotero-graph-color-by-author = first author
zotero-graph-color-by-publication = publication
zotero-graph-color-by-type = item type

zotero-graph-size-by = size
zotero-graph-size-by-here = cited here
zotero-graph-size-by-global = global citations

zotero-graph-link-pull = edge pull
zotero-graph-link-pull-hint = How hard a link pulls its two nodes together. Lower spreads a crowded graph out.

zotero-graph-center-pull = centre pull
zotero-graph-center-pull-hint = How hard the middle of the canvas holds every node. At 0 unconnected papers drift away; higher packs the graph tighter.

zotero-graph-item-pane-failed = Could not open Zotero's item pane here.
zotero-graph-pane-hide = Hide this pane
zotero-graph-pane-show = Show this pane again

zotero-graph-filter-placeholder = filter — author:, year:, …
zotero-graph-filter-hint = Type a term, or field:value. Filters stack: each one narrows what is left.

zotero-graph-min-confidence = min confidence
zotero-graph-hide-isolated = hide unconnected
zotero-graph-isolate-depth = isolation depth
zotero-graph-isolate-depth-hint = How many edges out from an isolated node stays lit. 0 lights the isolated nodes and nothing else.
zotero-graph-rebuild = Rebuild

zotero-graph-reframe-hint = Fit the whole graph in view


## Status line.

zotero-graph-status-loading = Loading…
zotero-graph-status-rebuilding = Rebuilding…
zotero-graph-status-looking-up = Looking up names…
zotero-graph-status-dropping-names = Dropping looked-up names…
zotero-graph-bad-payload = Bad payload: { $message }

# The counts under the panel. Joined with " · " in the order they appear here.
zotero-graph-stats-items = { $shown } / { $total } items
zotero-graph-stats-outside = { $count } outside
zotero-graph-stats-named = ({ $count } named)
zotero-graph-stats-edges = { $count -> [one] { $count } edge *[other] { $count } edges }
zotero-graph-stats-building = building…


## The legend.

zotero-graph-legend-collapse = Collapse legend
zotero-graph-legend-expand = Show legend
zotero-graph-legend-title = Coloured by { $mode }
zotero-graph-legend-outside = outside refs
zotero-graph-legend-no-date = no date
zotero-graph-legend-more = +{ $count } more
zotero-graph-legend-row-hint = { $label } — { $count -> [one] { $count } node *[other] { $count } nodes }
# How trustworthy the subfield split is: modularity below about 0.3 means the
# clusters are more the algorithm than the library.
zotero-graph-legend-cluster-quality = { $count -> [one] { $count } subfield *[other] { $count } subfields }, modularity { $q }

# Colour keys for held items missing the facet being coloured by.
zotero-graph-color-no-collection = (no collection)
zotero-graph-color-no-cluster = (no subfield)
# A subfield whose members share no word worth naming it after.
zotero-graph-color-cluster-n = subfield { $n }
zotero-graph-color-no-author = (no author)
zotero-graph-color-no-publication = (no publication)
zotero-graph-color-unknown-type = (unknown type)


## Node tooltips.

zotero-graph-tooltip-not-in-collection = Not in collection — { $title }
zotero-graph-tooltip-cited-here = cited by { $count } here
zotero-graph-tooltip-citations-total = { $count } citations total
zotero-graph-tooltip-pinned = pinned
zotero-graph-tooltip-et-al = { $names } et al.
zotero-graph-tooltip-ghost-actions = double-click for details · right-click for actions
zotero-graph-tooltip-item-actions = double-click to select in Zotero · right-click for actions


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
# breaks that rule. Capitalise it however the language does -- English keeps the
# panel's lower case, German capitalises its nouns and writes "Jahr" -- since
# what is typed is matched case-insensitively either way. The English keywords
# are always accepted as well as the translated ones, so a mask written in one
# language still opens in another.
zotero-graph-field-author = author
zotero-graph-field-year = year
zotero-graph-field-tag = tag
zotero-graph-field-type = item type
zotero-graph-field-publication = publication
zotero-graph-field-collection = collection
zotero-graph-field-cluster = subfield
zotero-graph-field-title = title

zotero-graph-fieldkey-author = author
zotero-graph-fieldkey-year = year
zotero-graph-fieldkey-tag = tag
zotero-graph-fieldkey-type = type
zotero-graph-fieldkey-publication = publication
zotero-graph-fieldkey-collection = collection
zotero-graph-fieldkey-cluster = subfield
zotero-graph-fieldkey-title = title

# The chip's own short label for a mask that is not scoped to one field.
zotero-graph-field-any-short = any
# The same mask, spelled out in the chip's tooltip.
zotero-graph-field-any = any field

zotero-graph-chip-remove = Lift this mask
zotero-graph-chip-click-to-edit = Click to edit
# The terms of one mask, joined. They widen the mask, hence "or".
zotero-graph-chip-or-join = { ", or " }
zotero-graph-chip-is = is { $value }
zotero-graph-chip-between = is between { $lo } and { $hi }
zotero-graph-chip-or-later = is { $year } or later
zotero-graph-chip-or-earlier = is { $year } or earlier
zotero-graph-chip-is-exactly = is exactly "{ $value }"
zotero-graph-chip-contains = contains "{ $value }"

zotero-graph-suggest-filter-by = filter by { $field }
zotero-graph-suggest-year-span = a span of years
zotero-graph-suggest-free = anything containing this


## Groups: the flag on the canvas and the card that names it.

zotero-graph-group-here = Group here
zotero-graph-group-existing = Group
zotero-graph-group-drag-hint = Drag to move this card
zotero-graph-group-placeholder = what belongs here — author:, year:, …
zotero-graph-group-hint = Type a term, or field:value. Filters stack: each one narrows what this anchor pulls.
zotero-graph-group-pull = pull
zotero-graph-group-pull-hint = How hard this anchor pulls the papers it names. At 0 it names them without moving them.
zotero-graph-group-remove = Remove
zotero-graph-group-done = Done
zotero-graph-group-empty = say what belongs here
zotero-graph-group-pulls = pulls { $count -> [one] { $count } paper here *[other] { $count } papers here }
# The same anchor with its pull turned all the way down.
zotero-graph-group-names = names { $count -> [one] { $count } paper, and moves it nowhere *[other] { $count } papers, and moves them nowhere }
# What a flag says before anything has been said about it.
zotero-graph-group-flag-empty = nothing yet


## The isolation note in the panel.

zotero-graph-isolate-note = isolated: { $name } ✕
zotero-graph-isolate-note-more = isolated: { $name } +{ $count } ✕
zotero-graph-isolate-note-hint = { $names } — click to show the whole graph


## The context menus.

zotero-graph-menu-zoom-to-fit = Zoom to fit
zotero-graph-menu-zoom-to-fit-hint = put the whole graph back in view
zotero-graph-menu-edit-group = Edit group
zotero-graph-menu-edit-group-hint = change what this anchor pulls
zotero-graph-menu-remove-group = Remove group
zotero-graph-menu-remove-group-hint = let these papers go back to the layout
zotero-graph-menu-group-here = Group here
zotero-graph-menu-group-here-hint = plant an anchor, and say what belongs at it

zotero-graph-menu-isolate = Isolate
zotero-graph-menu-show-whole-graph = Show whole graph
zotero-graph-menu-isolate-hint-undim = undim everything
zotero-graph-menu-isolate-hint-only = dim everything but this node
zotero-graph-menu-isolate-hint-depth = dim everything more than { $depth -> [one] { $depth } edge *[other] { $depth } edges } away
zotero-graph-menu-add-to-isolation = Add to isolation
zotero-graph-menu-add-to-isolation-hint = light the neighbourhood around this node too, keeping the rest
zotero-graph-menu-remove-from-isolation = Remove from isolation
zotero-graph-menu-remove-from-isolation-hint = stop lighting the neighbourhood around this node

zotero-graph-menu-pin = Pin node here
zotero-graph-menu-pin-hint = hold it at this spot; drag it to move the pin
zotero-graph-menu-unpin = Unpin node
zotero-graph-menu-unpin-hint = let the layout move it again

zotero-graph-menu-open-in-browser = Open in browser
zotero-graph-menu-open-in-browser-no-id = no resolvable identifier
zotero-graph-menu-open-in-browser-no-url = this item has neither a URL nor a DOI
zotero-graph-menu-add-to-zotero = Add to Zotero
zotero-graph-menu-select-in-zotero = Select in Zotero
zotero-graph-menu-open-pdf-pane = Open PDF beside the graph
zotero-graph-menu-open-pdf-pane-hint = read it here, without leaving the graph
zotero-graph-menu-open-pdf-tab = Open PDF in new tab
zotero-graph-menu-open-pdf-tab-hint = the whole reader, with search, sidebar and annotation


## The outside-reference card.

zotero-graph-action-add = Add to Zotero
zotero-graph-action-adding = Adding…
zotero-graph-action-close = Close


## Build phases, reported on the status line from chrome.

zotero-graph-build-loading-collection = Loading collection…
zotero-graph-build-loading-collection-recursive = Loading collection and subcollections…
zotero-graph-build-no-items = This collection has no regular items.
zotero-graph-build-reading-text = Reading indexed text…
zotero-graph-build-reading-text-progress = Reading indexed text… { $done }/{ $total } ({ $provider })
zotero-graph-build-scanning-pdfs = Scanning PDFs…
zotero-graph-build-scanning-pdfs-count = Scanning { $count } PDFs for DOI links…
zotero-graph-build-scanning-pdfs-progress = Scanning PDFs for DOI links… { $done }/{ $total }
zotero-graph-lookup-works = Looking up { $count -> [one] { $count } work *[other] { $count } works }…
zotero-graph-lookup-progress = Looking up works… { $done }/{ $total } ({ $provider })
zotero-graph-lookup-nothing = Nothing to look up: no DOIs in this graph.


## Adding an outside reference to the library.

zotero-graph-add-tag-label = Tag
zotero-graph-add-collection-label = Collection
zotero-graph-add-new-collection = New Collection…
zotero-graph-add-cancel = Cancel
zotero-graph-add-confirm = Add
zotero-graph-add-bad-doi = Not a usable DOI: { $doi }
zotero-graph-add-adding = Adding { $doi }…
zotero-graph-add-failed = Could not add { $doi }: { $message }
zotero-graph-add-no-metadata = No metadata found for { $doi }
zotero-graph-add-done = Added "{ $title }"
zotero-graph-add-elsewhere = Added "{ $title }" to another collection — this graph is unchanged.
zotero-graph-add-rebuilding = Added "{ $title }" — rebuilding…


## The tab, and the reader pane inside it.

zotero-graph-tab-title = { $collection } — Citation Graph
zotero-graph-reader-loading = Loading…
zotero-graph-reader-failed = The reader did not load.
zotero-graph-reader-render-failed = Could not render this attachment.
zotero-graph-reader-no-attachment = No attachment on "{ $title }".
zotero-graph-reader-unsupported = "{ $title }" has no PDF, EPUB or snapshot to open.
zotero-graph-reader-missing-file = The attachment file for "{ $title }" is missing on disk.
zotero-graph-reader-prev = Previous page
zotero-graph-reader-next = Next page
zotero-graph-reader-open = Open ↗
zotero-graph-reader-open-hint = Open in a full reader window

## The gap list: works the collection cites and does not hold.

zotero-graph-menu-gaps = What is missing
zotero-graph-menu-gaps-hide = Hide what is missing
zotero-graph-menu-gaps-hint = works your papers cite that this library does not hold
zotero-graph-gaps-title = Missing works
zotero-graph-gaps-close = Close
zotero-graph-gaps-empty = Nothing is cited by two of your papers and missing.
zotero-graph-gaps-building = Still reading the collection…
zotero-graph-gaps-row-hint = { $count -> [one] { $count } of your papers cites this *[other] { $count } of your papers cite this } — click to light them
zotero-graph-gaps-add = Add to Zotero
zotero-graph-gaps-add-no-doi = No DOI to add this by
zotero-graph-gaps-mixed = across { $count } subfields
zotero-graph-gaps-more = +{ $count } more below the cut
zotero-graph-gaps-lookup-hint = With "look up names" on, these are ranked by how specific each one is to your library rather than by count alone.
