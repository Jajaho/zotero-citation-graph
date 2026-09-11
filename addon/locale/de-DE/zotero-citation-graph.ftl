# Citation Graph for Zotero -- deutsche Übersetzung.
#
# Siehe locale/en-US/zotero-citation-graph.ftl für die Quelle und für die Regeln: eine
# Nachricht pro Zeile, Variablen als { $name }, Plurale als Selektor. Deutsch
# hat dieselben zwei CLDR-Kategorien wie Englisch (one, other).
#
# Die Kleinschreibung im Bedienfeld ist Absicht und stammt aus dem Original --
# Substantive bleiben trotzdem groß, weil alles andere falsch aussähe.


## Das Sammlungsmenü.

zotero-citation-graph-view-citation-graph =
    .label = Zitationsgraph anzeigen


## Die Abschnitte der Seitenleiste.

zotero-citation-graph-section-collapse = Abschnitt einklappen
zotero-citation-graph-section-expand = Abschnitt anzeigen

zotero-citation-graph-section-forces = Kräfte anpassen
zotero-citation-graph-section-items = Eintragsauswahl
zotero-citation-graph-section-display = Graphdarstellung
zotero-citation-graph-section-strategies = Referenzstrategien

zotero-citation-graph-scope-subcollections = Untersammlungen
zotero-citation-graph-scope-subcollections-hint = Einträge aus allen Untersammlungen einbeziehen
zotero-citation-graph-scope-external = externe Referenzen
zotero-citation-graph-scope-external-hint = Zitierte Arbeiten anzeigen, die nicht in der Sammlung sind
zotero-citation-graph-scope-min-cites = zitiert von ≥
zotero-citation-graph-scope-min-cites-hint = Externe Arbeiten ausblenden, die von weniger als so vielen deiner Einträge zitiert werden
zotero-citation-graph-scope-enrich = Knotenmetadaten abfragen
zotero-citation-graph-scope-enrich-hint = Zitationszahlen sowie Titel und Autoren externer Arbeiten nachschlagen (nutzt die OpenAlex-API)

zotero-citation-graph-scope-external-names = externe Namen
zotero-citation-graph-scope-external-names-hint = Jede externe Arbeit im Graphen beschriften. Aus bleiben sie unbeschriftete Punkte.

zotero-citation-graph-color-by = Farbe
zotero-citation-graph-color-by-year = Jahr
zotero-citation-graph-color-by-collection = Sammlung
zotero-citation-graph-color-by-cluster = Teilgebiet
zotero-citation-graph-color-by-author = Erstautor
zotero-citation-graph-color-by-publication = Publikation
zotero-citation-graph-color-by-type = Eintragsart

zotero-citation-graph-size-by = Größe
zotero-citation-graph-size-by-here = hier zitiert
zotero-citation-graph-size-by-global = Zitationen weltweit

zotero-citation-graph-link-pull = Kantenzug
zotero-citation-graph-link-pull-hint = Wie stark eine Kante ihre beiden Knoten zusammenzieht. Niedriger zieht einen dichten Graphen auseinander.

zotero-citation-graph-center-pull = Mittelzug
zotero-citation-graph-center-pull-hint = Wie stark die Mitte der Fläche jeden Knoten hält. Bei 0 treiben unverbundene Einträge davon; höher packt den Graphen enger zusammen.

# Die Stärke aller Anker zugleich, nicht die eines einzelnen: die Fähnchen
# stehen auf der Fläche, aber wie stark sie ziehen, ist eine Layout-Einstellung
# wie die beiden darüber.
zotero-citation-graph-group-pull = Gruppenzug
zotero-citation-graph-group-pull-hint = Wie stark jeder Anker die Einträge anzieht, die er benennt. Bei 0 benennen sie sie, ohne sie zu bewegen.

zotero-citation-graph-pin-pull = Nadelzug
zotero-citation-graph-pin-pull-hint = Wie viel stärker die Kanten eines angehefteten Knotens ziehen. Bei 0 hält eine Nadel nur den Knoten, auf dem sie steckt.

zotero-citation-graph-item-pane-failed = Zoteros Infobereich konnte hier nicht geöffnet werden.

zotero-citation-graph-perf-mode = Leistungsmodus
zotero-citation-graph-perf-hint = Zeichnet einen großen Graphen schneller: das Layout wird einmal gesetzt und bleibt stehen, statt fünfzehn Sekunden lang einzuschwingen, und Kanten geben Pfeile, Krümmung und Strategiefarben auf. Namen bleiben unangetastet, und Knoten lassen sich weiterhin ziehen.

zotero-citation-graph-filter-placeholder = Filter — Autor:, Jahr:, …
zotero-citation-graph-filter-hint = Ein Begriff oder feld:wert. Filter stapeln sich: jeder engt weiter ein.

zotero-citation-graph-min-confidence = Mindestkonfidenz
zotero-citation-graph-hide-isolated = Unverbundene ausblenden
zotero-citation-graph-isolate-depth = Isolationstiefe
zotero-citation-graph-isolate-depth-hint = Wie viele Kanten weit um einen isolierten Knoten herum hell bleibt. 0 zeigt nur die isolierten Knoten selbst.
zotero-citation-graph-rebuild = Neu aufbauen

zotero-citation-graph-reframe-hint = Ganzen Graphen einpassen

## Die obere Leiste: die beiden Bereichsschalter und das Suchfeld.

zotero-citation-graph-side-toggle-hide = Seitenleiste ausblenden
zotero-citation-graph-side-toggle-show = Seitenleiste einblenden

zotero-citation-graph-pane-toggle-show = Infobereich einblenden

zotero-citation-graph-search-placeholder = Suchen
zotero-citation-graph-search-hint = Eine Arbeit auf der Fläche finden und ansteuern (Strg+F). Das filtert den Graphen nicht — dafür ist das Filterfeld in der Seitenleiste da.
zotero-citation-graph-search-clear = Leeren
zotero-citation-graph-search-empty = Keine angezeigte Arbeit passt dazu


## Statuszeile.

zotero-citation-graph-status-loading = Wird geladen…
zotero-citation-graph-status-rebuilding = Wird neu aufgebaut…
zotero-citation-graph-status-looking-up = Namen werden nachgeschlagen…
zotero-citation-graph-status-dropping-names = Nachgeschlagene Namen werden verworfen…
zotero-citation-graph-bad-payload = Ungültige Daten: { $message }

zotero-citation-graph-stats-items = { $shown } / { $total } Einträge
zotero-citation-graph-stats-outside = { $count } extern
zotero-citation-graph-stats-named = ({ $count } benannt)
zotero-citation-graph-stats-edges = { $count -> [one] { $count } Kante *[other] { $count } Kanten }
zotero-citation-graph-stats-building = wird aufgebaut…


## Die Legende.

zotero-citation-graph-legend-outside = externe Referenzen
zotero-citation-graph-legend-no-date = ohne Datum
zotero-citation-graph-legend-more = +{ $count } weitere
zotero-citation-graph-legend-row-hint = { $label } — { $count -> [one] { $count } Knoten *[other] { $count } Knoten }
zotero-citation-graph-legend-cluster-quality = { $count -> [one] { $count } Teilgebiet *[other] { $count } Teilgebiete }, Modularität { $q }

zotero-citation-graph-color-no-collection = (keine Sammlung)
zotero-citation-graph-color-no-cluster = (kein Teilgebiet)
zotero-citation-graph-color-cluster-n = Teilgebiet { $n }
zotero-citation-graph-color-no-author = (kein Autor)
zotero-citation-graph-color-no-publication = (keine Publikation)
zotero-citation-graph-color-unknown-type = (unbekannte Art)


## Kurzinfos an den Knoten.

zotero-citation-graph-tooltip-not-in-collection = Nicht in der Sammlung — { $title }
zotero-citation-graph-tooltip-cited-here = hier von { $count } zitiert
zotero-citation-graph-tooltip-citations-total = { $count } Zitationen insgesamt
zotero-citation-graph-tooltip-pinned = angeheftet
zotero-citation-graph-tooltip-et-al = { $names } u. a.
zotero-citation-graph-tooltip-actions = Klick zum Auswählen (Strg zum Hinzufügen) · Doppelklick zum Isolieren · Rechtsklick für Aktionen


## Filter-Chips und die Vorschlagsliste.

# Zwei Namen je Facette: field-* ist die Aufschrift auf dem Chip, fieldkey-* das
# Schlüsselwort, das das Filterfeld vor dem Doppelpunkt liest. Das Schlüsselwort
# ist ein einziges Wort ohne Leerzeichen und ohne Doppelpunkt -- alles bis zum
# ersten Doppelpunkt ist der Feldname. Substantive bleiben groß, wie sonst auch
# in dieser Datei; eingetippt wird ohne Rücksicht auf Groß- und Kleinschreibung,
# und die englischen Schlüsselwörter gelten weiterhin zusätzlich.
zotero-citation-graph-field-author = Autor
zotero-citation-graph-field-year = Jahr
zotero-citation-graph-field-tag = Schlagwort
zotero-citation-graph-field-type = Eintragsart
zotero-citation-graph-field-publication = Publikation
zotero-citation-graph-field-collection = Sammlung
zotero-citation-graph-field-cluster = Teilgebiet
zotero-citation-graph-field-title = Titel

zotero-citation-graph-fieldkey-author = Autor
zotero-citation-graph-fieldkey-year = Jahr
zotero-citation-graph-fieldkey-tag = Schlagwort
zotero-citation-graph-fieldkey-type = Art
zotero-citation-graph-fieldkey-publication = Publikation
zotero-citation-graph-fieldkey-collection = Sammlung
zotero-citation-graph-fieldkey-cluster = Teilgebiet
zotero-citation-graph-fieldkey-title = Titel

zotero-citation-graph-field-any-short = alle
zotero-citation-graph-field-any = jedes Feld

zotero-citation-graph-chip-remove = Diese Maske abnehmen
zotero-citation-graph-chip-click-to-edit = Zum Bearbeiten klicken
zotero-citation-graph-chip-or-join = { ", oder " }
zotero-citation-graph-chip-is = ist { $value }
zotero-citation-graph-chip-between = liegt zwischen { $lo } und { $hi }
zotero-citation-graph-chip-or-later = ist { $year } oder später
zotero-citation-graph-chip-or-earlier = ist { $year } oder früher
zotero-citation-graph-chip-is-exactly = ist genau „{ $value }“
zotero-citation-graph-chip-contains = enthält „{ $value }“

zotero-citation-graph-suggest-filter-by = nach { $field } filtern
zotero-citation-graph-suggest-year-span = ein Zeitraum
zotero-citation-graph-suggest-free = alles, was das enthält


## Gruppen: die Fahne auf der Fläche und die Karte dazu.

zotero-citation-graph-group-here = Gruppe hier
zotero-citation-graph-group-existing = Gruppe
zotero-citation-graph-group-drag-hint = Ziehen, um diese Karte zu verschieben
zotero-citation-graph-group-placeholder = was hierher gehört — Autor:, Jahr:, …
zotero-citation-graph-group-hint = Ein Begriff oder feld:wert. Filter stapeln sich: jeder engt ein, was dieser Anker anzieht.
zotero-citation-graph-group-remove = Entfernen
zotero-citation-graph-group-done = Fertig
zotero-citation-graph-group-empty = sagen, was hierher gehört
zotero-citation-graph-group-pulls = zieht { $count -> [one] { $count } Eintrag hierher *[other] { $count } Einträge hierher }
# Derselbe Anker, wenn der Gruppenzug im Bedienfeld ganz heruntergedreht ist.
zotero-citation-graph-group-names = benennt { $count -> [one] { $count } Eintrag und bewegt ihn nicht *[other] { $count } Einträge und bewegt sie nicht }
zotero-citation-graph-group-flag-empty = noch nichts


## Die Kontextmenüs.

zotero-citation-graph-menu-zoom-to-fit = Einpassen
zotero-citation-graph-menu-zoom-to-fit-hint = den ganzen Graphen wieder ins Bild holen
zotero-citation-graph-menu-edit-group = Gruppe bearbeiten
zotero-citation-graph-menu-edit-group-hint = ändern, was dieser Anker anzieht
zotero-citation-graph-menu-remove-group = Gruppe entfernen
zotero-citation-graph-menu-remove-group-hint = diese Einträge zurück ins Layout lassen
zotero-citation-graph-menu-group-here = Gruppe hier
zotero-citation-graph-menu-group-here-hint = einen Anker setzen und sagen, was dazugehört

zotero-citation-graph-menu-isolate = Knoten isolieren
zotero-citation-graph-menu-show-whole-graph = Ganzen Graphen zeigen
zotero-citation-graph-menu-isolate-hint-undim = alles wieder aufhellen
zotero-citation-graph-menu-isolate-hint-only = alles außer diesem Knoten abdunkeln
zotero-citation-graph-menu-isolate-hint-depth = alles abdunkeln, was mehr als { $depth -> [one] { $depth } Kante *[other] { $depth } Kanten } entfernt ist
zotero-citation-graph-menu-add-to-isolation = Zur Isolation hinzufügen
zotero-citation-graph-menu-add-to-isolation-hint = die Umgebung dieses Knotens zusätzlich aufhellen, den Rest behalten — oder Strg-Doppelklick
zotero-citation-graph-menu-remove-from-isolation = Aus der Isolation nehmen
zotero-citation-graph-menu-remove-from-isolation-hint = die Umgebung dieses Knotens nicht mehr aufhellen — oder Strg-Doppelklick

zotero-citation-graph-menu-pin = Knoten anheften
zotero-citation-graph-menu-pin-hint = an dieser Stelle festhalten; zum Verschieben ziehen — oder auswählen und P drücken
zotero-citation-graph-menu-unpin = Knoten lösen
zotero-citation-graph-menu-unpin-hint = das Layout darf ihn wieder bewegen — oder auswählen und P drücken

zotero-citation-graph-menu-show-details = Details anzeigen
zotero-citation-graph-menu-open-in-browser = Im Browser öffnen
zotero-citation-graph-menu-open-in-browser-no-id = kein auflösbarer Bezeichner
zotero-citation-graph-menu-add-to-zotero = Zu Zotero hinzufügen


## Die Karte für externe Referenzen.

zotero-citation-graph-action-add = Zu Zotero hinzufügen
zotero-citation-graph-action-adding = Wird hinzugefügt…
zotero-citation-graph-action-close = Schließen


## Die Karte, die eine leere Sammlung anstelle eines Graphen bekommt.

zotero-citation-graph-empty-title = Nichts zu zeichnen
zotero-citation-graph-empty-body = Diese Sammlung enthält keine regulären Einträge – nur Anhänge, Notizen oder gar nichts.
zotero-citation-graph-empty-sub = Nicht einbezogen: { $count -> [one] eine Untersammlung *[other] { $count } Untersammlungen }.
zotero-citation-graph-empty-include-sub = Untersammlungen einbeziehen


## Aufbauphasen, aus dem Chrome auf der Statuszeile gemeldet.

zotero-citation-graph-build-loading-collection = Sammlung wird geladen…
zotero-citation-graph-build-loading-collection-recursive = Sammlung und Untersammlungen werden geladen…
zotero-citation-graph-build-reading-text = Indexierter Text wird gelesen…
zotero-citation-graph-build-reading-text-progress = Indexierter Text wird gelesen… { $done }/{ $total } ({ $provider })
zotero-citation-graph-build-scanning-pdfs = PDFs werden durchsucht…
zotero-citation-graph-build-scanning-pdfs-count = { $count } PDFs werden nach DOI-Links durchsucht…
zotero-citation-graph-build-scanning-pdfs-progress = PDFs werden nach DOI-Links durchsucht… { $done }/{ $total }
zotero-citation-graph-lookup-works = { $count -> [one] { $count } Arbeit wird *[other] { $count } Arbeiten werden } nachgeschlagen…
zotero-citation-graph-lookup-progress = Arbeiten werden nachgeschlagen… { $done }/{ $total } ({ $provider })
zotero-citation-graph-lookup-nothing = Nichts nachzuschlagen: keine DOIs in diesem Graphen.


## Eine externe Referenz zur Bibliothek hinzufügen.

zotero-citation-graph-add-tag-label = Schlagwort
zotero-citation-graph-add-collection-label = Sammlung
zotero-citation-graph-add-new-collection = Neue Sammlung…
zotero-citation-graph-add-cancel = Abbrechen
zotero-citation-graph-add-confirm = Hinzufügen
zotero-citation-graph-add-bad-doi = Keine brauchbare DOI: { $doi }
zotero-citation-graph-add-adding = { $doi } wird hinzugefügt…
zotero-citation-graph-add-failed = { $doi } konnte nicht hinzugefügt werden: { $message }
zotero-citation-graph-add-no-metadata = Keine Metadaten gefunden für { $doi }
zotero-citation-graph-add-done = „{ $title }“ hinzugefügt
zotero-citation-graph-add-elsewhere = „{ $title }“ zu einer anderen Sammlung hinzugefügt — dieser Graph bleibt unverändert.
zotero-citation-graph-add-rebuilding = „{ $title }“ hinzugefügt — wird neu aufgebaut…


## Der Tab.

zotero-citation-graph-tab-title = { $collection } — Zitationsgraph

## Fehlende Werke: was die Sammlung zitiert und nicht besitzt.

zotero-citation-graph-menu-gaps = Was fehlt
zotero-citation-graph-menu-gaps-hide = Fehlendes ausblenden
zotero-citation-graph-menu-gaps-hint = Werke, die deine Einträge zitieren und die diese Bibliothek nicht hat
zotero-citation-graph-gaps-title = Fehlende Werke
zotero-citation-graph-gaps-close = Schließen
zotero-citation-graph-gaps-caption = Die Zahl sagt, wie viele deiner Einträge das Werk zitieren.
zotero-citation-graph-gaps-empty = Nichts wird von zwei deiner Einträge zitiert und fehlt.
zotero-citation-graph-gaps-building = Die Sammlung wird noch gelesen…
zotero-citation-graph-gaps-row-hint = { $count -> [one] { $count } Eintrag deiner Bibliothek zitiert das *[other] { $count } Einträge deiner Bibliothek zitieren das } — klicken zum Hervorheben, doppelklicken zum Isolieren, Strg zum Hinzufügen
zotero-citation-graph-gaps-off-screen = Dieses Werk ist nicht im Graphen — ein Filter blendet es aus.
zotero-citation-graph-gaps-add = Zu Zotero hinzufügen
zotero-citation-graph-gaps-add-no-doi = Keine DOI, über die sich das hinzufügen ließe
zotero-citation-graph-gaps-mixed = über { $count } Teilgebiete verteilt
zotero-citation-graph-gaps-more = +{ $count } weitere unterhalb der Grenze
zotero-citation-graph-gaps-lookup-hint = Mit „Knotenmetadaten abfragen“ werden diese danach sortiert, wie spezifisch sie für deine Bibliothek sind, statt nur nach Anzahl.
