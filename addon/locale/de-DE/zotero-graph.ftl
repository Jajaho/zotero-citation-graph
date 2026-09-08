# Zotero Citation Graph -- deutsche Übersetzung.
#
# Siehe locale/en-US/zotero-graph.ftl für die Quelle und für die Regeln: eine
# Nachricht pro Zeile, Variablen als { $name }, Plurale als Selektor. Deutsch
# hat dieselben zwei CLDR-Kategorien wie Englisch (one, other).
#
# Die Kleinschreibung im Bedienfeld ist Absicht und stammt aus dem Original --
# Substantive bleiben trotzdem groß, weil alles andere falsch aussähe.


## Das Sammlungsmenü.

zotero-graph-view-citation-graph =
    .label = Zitationsgraph anzeigen


## Das Bedienfeld.

zotero-graph-panel-title = Einstellungen
zotero-graph-panel-collapse = Bedienfeld einklappen
zotero-graph-panel-expand = Bedienfeld anzeigen

zotero-graph-scope-subcollections = Untersammlungen
zotero-graph-scope-subcollections-hint = Einträge aus allen Untersammlungen einbeziehen
zotero-graph-scope-external = externe Referenzen
zotero-graph-scope-external-hint = Zitierte Arbeiten anzeigen, die nicht in der Sammlung sind
zotero-graph-scope-min-cites = zitiert von ≥
zotero-graph-scope-min-cites-hint = Externe Arbeiten ausblenden, die von weniger als so vielen Ihrer Aufsätze zitiert werden
zotero-graph-scope-enrich = Namen nachschlagen
zotero-graph-scope-enrich-hint = Zitationszahlen sowie Titel und Autoren externer Arbeiten nachschlagen (nutzt die OpenAlex-API)

zotero-graph-color-by = Farbe
zotero-graph-color-by-year = Jahr
zotero-graph-color-by-collection = Sammlung
zotero-graph-color-by-author = Erstautor
zotero-graph-color-by-publication = Publikation
zotero-graph-color-by-type = Eintragsart

zotero-graph-size-by = Größe
zotero-graph-size-by-here = hier zitiert
zotero-graph-size-by-global = Zitationen weltweit

zotero-graph-link-pull = Kantenzug
zotero-graph-link-pull-hint = Wie stark eine Kante ihre beiden Knoten zusammenzieht. Niedriger zieht einen dichten Graphen auseinander.

zotero-graph-center-pull = Mittelzug
zotero-graph-center-pull-hint = Wie stark die Mitte der Fläche jeden Knoten hält. Bei 0 treiben unverbundene Aufsätze davon; höher packt den Graphen enger zusammen.

zotero-graph-item-pane-failed = Zoteros Infobereich konnte hier nicht geöffnet werden.
zotero-graph-pane-hide = Diesen Bereich ausblenden
zotero-graph-pane-show = Diesen Bereich wieder einblenden

zotero-graph-filter-placeholder = Filter — author:, year:, …
zotero-graph-filter-hint = Ein Begriff oder feld:wert. Filter stapeln sich: jeder engt weiter ein.

zotero-graph-min-confidence = Mindestkonfidenz
zotero-graph-hide-isolated = Unverbundene ausblenden
zotero-graph-isolate-depth = Isolationstiefe
zotero-graph-isolate-depth-hint = Wie viele Kanten weit um einen isolierten Knoten herum hell bleibt. 0 zeigt nur die isolierten Knoten selbst.
zotero-graph-rebuild = Neu aufbauen

zotero-graph-reframe-hint = Ganzen Graphen einpassen


## Statuszeile.

zotero-graph-status-loading = Wird geladen…
zotero-graph-status-rebuilding = Wird neu aufgebaut…
zotero-graph-status-looking-up = Namen werden nachgeschlagen…
zotero-graph-status-dropping-names = Nachgeschlagene Namen werden verworfen…
zotero-graph-bad-payload = Ungültige Daten: { $message }

zotero-graph-stats-items = { $shown } / { $total } Einträge
zotero-graph-stats-outside = { $count } extern
zotero-graph-stats-named = ({ $count } benannt)
zotero-graph-stats-edges = { $count -> [one] { $count } Kante *[other] { $count } Kanten }
zotero-graph-stats-building = wird aufgebaut…


## Die Legende.

zotero-graph-legend-collapse = Legende einklappen
zotero-graph-legend-expand = Legende anzeigen
zotero-graph-legend-title = Eingefärbt nach { $mode }
zotero-graph-legend-outside = externe Referenzen
zotero-graph-legend-no-date = ohne Datum
zotero-graph-legend-more = +{ $count } weitere
zotero-graph-legend-row-hint = { $label } — { $count -> [one] { $count } Knoten *[other] { $count } Knoten }

zotero-graph-color-no-collection = (keine Sammlung)
zotero-graph-color-no-author = (kein Autor)
zotero-graph-color-no-publication = (keine Publikation)
zotero-graph-color-unknown-type = (unbekannte Art)


## Kurzinfos an den Knoten.

zotero-graph-tooltip-not-in-collection = Nicht in der Sammlung — { $title }
zotero-graph-tooltip-cited-here = hier von { $count } zitiert
zotero-graph-tooltip-citations-total = { $count } Zitationen insgesamt
zotero-graph-tooltip-pinned = angeheftet
zotero-graph-tooltip-et-al = { $names } u. a.
zotero-graph-tooltip-ghost-actions = Doppelklick für Details · Rechtsklick für Aktionen
zotero-graph-tooltip-item-actions = Doppelklick zum Auswählen in Zotero · Rechtsklick für Aktionen


## Filter-Chips und die Vorschlagsliste.

zotero-graph-field-author = Autor
zotero-graph-field-year = Jahr
zotero-graph-field-tag = Schlagwort
zotero-graph-field-type = Eintragsart
zotero-graph-field-publication = Publikation
zotero-graph-field-collection = Sammlung
zotero-graph-field-title = Titel
zotero-graph-field-any-short = alle
zotero-graph-field-any = jedes Feld

zotero-graph-chip-remove = Diese Maske abnehmen
zotero-graph-chip-click-to-edit = Zum Bearbeiten klicken
zotero-graph-chip-or-join = { ", oder " }
zotero-graph-chip-is = ist { $value }
zotero-graph-chip-between = liegt zwischen { $lo } und { $hi }
zotero-graph-chip-or-later = ist { $year } oder später
zotero-graph-chip-or-earlier = ist { $year } oder früher
zotero-graph-chip-is-exactly = ist genau „{ $value }“
zotero-graph-chip-contains = enthält „{ $value }“

zotero-graph-suggest-filter-by = nach { $field } filtern
zotero-graph-suggest-year-span = ein Zeitraum
zotero-graph-suggest-free = alles, was das enthält


## Gruppen: die Fahne auf der Fläche und die Karte dazu.

zotero-graph-group-here = Gruppe hier
zotero-graph-group-existing = Gruppe
zotero-graph-group-drag-hint = Ziehen, um diese Karte zu verschieben
zotero-graph-group-placeholder = was hierher gehört — author:, year:, …
zotero-graph-group-hint = Ein Begriff oder feld:wert. Filter stapeln sich: jeder engt ein, was dieser Anker anzieht.
zotero-graph-group-pull = Zug
zotero-graph-group-pull-hint = Wie stark dieser Anker die Aufsätze anzieht, die er benennt. Bei 0 benennt er sie, ohne sie zu bewegen.
zotero-graph-group-remove = Entfernen
zotero-graph-group-done = Fertig
zotero-graph-group-empty = sagen, was hierher gehört
zotero-graph-group-pulls = zieht { $count -> [one] { $count } Aufsatz hierher *[other] { $count } Aufsätze hierher }
# Derselbe Anker, dessen Zug ganz heruntergedreht ist.
zotero-graph-group-names = benennt { $count -> [one] { $count } Aufsatz und bewegt ihn nicht *[other] { $count } Aufsätze und bewegt sie nicht }
zotero-graph-group-flag-empty = noch nichts


## Der Isolationshinweis im Bedienfeld.

zotero-graph-isolate-note = isoliert: { $name } ✕
zotero-graph-isolate-note-more = isoliert: { $name } +{ $count } ✕
zotero-graph-isolate-note-hint = { $names } — klicken, um den ganzen Graphen zu zeigen


## Die Kontextmenüs.

zotero-graph-menu-zoom-to-fit = Einpassen
zotero-graph-menu-zoom-to-fit-hint = den ganzen Graphen wieder ins Bild holen
zotero-graph-menu-edit-group = Gruppe bearbeiten
zotero-graph-menu-edit-group-hint = ändern, was dieser Anker anzieht
zotero-graph-menu-remove-group = Gruppe entfernen
zotero-graph-menu-remove-group-hint = diese Aufsätze zurück ins Layout lassen
zotero-graph-menu-group-here = Gruppe hier
zotero-graph-menu-group-here-hint = einen Anker setzen und sagen, was dazugehört

zotero-graph-menu-isolate = Isolieren
zotero-graph-menu-show-whole-graph = Ganzen Graphen zeigen
zotero-graph-menu-isolate-hint-undim = alles wieder aufhellen
zotero-graph-menu-isolate-hint-only = alles außer diesem Knoten abdunkeln
zotero-graph-menu-isolate-hint-depth = alles abdunkeln, was mehr als { $depth -> [one] { $depth } Kante *[other] { $depth } Kanten } entfernt ist
zotero-graph-menu-add-to-isolation = Zur Isolation hinzufügen
zotero-graph-menu-add-to-isolation-hint = die Umgebung dieses Knotens zusätzlich aufhellen, den Rest behalten
zotero-graph-menu-remove-from-isolation = Aus der Isolation nehmen
zotero-graph-menu-remove-from-isolation-hint = die Umgebung dieses Knotens nicht mehr aufhellen

zotero-graph-menu-pin = Knoten hier anheften
zotero-graph-menu-pin-hint = an dieser Stelle festhalten; zum Verschieben ziehen
zotero-graph-menu-unpin = Knoten lösen
zotero-graph-menu-unpin-hint = das Layout darf ihn wieder bewegen

zotero-graph-menu-open-in-browser = Im Browser öffnen
zotero-graph-menu-open-in-browser-no-id = kein auflösbarer Bezeichner
zotero-graph-menu-open-in-browser-no-url = dieser Eintrag hat weder URL noch DOI
zotero-graph-menu-add-to-zotero = Zu Zotero hinzufügen
zotero-graph-menu-select-in-zotero = In Zotero auswählen
zotero-graph-menu-open-pdf-pane = PDF neben dem Graphen öffnen
zotero-graph-menu-open-pdf-pane-hint = hier lesen, ohne den Graphen zu verlassen
zotero-graph-menu-open-pdf-tab = PDF in neuem Tab öffnen
zotero-graph-menu-open-pdf-tab-hint = der volle Reader, mit Suche, Seitenleiste und Annotationen


## Die Karte für externe Referenzen.

zotero-graph-action-add = Zu Zotero hinzufügen
zotero-graph-action-adding = Wird hinzugefügt…
zotero-graph-action-close = Schließen


## Aufbauphasen, aus dem Chrome auf der Statuszeile gemeldet.

zotero-graph-build-loading-collection = Sammlung wird geladen…
zotero-graph-build-loading-collection-recursive = Sammlung und Untersammlungen werden geladen…
zotero-graph-build-no-items = Diese Sammlung enthält keine regulären Einträge.
zotero-graph-build-reading-text = Indexierter Text wird gelesen…
zotero-graph-build-reading-text-progress = Indexierter Text wird gelesen… { $done }/{ $total } ({ $provider })
zotero-graph-build-scanning-pdfs = PDFs werden durchsucht…
zotero-graph-build-scanning-pdfs-count = { $count } PDFs werden nach DOI-Links durchsucht…
zotero-graph-build-scanning-pdfs-progress = PDFs werden nach DOI-Links durchsucht… { $done }/{ $total }
zotero-graph-lookup-works = { $count -> [one] { $count } Arbeit wird *[other] { $count } Arbeiten werden } nachgeschlagen…
zotero-graph-lookup-progress = Arbeiten werden nachgeschlagen… { $done }/{ $total } ({ $provider })
zotero-graph-lookup-nothing = Nichts nachzuschlagen: keine DOIs in diesem Graphen.


## Eine externe Referenz zur Bibliothek hinzufügen.

zotero-graph-add-bad-doi = Keine brauchbare DOI: { $doi }
zotero-graph-add-adding = { $doi } wird hinzugefügt…
zotero-graph-add-failed = { $doi } konnte nicht hinzugefügt werden: { $message }
zotero-graph-add-no-metadata = Keine Metadaten gefunden für { $doi }
zotero-graph-add-done = „{ $title }“ hinzugefügt — wird neu aufgebaut…


## Der Tab und der Reader-Bereich darin.

zotero-graph-tab-title = { $collection } — Zitationsgraph
zotero-graph-reader-loading = Wird geladen…
zotero-graph-reader-failed = Der Reader wurde nicht geladen.
zotero-graph-reader-render-failed = Dieser Anhang konnte nicht dargestellt werden.
zotero-graph-reader-no-attachment = Kein Anhang an „{ $title }“.
zotero-graph-reader-unsupported = „{ $title }“ hat kein PDF, EPUB oder Snapshot zum Öffnen.
zotero-graph-reader-missing-file = Die Anhangdatei für „{ $title }“ fehlt auf der Festplatte.
zotero-graph-reader-prev = Vorherige Seite
zotero-graph-reader-next = Nächste Seite
zotero-graph-reader-open = Öffnen ↗
zotero-graph-reader-open-hint = In einem vollen Reader-Fenster öffnen
