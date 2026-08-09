# Küchenbuch

Eine kleine, lokale Website zum Sammeln und Verwalten persönlicher Rezepte.

## Starten

Im Projektordner den lokalen Küchenbuch-Server starten:

```bash
python3 server.py
```

Danach `http://127.0.0.1:8765` im Browser aufrufen. Der Server muss während der Benutzung laufen.

Auf dem Mac kann alternativ `Küchenbuch starten.command` doppelt angeklickt werden.

## Funktionen

- Rezepte anlegen, bearbeiten und löschen
- Kategorien: Vorspeise, Hauptspeise und Nachspeise
- Suche nach Titel und Zutaten
- Zutaten als einzelne Einkaufslisten-Positionen mit Menge, Einheit und Checkbox
- Frei benennbare Rezeptteile wie Teig, Sauce oder mehrere Füllungen mit eigener Anleitung
- Zutaten über „Gehört zu“ einem Rezeptteil zuordnen
- Durchschnittliche Nährwerte für Zutaten suchen und Rezeptwerte pro 100 g berechnen
- Zubereitungsanleitung
- Verknüpfung mit Instagram und anderen Webseiten
- Rezeptbilder direkt vom lokalen Gerät hochladen
- Produktsuche per EAN/Barcode über Open Food Facts
- Kamera-Barcodeerkennung in unterstützten Browsern
- Gespeicherte Produktzutaten und editierbare Nährwerttabelle pro 100 g
- Automatische Speicherung in `data/recipes.json` im Programmordner

Die Rezeptdatei bleibt unabhängig von Cookies und Browserdaten erhalten. Wenn der komplette Projektordner hochgeladen oder kopiert wird, ist die Rezeptsammlung darin enthalten. Die lokale Programmschnittstelle ist nur auf diesem Computer erreichbar und überträgt keine Daten an einen externen Server.

Hochgeladene Rezeptbilder werden als eigene Dateien im Unterordner `images/` gespeichert. Beim Sichern oder Veröffentlichen muss deshalb immer der komplette Projektordner einschließlich dieses Unterordners verwendet werden.

Für die Kamerafunktion empfiehlt sich ein Chromium-basierter Browser wie Chrome. Alternativ kann die EAN immer manuell eingegeben werden. Produktinformationen werden aus der offenen Datenbank Open Food Facts abgerufen; nicht jedes Produkt ist dort vollständig erfasst. Übernommene Angaben sollten mit der Verpackung verglichen werden.

## Nährwertberechnung

Über „Nährwerte berechnen“ sucht die Website nur für Zutaten ohne hinterlegte Werte nach passenden Produkten bei Open Food Facts und bildet daraus einen Durchschnitt. Ergebnisse werden in `data/nutrition-cache.json` lokal zwischengespeichert. Die Berechnung verwendet das Gesamtgewicht aller Zutaten und gibt Werte pro 100 g aus.

- `g` und `kg` werden exakt in Gramm umgerechnet.
- `ml` und `l` werden näherungsweise mit 1 g/ml gerechnet.
- Bei `Stück`, `EL`, `TL` und `Prise` ist ein zusätzliches Gewicht in Gramm erforderlich.
- Garverlust, Wasseraufnahme und unterschiedliche Lebensmitteldichten sind nicht automatisch bekannt. Die Ergebnisse sind deshalb Näherungswerte und bleiben editierbar.
