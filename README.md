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
- Rezeptbilder, Links, PDF-Export und vollständige ZIP-Datensicherung
- Automatische lokale Rezeptentwürfe einschließlich ausgewählter Bilder (IndexedDB)

Zeiten werden als einfache Summe der bekannten Zeitfelder dargestellt; parallele Schritte sind nicht berücksichtigt. Rezepte ohne Zeitangaben sind bei aktivem Zeitlimit ausgeschlossen. Mehrere gewählte Tags müssen alle zutreffen.

## Datenkompatibilität

Neue optionale Felder liegen direkt im Rezeptobjekt: `prepMinutes`, `cookMinutes`, `restMinutes`, `finishedWeightGrams`, `difficulty`, `tags`, `favorite` und `nutritionVerified`. Fehlende Zahlen werden als `null` gespeichert; 0 bleibt ein eigenständiger Wert. `servings`, `nutrition` und `nutritionBasis` werden weiterhin verwendet. Nährwerte werden weder berechnet noch mit der Portionsanpassung verändert.

Vorhandene zusätzliche Rezept-, Rezeptteil- und Zutatenfelder sowie alte Produktinformationen und Berechnungsmetadaten bleiben beim Bearbeiten erhalten. Alte Nährwert-Caches werden nicht mehr verwendet, aber als Datenbestand belassen. Barcode-, Produkt- und automatische Nährwertsuche einschließlich ihrer Python-Endpunkte wurden entfernt.

## Vollständige ZIP-Datensicherung und Wiederherstellung (Teil 2)

„Vollständige Datensicherung erstellen“ liest den aktuellen Cloud-Bestand erneut (seitenweise, keine statische Ersatzdatei) beziehungsweise die aktuelle lokale Rezeptdatei. Heruntergeladene Bilder werden anhand ihres tatsächlichen Dateiinhalts geprüft und dedupliziert. Schlägt ein Bildabruf fehl, wird mit Rezeptname abgebrochen und keine vollständige ZIP angeboten. Eine leere Sammlung kann ebenfalls gesichert und wiederhergestellt werden. Bei lokalem Betrieb den aktualisierten `server.py` neu starten.

Die Datei `kochbuch-backup-JJJJ-MM-TT.zip` enthält:

- `manifest.json`: Format `kochbuch-complete-backup`, Version 1, Datum, Rezept-/Bildanzahl, SHA-256 der Rezeptdatei und Bildzuordnungen mit MIME-Typ, Größe und SHA-256.
- `recipes.json`: sämtliche Rezeptfelder einschließlich unbekannter Zusatz-/Legacy-Felder. Nur `image` wird auf den jeweiligen portablen Pfad innerhalb des Archivs umgestellt.
- `images/<sha256>.<endung>`: echte PNG-, JPEG-, GIF- oder WebP-Dateien. Identische Bildinhalte werden einmal gespeichert; mehrere Rezept-IDs können darauf verweisen.

Es existieren derzeit keine gesonderten dauerhaft gespeicherten rezeptbezogenen Einstellungen außerhalb der Rezeptobjekte (`settings: "none"`). Lokale Entwürfe sind keine fertig gespeicherten Rezepte und werden nicht in die ZIP übernommen; gewünschte Entwürfe vorher über „Rezept speichern“ übernehmen. Authentifizierung, Browser-Storage, Supabase-Sitzungen und Konfiguration werden nicht exportiert. Mögliche geheime Felder in Rezeptdaten führen zur Ablehnung, statt unbemerkt exportiert oder entfernt zu werden. Prüfsummen erkennen Beschädigungen, sind aber keine digitale Signatur und kein Herkunftsnachweis. Backups enthalten persönliche Rezeptdaten und sind nicht verschlüsselt.

„Datensicherung wiederherstellen“ prüft die gesamte Datei und alle eingebetteten Bilder vor der Vorschau. Erst die Bestätigung startet einen Import:

- **Zusammenführen:** unbekannte IDs hinzufügen; vorhandene IDs und ihre Bilder unverändert überspringen. Bereits vorhandene identische, lesbare Bilddateien werden anhand ihres Inhalts wiederverwendet. Ein erneuter Import derselben IDs führt zu keinen zusätzlichen Bildern oder Rezepten.
- **Gesamte Sammlung ersetzen:** zusätzliche ausdrückliche Bestätigung; vollständige Sicherung des aktuellen Bestands zwingend vorab. Die Oberfläche bietet die Sicherheitskopie zum Download an und wartet auf die Bestätigung, dass die Datei auf dem Gerät vorhanden ist. Der Browser kann einen abgeschlossenen Download nicht selbst nachweisen. Bei gescheiterter Sicherung, fehlendem Bild oder Abbruch werden keine Rezeptdaten ersetzt.

Neue Bilddateien erhalten kollisionsfreie Namen, werden niemals über vorhandene Dateien geschrieben und vor den Rezeptänderungen erneut abgerufen und per SHA-256 geprüft. Anschließend werden gespeicherte Rezeptfelder und verwendete importierte Bilder nochmals kontrolliert. Bilder ohne Dateianhang in alten JSON-Sicherungen werden ausdrücklich als solche ausgewiesen; erreichbare alte Bildlinks werden geprüft, neu gespeichert und neu zugeordnet. Sind diese Quellen nicht mehr erreichbar, wird der Import vor den Rezeptänderungen abgebrochen. Unterstützt werden das frühere Format `kuechenbuch-backup`, Version 1, sowie rohe Rezeptarrays. Alte Zutatenlisten aus Text, fehlende neue Felder und ältere gültige Nährwertbezugsmengen bleiben erhalten.

### Grenzen und Schutzmaßnahmen

Maximal 2.000 Rezepte, 2.003 ZIP-Einträge, 210 MiB ZIP-Dateigröße, 200 MiB entpackter Gesamtumfang, 5 MiB Rezept-JSON, 1 MiB Manifest, 8 MiB pro Bild, 40 Megapixel pro Bild und maximal 200:1 Kompressionsverhältnis. Bei Überschreitung erfolgt ein ausdrücklicher Abbruch. Der Export verwendet ZIP ohne Kompression, damit diese Grenze auch bei sehr gleichförmigen Daten eingehalten wird. ZIP-Import unterstützt STORE und DEFLATE. ZIP64, mehrteilige/verschlüsselte Archive, Symlinks, doppelte Dateinamen, unerwartete Pfade, Path-Traversal, widersprüchliche Größen und fehlerhafte CRC-/SHA-Prüfsummen werden abgelehnt. DEFLATE wird in kleinen Eingabeabschnitten mit Kontrolle der tatsächlich entpackten Größe verarbeitet. Bildtypen werden anhand der Signatur, Rastermaße und tatsächlichen Dekodierbarkeit geprüft; SVG wird nicht importiert.

Die ZIP-Bibliothek [fflate 0.8.2](https://github.com/101arrowz/fflate/tree/v0.8.2) ist mit MIT-Lizenz lokal unter `vendor/` eingebunden; kein Laufzeit-CDN und kein Buildprozess sind nötig.

### Rücknahme und verbleibende technische Grenzen

Automatische Cloud-Aktualisierungen und Bearbeiten im selben Browser werden während kritischer Vorgänge pausiert. Bereits laufende veraltete Aktualisierungen werden über eine Generationserkennung verworfen. Änderungen seit der Importvorschau oder während der Bildprüfung führen vor dem Schreiben zum Abbruch. Dies sperrt andere Browser/Geräte nicht.

Lokal wird die gesamte Rezeptdatei innerhalb eines Locks über eine temporäre Datei atomar ersetzt. `ETag`/`If-Match` verhindern das Überschreiben eines inzwischen geänderten lokalen Bestands. Eine fehlende lokale Rezeptdatei wird als leere Sammlung behandelt, eine beschädigte bestehende Datei nicht. Vorhandene Bilder werden nie gelöscht.

Die Cloud-Anbindung hat **keine gemeinsame Transaktion über alle Rezepte**. Neue Rezepte werden per INSERT gespeichert, vorhandene per UPDATE mit `updated_at`-Bedingung. Nicht mehr benötigte Datensätze werden erst nach den anderen Schreibvorgängen und ebenfalls mit Versionsprüfung gelöscht. Ein Journal hält erfolgreiche Einzeländerungen fest. Bei Fehlern wird ein unklarer Schreibausgang nach Möglichkeit erneut gelesen; anschließend erfolgt eine Rücknahme in umgekehrter Reihenfolge mit Versionsbedingungen, damit neuere Änderungen anderer Geräte nicht blind überschrieben werden. Der Ausgangszustand wird kontrolliert.

Bei Netz-/Browserabbruch, RLS-Verweigerung, serverseitigen Triggern oder parallelen Änderungen kann die Rücknahme unvollständig sein. Das wird ausdrücklich als unklarer/unvollständiger Zustand angezeigt und niemals als Erfolg bezeichnet. Das Journal ist im Arbeitsspeicher und überlebt keinen Browserabbruch. Deshalb die vorher heruntergeladene Sicherheitskopie aufbewahren. In einem unklaren Zustand die Sammlung neu laden, nicht weiter bearbeiten und den tatsächlichen Bestand prüfen; bei Bedarf die Sicherheitskopie erneut in der Vorschau prüfen und kontrolliert wiederherstellen. Bei komplett fehlendem Netzwerk ist keine Rücknahme möglich. Neue, möglicherweise unreferenzierte Uploads bleiben bei einem Fehler vorsichtshalber erhalten, da ein Rezept trotz verlorener Antwort bereits darauf verweisen könnte. Vorhandene Bilddateien werden auch beim Ersetzen nicht gelöscht.

### Ausgeführte Tests

```bash
python3 tests/test_all.py
# einzeln: tests/test_part1.py, tests/test_part2.py, tests/test_part3.py
```

Die Tests starten Chrome im Hintergrund mit einem eigenen temporären Profil und ausschließlich temporären Dateien. PNG/JPEG-Testbilder werden tatsächlich erzeugt, heruntergeladen, als ZIP exportiert, importiert, geöffnet und bytegenau verglichen. Python `zipfile` prüft das exportierte ZIP zusätzlich unabhängig. Die Testdaten enthalten sämtliche neuen Rezeptfelder und zusätzliche Legacy-Felder. Ersetzen, Zusammenführen, wiederholter Import, Sicherheitskopie/Downloadbestätigung, alte JSON-Backups, beschädigte Dateien, Größen-/Pfadprüfungen, Upload-/Schreibfehler, Versionskonflikte und Rücknahme einschließlich verlorener Schreibantwort werden geprüft. Die Supabase-Schreibwege werden mit einem Simulator getestet.

**Nicht getestet:** vollständiger Live-Roundtrip gegen eine isolierte echte Supabase-Testinstanz und deren reale RLS-/Storage-/Trigger-Konfiguration. Die produktive Supabase-Datenbank wurde für diese Tests weder beschrieben noch gelöscht. Das bestehende PDF-Verfahren bleibt erhalten; Rezeptinformationen und Tags werden ergänzt, Folgeseiten erhalten sichere Druckränder.


## Nutzung ohne Programmierkenntnisse

### Sicherung erstellen

1. Öffne deine Sammlung und speichere noch offene Rezeptentwürfe, die mitgesichert werden sollen.
2. Klicke unten auf **Vollständige Datensicherung erstellen**.
3. Warte auf die Erfolgsmeldung und prüfe deinen Downloadordner. Die ZIP enthält die gespeicherten Rezepte und echten Bilddateien.
4. Bewahre die ZIP zusätzlich an einem zweiten Ort auf. Fehlt ein Bild, erscheint stattdessen eine Fehlermeldung mit Rezeptname; es wird keine vollständige Sicherung behauptet.

### Sicherung wiederherstellen

1. Melde dich online wie bisher an. Lokal genügt der gestartete Küchenbuch-Server.
2. Klicke auf **Datensicherung wiederherstellen** und wähle deine ZIP-Datei.
3. Lies die Vorschau. **Zusammenführen** fügt nur unbekannte Rezept-IDs hinzu und lässt vorhandene Rezepte unverändert.
4. Wähle **Gesamte Sammlung ersetzen** nur, wenn du den alten Bestand wirklich durch das Backup ersetzen möchtest. Bestätige dies ausdrücklich.
5. Lade die zuvor automatisch erstellte Sicherheitskopie herunter. Prüfe, dass sie in deinem Downloadordner vorhanden ist, und bestätige den Empfang. Erst danach wird ersetzt.
6. Lass das Fenster bis zur Abschlussmeldung offen. Bei einer Fehlermeldung nicht von einem erfolgreichen Import ausgehen; die konkreten Angaben zur Rücknahme beachten.

Alte JSON-Sicherungen können ebenfalls ausgewählt werden. Sie enthalten selbst keine Bilder. Die Anwendung versucht, deren alte Bildlinks abzurufen und neu zu speichern. Nicht mehr verfügbare Originalbilder können aus einer solchen JSON-Datei nicht zurückgeholt werden.

## Automatische Entwurfsspeicherung

Während du ein Rezept erstellst oder bearbeitest, wird nach 500 ms Eingabepause ein lokaler Entwurf in IndexedDB gespeichert. Das schließt Rezeptteile, Zutaten, manuelle Nährwerte, Bezugsmenge, Zeiten, Tags, Links und die ausgewählte Bilddatei ein. Maximal 1 MiB Textdaten und 8 MiB Bild werden pro Entwurf akzeptiert; bei gesperrtem oder vollem Browserspeicher erscheint ausdrücklich **Entwurf NICHT gesichert**.

**Schließen · Entwurf behalten**, das Kreuz und Escape behalten einen geänderten Entwurf. Beim nächsten Öffnen desselben Rezepts kannst du **Entwurf wiederherstellen** oder **Entwurf verwerfen** wählen. Es wird nichts ungefragt übernommen. Nach erfolgreichem manuellen Speichern wird nur der zugehörige Entwurf entfernt. Bei einem Speicherkonflikt bleibt der Editor offen.

Neue Rezepte und jede bestehende Rezept-ID haben getrennte Entwürfe. Online sind diese außerdem nach Supabase-Projekt und Benutzer-ID getrennt; lokal nach Browser-Ursprung. Ein Entwurf aus einem anderen Tab wird nicht unbemerkt überschrieben. Ist der Server-/Dateistand inzwischen neuer oder gelöscht, wird das Überschreiben blockiert. Über **Als neues Rezept weiterbearbeiten** kannst du die Eingaben als eigenständige Variante retten. Ein bereits bestehender neuer Entwurf wird dabei nicht ersetzt.

Entwürfe sind ausschließlich in diesem Browserprofil auf diesem Gerät verfügbar, werden nicht mit Supabase synchronisiert und nicht als fertige Rezepte veröffentlicht. Löschen der Websitedaten, privater Modus oder ein anderer Browser/Port können sie unzugänglich machen. Die allerletzten Eingaben unmittelbar vor einem Browserabsturz können noch nicht geschrieben sein; bei noch ungesicherten Änderungen versucht die Anwendung zu sichern und warnt vor dem Verlassen. Ein erfolgreicher Speichervorgang ist erst durch die entsprechende Meldung bestätigt. Ein Anmeldewechsel unterbricht die Sicherung in einen fremden Benutzerkontext.

## Zugriffsrechte und Sicherheitsprüfung

Die Website bleibt öffentlich lesbar. Die bestehende Anmeldung wird nur für Cloud-Änderungen benötigt. Es gibt keine neue Rollen-, Einladungs- oder Registrierungsoberfläche. Der Frontend-Schlüssel ist ein öffentlicher `sb_publishable_`-Key, kein geheimer Service-Role-Key. Frontend-Sperren ersetzen keine serverseitigen RLS-Regeln ([Supabase-Dokumentation](https://supabase.com/docs/guides/database/postgres/row-level-security)).

Lesende Live-Prüfung am 12.11.2026:

| Prüfung | Tatsächliches Ergebnis |
| --- | --- |
| Rezepte mit Publishable-Key ohne Benutzersitzung lesen | HTTP 200; Stichprobe mit 20 Datensätzen |
| Vorhandenes öffentliches Bild aus `recipe-images` abrufen | HTTP 200, `image/webp` |
| Öffentliche Auth-Konfiguration lesen | HTTP 200, `disable_signup: false` |
| Frontend auf geheime Supabase-Schlüssel prüfen | Publishable-Key; kein Service-Role-/Secret-Key gefunden |
| Tatsächliche `recipes`-RLS-Regeln und Schreibrechte | **Nicht überprüft**: kein Dashboard-/SQL-Zugriff |
| Tatsächliche Storage-INSERT/UPDATE/DELETE-Regeln | **Nicht überprüft**: kein Dashboard-/SQL-Zugriff |
| Produktives anonymes INSERT/UPDATE/DELETE, Bild-Upload/-Löschen | **Nicht getestet**: bewusst keine produktiven Schreibversuche |
| Echte Anmeldung, Cloud-Schreiben und kompletter Live-Restore | **Nicht getestet**: keine isolierte Supabase-Testinstanz/Benutzerzugänge |

Die Anwendung validiert neue Bilder vor dem Upload anhand von Dateisignatur, Abmessungen und tatsächlicher Dekodierbarkeit, schreibt Bilder mit zufälligen Namen ohne Überschreiben und prüft vor Cloud-Schreibvorgängen die Anmeldung. Vorhandene Bilddateien werden nicht gelöscht. Servereigene Größen-/MIME- und Zugriffsgrenzen im Supabase-Bucket bleiben zusätzlich erforderlich und wurden nicht geändert.

Der lokale Server ist weiterhin nur unter `127.0.0.1` und ohne Cloud-Anmeldung nutzbar. Er weist fremde Browser-Origins und fremde Host-Header ab. ETags schützen auch normale Rezeptänderungen vor inzwischen veränderten lokalen Dateien. Fehlende Dateien gelten als leere Sammlung; leere/beschädigte vorhandene Dateien werden als Fehler gemeldet und nicht als leere Sammlung überschrieben. Nicht endliche Zahlen und doppelte IDs werden bei lokalen Schreibvorgängen abgelehnt.

### Offene manuelle Prüfung in Supabase

Es wurden **keine produktiven Policies oder Auth-Einstellungen geändert**. Führe keine pauschalen `CREATE POLICY`-/`DROP POLICY`-Anweisungen aus: Ohne die bestehenden Regeln wäre das nicht sicher.

1. Öffne im Supabase-Dashboard das bestehende Projekt mit Referenz `ohdamaixedupjivfobsv`.
2. Öffne **Authentication → Sign In / Providers** und suche unter der Benutzerregistrierung **Allow new users to sign up**. Die öffentlich lesbare Konfiguration erlaubt derzeit Registrierungen, obwohl das Kochbuch keine Registrierungsoberfläche hat. Wenn ausschließlich deine bestehenden Konten Zugang erhalten sollen, schalte diese Option aus und speichere. Bestehende Benutzer können sich weiterhin anmelden ([offizielle Beschreibung](https://supabase.com/docs/guides/auth/general-configuration)). Das ändert nichts an der öffentlichen Lesbarkeit der Rezepte. Prüfe zusätzlich unter **Authentication → Users**, ob alle bereits vorhandenen Konten bekannt und beabsichtigt sind; es wird hier keine Löschung empfohlen oder automatisch vorgenommen.
3. Öffne **SQL Editor → New query**, kopiere den gesamten Inhalt von `docs/supabase-audit.sql` hinein und wähle **Run**. Das Skript enthält ausschließlich `SELECT`-Abfragen und ändert weder Daten noch Richtlinien.
4. Prüfe die Ergebnisse: RLS für `public.recipes` muss aktiv sein. Öffentliches SELECT darf erlaubt bleiben. INSERT/UPDATE/DELETE dürfen nicht durch eine allgemeine `anon`-/`public`-Freigabe ermöglicht werden; die tatsächlich vorgesehenen angemeldeten Konten müssen durch die vorhandenen Regeln geschützt sein. Ist jede beliebige `authenticated`-Identität schreibberechtigt, ist die offene Registrierung aus Schritt 2 besonders relevant. Prüfe jeweils `USING` **und** `WITH CHECK` sowie permissive Zusatzregeln; aus dem Namen einer Policy allein folgt kein Schutz.
5. Prüfe unter **Storage → recipe-images → Policies** die Regeln für `storage.objects`: öffentliche Bildlesbarkeit darf erhalten bleiben; Upload-/Änderungs-/Löschrechte müssen auf beabsichtigte angemeldete Benutzer und den Bucket begrenzt sein. Die Anwendung verwendet Benutzer-ID-Ordner. Prüfe die Bucket-Grenzen für Dateigröße (passend zu 8 MiB) und MIME-Typen PNG/JPEG/GIF/WebP. Öffentlicher Bildzugriff bedeutet nicht, dass öffentliche Uploads zulässig sein sollen ([Storage-Dokumentation](https://supabase.com/docs/guides/storage/security/access-control)).
6. Wenn ein Ergebnis unklar ist, zuerst die tatsächlichen Audit-Ergebnisse prüfen lassen. Erst daraus lassen sich minimal notwendige Änderungs-SQLs ableiten. Hier wurde keine unbestätigte Policy erfunden.

## Gesamtkontrolle aller drei Teile

Die Tests arbeiten ausschließlich mit temporären lokalen Daten und einem Supabase-Simulator. Die ursprüngliche Rezeptdatei und vorhandene Bilder werden nicht für Schreib-/Löschtests verwendet.

| Bereich | Nachweis |
| --- | --- |
| A – manuelle Nährwerte, Bezugsmenge, Zutaten und Portionsskalierung; entfernte Suchelemente/Endpunkte | Regression Teil 1; alte Nährwerte und Null/leere Werte geprüft |
| B – Informationen, Tags, kombinierte Filter, Kategorien, Suche, Sortierung | Regression Teil 1; ZIP-Roundtrip erhält sämtliche Felder |
| C – Favoriten auf Karten/Details, Neuladen, Filter, Duplikate | Regression Teil 1; fehlgeschlagene Speicherung verändert keine Markierung |
| D – vollständige ZIPs mit echten Bildern, Zusammenführen/Ersetzen, Sicherheitskopie, Fehler-/Rücknahmefälle | Teil 2; Bilddateien geöffnet und bytegenau verglichen; Python `zipfile` kontrolliert das Archiv unabhängig |
| E – Entwürfe, Benutzer-/Rezepttrennung, veraltete Versionen, Speicherfehler | Teil 3 mit echtem IndexedDB und neu geladenem Browserdokument |
| E – Anmeldung und serverseitige Rechte | Anmeldung/Fehler nur simuliert; anonyme Lesbarkeit live geprüft; tatsächliche RLS-/Storage-Rechte offen, siehe oben |
| E – Darstellung und PDF | Chrome bei 320, 375, 768 und 1280 px; Überlauf-/Touch-/Schaltflächenprüfungen und Screenshots; echte PDF-Druckausgabe gerendert und visuell kontrolliert |
| F – alte/neue Rezepte, Kopieren/Löschen, Bilder, lokale Speicherung, Cloud-Konflikte | alle drei Testsuiten; Bestandsrezepte über Kopien geprüft; ETag-/Versionskonflikte und verzögerte Cloud-Abfragen getestet |
| GitHub Pages | statische lokale Skripte ohne zusätzlichen Build; neue Veröffentlichung mangels Freigabe nicht ausgeführt |

Während der Prüfung gefundene Probleme wurden korrigiert: Überlauf bei extrem langen Rezeptteilnamen auf 320 px, zu kleine Touchfläche des Detailherzens, abgeschnittene mobile Speichern-Leiste, fehlender Druckrand auf PDF-Folgeseiten, unversionierte mögliche Cloud-Updates und lokale Schreibvorgänge sowie Fehlerbehandlung bei Anmeldung und beschädigter lokaler Datei. Der Cloud-Reader wird von Anzeige und Backup gemeinsam verwendet, lädt seitenweise und zeigt bei einer tatsächlich leeren Cloud keine veralteten veröffentlichten Rezepte als aktuellen Bestand an.

**Nicht getestet:** reale iOS-/Android-Geräte und Safari, reale produktive Anmeldung/Schreib-/Löschrechte, kompletter Roundtrip gegen eine echte isolierte Supabase-Testinstanz sowie eine neue produktive GitHub-Pages-Veröffentlichung. Diese Punkte werden nicht als bestanden ausgegeben. Das ursprüngliche Desktop-Design, die Farben und die Schriftarten bleiben erhalten. Eine mögliche unvollständige Cloud-Rücknahme bei Netz-/Browserabbruch bleibt die in Teil 2 dokumentierte Architekturgrenze.

Letzter erfolgreicher Stand der automatisierten Prüfungen: **35 + 74 + 61 = 170 Browser-Prüfungen** in den drei Testsuiten, zusätzlich lokale Endpoint-/Origin-/Host-/Dateizustandsprüfungen, Syntax-/DOM-/Ressourcenprüfungen, unabhängige ZIP-Prüfung und 24 Screenshots. Der normale Bild-Upload wurde zusätzlich im Formular mit einer echten PNG-Datei getestet. Die fünfseitige Test-PDF wurde mit Chrome erzeugt, mit PDFKit geöffnet und vollständig gerendert; alle fünf Seiten wurden visuell geprüft. Zwischenzeitlich fehlgeschlagene Layoutprüfungen wurden nach den Korrekturen erfolgreich wiederholt.
