# Küchenbuch

Bestehende Rezeptsammlung mit HTML, CSS und JavaScript, Supabase für Rezepte und Bilder sowie GitHub Pages. Kein Framework und kein zusätzlicher Buildprozess.

## Aktueller Auftrag: ohne Anmeldung öffentlich bearbeiten

Die Anmeldeoberfläche, Passwortfelder, Anmelde-/Abmelde-Listener und Sitzungsprüfungen wurden aus der Anwendung entfernt. Der Supabase-Client verwendet ausschließlich den vorhandenen Publishable-Key, lädt keine gespeicherte Sitzung und erneuert keine Anmeldung. Der alte lokale Sitzungseintrag dieses Projekts wird entfernt; dadurch werden keine Supabase-Konten gelöscht.

Jeder Besucher darf Rezepte erstellen, bearbeiten, kopieren und löschen, Favoriten ändern und Bilder hochladen. Eine Versionsprüfung verhindert weiterhin versehentliches Überschreiben inzwischen geänderter Rezepte. Jeder Besucher könnte auch fremde Rezepte löschen; das ist die ausdrücklich gewünschte öffentliche Bearbeitung.

**Umgesetzt am 12.11.2026:** Die produktiven RLS-/Storage-Regeln erlauben jetzt öffentliches Lesen, Anlegen, Ändern und Löschen von Rezepten sowie Zugriffe auf den Bucket `recipe-images`. RLS bleibt aktiv, andere Buckets sind nicht freigegeben. Unnötige Tabellenrechte TRUNCATE, REFERENCES und TRIGGER wurden für anon/authenticated entzogen. Registrierung, E-Mail-Anmeldung und sämtliche weiteren Anmeldeanbieter sind abgeschaltet. Die beiden Anwendungskonten wurden nach ausdrücklicher Bestätigung gelöscht. Der administrative Supabase-Dashboard-Zugang bleibt erhalten.

Vor der Kontolöschung wurden Rezeptdaten inklusive aller verwendeten Bilddateien sowie Autoren-/Storage-Metadaten lokal gesichert. Die nullable Autorenverweise `updated_by` und die Storage-Besitzverweise wurden gelöst; Rezept-JSON, Bildpfade und Dateien bleiben erhalten. Eine Datenbanktransaktion kontrollierte unveränderte Rezeptinhalte und Bildmetadaten und bestätigte anschließend 0 Konten, 33 Rezepte und 44 Storage-Dateien. Alle 44 Bilder wurden danach erfolgreich abgerufen; die 33 verwendeten Bilder stimmen bytegenau mit der Sicherung überein. Private Sicherungen liegen unter `backups/` und sind von Git ausgeschlossen. `docs/supabase-public-access.sql` dokumentiert die ausgeführte Freigabe.

## Lokal nutzen

```bash
python3 server.py
```

`http://127.0.0.1:8765` öffnen; alternativ auf dem Mac `Küchenbuch starten.command`. Nach Serveränderungen neu starten. Der lokale Server speichert in `data/recipes.json` und `images/` und ist nur an die Loopback-Adresse gebunden. Fremde Browser-Origins und fremde Host-Header werden abgewiesen. ETag-/If-Match-Prüfungen schützen vor zwischenzeitlichen Dateiänderungen. Eine fehlende Rezeptdatei gilt als leere Sammlung; eine beschädigte bestehende Datei wird als Fehler gemeldet und nicht automatisch überschrieben.

Die GitHub-Pages-Version verwendet die bestehende Supabase-Tabelle `recipes` und den Bucket `recipe-images`. Eine statische lokale Vorschau ohne `/api/recipes` verwendet ebenfalls diese Anbindung. Neue Bilder erhalten kollisionsfreie Pfade unter `public/`, keine Benutzer-ID-Ordner. Vorhandene Bilder und ihre URLs werden nicht verschoben oder gelöscht. Neue Rezeptänderungen benötigen kein `updated_by`; vorhandene Autorenmetadaten werden nicht ungefragt überschrieben.

## Rezeptverwaltung

- Erstellen, Bearbeiten, Kopieren und Löschen; Duplikate beginnen ohne Favoritenstatus.
- Rezeptteile mit eigenen Anleitungen und zugeordneten Zutaten: Name, Menge und frei erhaltene Einheiten.
- Grundportionen und Zutatenmengen proportional anpassen.
- Optionale Vorbereitungs-, Koch-/Back- und Ruhe-/Gehzeit, Schwierigkeit und fertiges Gesamtgewicht.
- Freie Tags erstellen, auswählen und einzeln entfernen; doppelte Schreibweisen mit unterschiedlichen Leerzeichen/Großschreibung werden verhindert.
- Kombinierte Kategorie-, Tag-, Gesamtdauer-, Schwierigkeits- und Favoritenfilter, weiterhin Textsuche und Sortierung sowie Filter zurücksetzen.
- Favoritenherzen auf Karten und Details. Der Favoritenstatus gehört zum Rezept und gilt für alle Besucher.
- Rezeptbilder und Instagram-/Webseitenlinks.

Zeitangaben werden als einfache Summe bekannter Zeiten angezeigt; parallele Schritte sind nicht berücksichtigt. Ohne Zeitangaben erfüllt ein Rezept keinen aktiven Zeitfilter. Bei mehreren gewählten Tags müssen alle zutreffen. Fehlende Zahlen bleiben von expliziter 0 unterscheidbar.

## Manuelle Nährwerte

Kalorien, kJ, Eiweiß, Kohlenhydrate, Zucker, Fett, gesättigte Fettsäuren, Ballaststoffe und Salz sind optional manuell eintragbar, etwa aus Yazio. Leere Werte werden nicht als 0 ausgegeben. Die Bezugsmenge ist 100 g oder 1 Portion; ältere gültige Bezugsmengen bleiben erhalten. Eine Portionsänderung skaliert nur Zutaten, nicht die Nährwerte. Es gibt keine automatische Berechnung oder Umrechnung anhand von Zutaten. Bisherige Werte werden bis zur ausdrücklichen manuellen Bestätigung als überprüfungsbedürftig gekennzeichnet.

Relevante und unbekannte Zusatzfelder in Rezepten, Rezeptteilen und Zutaten bleiben beim Bearbeiten erhalten. Alte Produktinformationen und Berechnungsmetadaten bleiben als Legacy-Daten gespeichert. Entfernte Suchfunktionen und Einkaufslisten-Checkboxen werden nicht mehr ausgeführt. Alte Cachedateien werden nicht mehr verwendet, aber nicht als Datenbestand gelöscht.

## Vollständige ZIP-Sicherung

1. Speichere offene Entwürfe, die mitgesichert werden sollen.
2. Klicke auf **Vollständige Datensicherung erstellen**.
3. Warte auf die Abschlussmeldung und prüfe deinen Downloadordner auf `kochbuch-backup-JJJJ-MM-TT.zip`.
4. Bewahre die ZIP zusätzlich an einem zweiten Ort auf.

Die aktuelle Cloud-Sammlung wird vollständig seitenweise gelesen, niemals durch eine veraltete lokale Datei ersetzt. `manifest.json` enthält Format, Version, Datum, Rezept-/Bildanzahl, Zuordnungen, Dateigrößen und SHA-256-Prüfsummen. `recipes.json` enthält alle Rezeptfelder; `image` verweist portabel auf die tatsächliche Datei unter `images/`. Gleiche Bildinhalte werden dedupliziert. Alle benötigten Bilder werden heruntergeladen, geprüft und als echte Dateien aufgenommen. Ein fehlendes oder beschädigtes Bild führt mit Rezeptname zum Abbruch statt zu einer fälschlich vollständigen Sicherung. Eine leere Sammlung ist zulässig.

Lokale Entwürfe, Auth-Sitzungen und Browser-Konfiguration werden nicht exportiert. Es bestehen keine gesonderten dauerhaft gespeicherten Rezept-Einstellungen außerhalb der Rezeptobjekte. Mögliche geheime Felder führen zur Ablehnung statt zu stillem Export oder Datenverlust. Die Sicherung ist nicht verschlüsselt. Prüfsummen erkennen Beschädigung, sind aber kein Herkunftsnachweis.

## Wiederherstellen

1. Klicke **Datensicherung wiederherstellen** und wähle eine ZIP-Datei.
2. Die Anwendung prüft Format, Version, Rezeptdaten und alle Bilder und zeigt eine Vorschau.
3. **Zusammenführen** importiert nur unbekannte Rezept-IDs; vorhandene Rezepte bleiben unverändert. Nur tatsächlich benötigte Bilder werden hochgeladen; bestehende identische Bilder werden wiederverwendet.
4. **Gesamte Sammlung ersetzen** ersetzt den Bestand durch das Backup. Dafür ist eine zusätzliche ausdrückliche Bestätigung erforderlich.
5. Vor dem Ersetzen wird zwingend eine vollständige Sicherheitskopie des aktuellen Bestands erstellt. Lade sie herunter und bestätige, dass die Datei auf deinem Gerät angekommen ist. Ohne erfolgreiche Sicherheitskopie und Bestätigung beginnt kein Ersetzen.
6. Lass das Fenster bis zum Ergebnis offen. Neue Bilder werden zuerst hochgeladen, erneut geladen und geprüft. Danach werden die Rezeptdaten gespeichert und das tatsächliche Ergebnis kontrolliert.

Alte Sicherungen im Format `kuechenbuch-backup`, Version 1, sowie rohe JSON-Rezeptarrays werden unterstützt. Sie enthalten selbst keine Bilddateien. Die Anwendung versucht, alte Bildlinks abzurufen und neu zu speichern; nicht mehr erreichbare Originalbilder lassen sich aus einer solchen JSON-Datei nicht zurückholen. Das wird ausdrücklich als Legacy-Import ausgewiesen.

### Grenzen und Fehlerbehandlung

Maximal 2.000 Rezepte, 2.003 ZIP-Einträge, 210 MiB ZIP-Größe, 200 MiB entpackter Gesamtumfang, 5 MiB Rezept-JSON, 1 MiB Manifest, 8 MiB pro Bild und 40 Megapixel pro Bild. Das Kompressionsverhältnis ist auf 200:1 begrenzt. Unterstützt werden STORE und DEFLATE; Export erfolgt ohne Kompression. ZIP64, Verschlüsselung, mehrteilige Archive, Symlinks, unsichere/mehrfache Dateinamen, Path-Traversal, widersprüchliche Größen und fehlerhafte Prüfsummen werden abgewiesen. Bilder werden anhand von Signatur, Rastermaßen und tatsächlicher Dekodierbarkeit geprüft; SVG ist nicht zugelassen. Die fest versionierte ZIP-Bibliothek fflate 0.8.2 ist unter `vendor/` samt MIT-Lizenz lokal eingebunden.

Cloud-Aktualisierung und Bedienung werden während kritischer Wiederherstellungsschritte koordiniert; verspätete alte Antworten werden verworfen. Lokal wird die Rezeptdatei atomar mit Versionsprüfung ersetzt. Die Cloud besitzt keine gemeinsame Transaktion über die gesamte Sammlung: einzelne INSERT/UPDATE/DELETE-Vorgänge werden journalisiert; Löschungen erfolgen zuletzt. Bei Fehlern wird eine kontrollierte Rücknahme mit Versionsbedingungen versucht und geprüft. Unklare Schreibantworten werden nach Möglichkeit erneut gelesen.

Netz-/Browserabbruch, parallele Änderungen, Trigger und Richtlinien können eine vollständige Rücknahme verhindern. Dann erscheint ein ausdrücklicher unklarer/unvollständiger Status, niemals eine Erfolgsmeldung. Das Journal liegt im Arbeitsspeicher; die vorher heruntergeladene Sicherheitskopie muss deshalb aufbewahrt werden. Neu hochgeladene Dateien bleiben bei Fehlern vorsichtshalber erhalten, weil ein bereits gespeichertes Rezept trotz verlorener Antwort darauf verweisen könnte. Vorhandene Bilder werden nicht gelöscht.

## Lokale Entwürfe

Nach 500 ms Eingabepause werden Felder, Zutaten, Rezeptteile, Anleitungen, Nährwerte, Tags, Links und ausgewählte Bilddateien in IndexedDB gesichert. Maximal 1 MiB Textdaten und 8 MiB Bild pro Entwurf; voller/gesperrter Speicher wird ausdrücklich als **Entwurf NICHT gesichert** angezeigt.

**Schließen · Entwurf behalten**, Kreuz und Escape behalten die Änderungen lokal. Beim erneuten Öffnen stehen **Entwurf wiederherstellen** und **Entwurf verwerfen** zur Wahl; nichts wird ungefragt übernommen. Nach erfolgreichem manuellem Speichern wird nur der zugehörige Entwurf entfernt. Neue Rezepte und bestehende IDs bleiben getrennt, ebenso lokaler und öffentlicher Cloud-Speicher. Entwürfe aus dem früheren Benutzer-Modus bleiben erhalten und werden passend zum Rezept zur Wiederherstellung angeboten. Sie werden nicht automatisch zusammengeführt oder gelöscht.

Bei inzwischen neuerem oder gelöschtem Rezeptstand wird das Überschreiben blockiert; **Als neues Rezept weiterbearbeiten** rettet die Eingaben als eigenständige Variante. Änderungen anderer Tabs an einem lokalen Entwurf werden nicht still überschrieben. Entwürfe werden weder veröffentlicht noch mit anderen Geräten synchronisiert. Andere Browserprofile/Ports, gelöschte Websitedaten oder privater Modus können sie unzugänglich machen. Die letzten Eingaben direkt vor einem Absturz könnten noch nicht geschrieben sein; bei ungesicherten Änderungen warnt die Anwendung vor dem Verlassen.

## PDF, mobile Darstellung und Tests

Der bestehende PDF-Druckexport enthält auch Rezeptinformationen und Tags, manuelle Nährwerte mit Bezugsmenge sowie Prüfhinweise für alte Werte. Druckränder auf Folgeseiten verhindern abgeschnittene lange Anleitungen. Farben, Schriftarten und der Charakter der Website bleiben erhalten. Geprüfte Chrome-Breiten: 320, 375, 768 und 1280 px.

```bash
python3 tests/test_all.py
```

Die Tests arbeiten nur mit temporären Sammlungen, echten Testbildern und einem Supabase-Simulator. Sie prüfen normale Rezeptverwaltung, Nährwerte, Zutaten/Portionsskalierung, Tags, Filter, Favoriten, alte Daten, ZIP-Roundtrip mit bytegenauen Bildern, Import-Fehler/Rücknahme, echte IndexedDB-Entwürfe, öffentliche Bearbeitung ohne Auth-API, verweigerte Schreibrechte sowie responsive Ansichten. Python `zipfile` kontrolliert Archive zusätzlich unabhängig. Der Mobiltest erzeugt 24 Screenshots und eine tatsächliche PDF-Druckausgabe unter `/tmp/kochbuch-qa`.

**Grenzen der Live-Prüfung:** Öffentliche Lesbarkeit, tatsächliche RLS-/Storage-Regeln, abgeschaltete Anmeldung/Registrierung, Kontolöschung und unveränderte Rezept-/Bilddaten wurden am produktiven Projekt geprüft. Schreib-, Upload- und Löschabläufe wurden mit einem isolierten Supabase-Simulator getestet; es wurden dafür keine produktiven Testrezepte oder Testbilder angelegt/gelöscht. Echte Smartphones und Safari wurden nicht getestet.
