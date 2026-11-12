-- Nur lesende Sicherheitsprüfung. Keine Policies, Rollen oder Daten werden geändert.
-- Im Supabase SQL Editor ausführen; Ergebnisse zur Prüfung der realen Regeln verwenden.
SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE (n.nspname = 'public' AND c.relname = 'recipes')
   OR (n.nspname = 'storage' AND c.relname IN ('objects', 'buckets'));

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE (schemaname = 'public' AND tablename = 'recipes')
   OR (schemaname = 'storage' AND tablename = 'objects')
ORDER BY schemaname, tablename, policyname;

SELECT table_schema, table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE (table_schema = 'public' AND table_name = 'recipes')
   OR (table_schema = 'storage' AND table_name = 'objects')
ORDER BY table_schema, table_name, grantee, privilege_type;

SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets WHERE id = 'recipe-images';

-- Relevant für den vorhandenen updated_at-Konfliktschutz und die Import-Rücknahme.
SELECT tgname AS trigger_name, pg_get_triggerdef(oid) AS definition
FROM pg_trigger WHERE tgrelid = 'public.recipes'::regclass AND NOT tgisinternal;

-- Vor der ausdrücklich gewünschten Benutzerlöschung: Abhängigkeiten prüfen.
-- ON DELETE CASCADE darf keine Rezepte oder Bilder mitlöschen.
SELECT conrelid::regclass AS referencing_table, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE confrelid = 'auth.users'::regclass;
SELECT count(*) AS auth_user_count FROM auth.users;
SELECT count(*) AS recipe_count FROM public.recipes;
SELECT count(*) AS image_count FROM storage.objects WHERE bucket_id = 'recipe-images';
