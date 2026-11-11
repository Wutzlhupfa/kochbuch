# Küchenbuch

Bestehende Rezeptsammlung mit HTML, CSS und JavaScript, Supabase (Anmeldung, Rezepte als JSON und Bilder) und GitHub Pages.

## Lokal starten

```bash
python3 server.py
```

`http://127.0.0.1:8765` öffnen. Alternativ auf dem Mac `Küchenbuch starten.command` verwenden. Der lokale Python-Server speichert Rezepte in `data/recipes.json` und Bilder in `images/`. Im lokalen Serverbetrieb wird ausschließlich diese lokale Sammlung verwendet. Eine statische Vorschau ohne API verwendet wie GitHub Pages die vorhandene Cloud-Anbindung. Cloud-Änderungen erfordern eine Anmeldung; fehlgeschlagene Schreibvorgänge werden nicht als Erfolg angezeigt. Eine leere Cloud wird nicht automatisch mit lokalen Daten befüllt.

## Rezeptverwaltung

- Rezepte erstellen, bearbeiten, löschen und unabhängig duplizieren
- Kategorien, Textsuche nach Titel/Zutaten und Sortierung
- Rezeptteile mit eigenen Anleitungen und zugeordneten Zutaten
- Zutatenmengen nach Portionen skalieren
- Manuelle optionale Nährwerte für 100 g oder 1 Portion; alte Bezugsmengen bleiben auswählbar
- Bisherige Nährwerte ohne ausdrückliche Bestätigung werden als überprüfungsbedürftig angezeigt
- Vorbereitungszeit, Koch-/Backzeit, Ruhe-/Gehzeit, Schwierigkeit und fertiges Gesamtgewicht
- Freie Tags mit Vorschlägen aus der Sammlung und einzelnem Entfernen
- Kombinierte Kategorie-, Tag-, Gesamtdauer-, Schwierigkeits- und Favoritenfilter
- Herzen auf Karten und in Rezeptdetails; Duplikate beginnen ohne Favoritenstatus
- Rezeptbilder, Links und bestehende Exportfunktionen

Zeiten werden als einfache Summe der bekannten Zeitfelder dargestellt; parallele Schritte sind nicht berücksichtigt. Rezepte ohne Zeitangaben sind bei aktivem Zeitlimit ausgeschlossen. Mehrere gewählte Tags müssen alle zutreffen.

## Datenkompatibilität

Neue optionale Felder liegen direkt im Rezeptobjekt: `prepMinutes`, `cookMinutes`, `restMinutes`, `finishedWeightGrams`, `difficulty`, `tags`, `favorite` und `nutritionVerified`. Fehlende Zahlen werden als `null` gespeichert; 0 bleibt ein eigenständiger Wert. `servings`, `nutrition` und `nutritionBasis` werden weiterhin verwendet. Nährwerte werden weder berechnet noch mit der Portionsanpassung verändert.

Vorhandene zusätzliche Rezept-, Rezeptteil- und Zutatenfelder sowie alte Produktinformationen und Berechnungsmetadaten bleiben beim Bearbeiten erhalten. Alte Nährwert-Caches werden nicht mehr verwendet, aber als Datenbestand belassen. Barcode-, Produkt- und automatische Nährwertsuche einschließlich ihrer Python-Endpunkte wurden entfernt.
