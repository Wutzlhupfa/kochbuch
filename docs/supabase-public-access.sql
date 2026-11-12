-- Am 12.11.2026 nach lesender Prüfung und ausdrücklicher Freigabe ausgeführt.
-- Dokumentation der produktiven Freigabe; erneute Ausführung nicht notwendig.
-- Jeder Besucher darf anschließend alle Rezepte und Rezeptbilder verändern/löschen.
-- RLS bleibt aktiv; andere Storage-Buckets werden nicht freigegeben.
-- Keine Rezepte, Bilder oder Benutzer werden durch dieses Skript gelöscht.
BEGIN;
ALTER POLICY "Angemeldete dürfen Rezepte anlegen" ON public.recipes
  TO anon, authenticated WITH CHECK (true);
ALTER POLICY "Angemeldete dürfen Rezepte ändern" ON public.recipes
  TO anon, authenticated USING (true) WITH CHECK (true);
ALTER POLICY "Angemeldete dürfen Rezepte löschen" ON public.recipes
  TO anon, authenticated USING (true);
ALTER POLICY "Angemeldete dürfen Bilder hochladen" ON storage.objects
  TO anon, authenticated WITH CHECK (bucket_id = 'recipe-images');
ALTER POLICY "Angemeldete dürfen Bilder ändern" ON storage.objects
  TO anon, authenticated USING (bucket_id = 'recipe-images')
  WITH CHECK (bucket_id = 'recipe-images');
ALTER POLICY "Angemeldete dürfen Bilder löschen" ON storage.objects
  TO anon, authenticated USING (bucket_id = 'recipe-images');
-- Diese unnötigen Tabellenrechte umgehen teilweise die zeilenweise Prüfung.
-- Für die Anwendung werden nur SELECT, INSERT, UPDATE und DELETE benötigt.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.recipes FROM anon, authenticated;
COMMIT;

-- Die beiden Konten wurden anschließend separat nach Sicherung entfernt.
-- Nullable Autoren-/Besitzverweise wurden zuvor gelöst, keine Bilddatei gelöscht.
-- Atomare Kontrolle: Rezept-JSON und Bildpfade/-metadaten unverändert,
-- Ergebnis 0 Benutzer, 33 Rezepte, 44 Bilder. Live-Bildabrufe zusätzlich geprüft.
-- Geprüft: recipes.updated_by ist nullable und verweist ohne CASCADE auf auth.users.
-- 44 Storage-Dateien besitzen eines der beiden Anwendungskonten.
-- Keine Storage-Datei löschen oder verschieben, um ein Konto entfernen zu können.
