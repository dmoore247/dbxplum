-- ============================================================================
-- Lakebase CDF — DBA setup for the medplum `public` schema
--
-- Purpose : Prepare the medplum `public` schema for Lakebase Change Data Feed
--           (CDF), which streams Postgres changes to Delta history tables in
--           Unity Catalog (dmoore.dbxplum_history).
--
-- REPLICA IDENTITY FULL is required on EVERY tracked table:
--   Verified 2026-09-23 against the live CDF worker on the feature-cdf branch:
--   this CDF implementation requires REPLICA IDENTITY FULL on ALL source tables,
--   PRIMARY KEY OR NOT. A table left at DEFAULT identity shows up in
--   `wal2delta.tables` as status=SKIPPED / status_detail="Does not have REPLICA
--   IDENTITY FULL" and NOTHING is captured for it. An earlier belief that the
--   504 UUID-PK FHIR resource tables would track under DEFAULT identity was
--   WRONG — they were all being skipped. So this script sets FULL on every
--   public base table, not just the PK-less lookup tables.
--
--   NOTE on the worker: after setting FULL, the wal2delta worker only
--   re-evaluates a table on its NEXT write (WAL activity). On an idle branch a
--   table stays SKIPPED until a commit touches it, then flips to STREAMING and
--   the destination `lb_<table>_history` table materializes. This is expected;
--   real app traffic activates each table on its next write.
--
-- Empty lookup tables dropped (per operator request):
--   An audit of production write activity (pg_stat_user_tables, since DB
--   creation) found three PK-less Medplum search lookup tables that have never
--   held data or received a write: Address, ContactPoint, Identifier. They are
--   dropped here (guarded: empty-only). The two actively-written PK-less lookup
--   tables (HumanName, Coding_Property) are intentionally PK-less in current
--   Medplum (see medplum PR #4222) and are kept; FULL identity is what lets CDF
--   emit their before/after images and DELETE events.
--
-- Run (against the feature-cdf branch):
--   databricks psql projects/medplum/branches/feature-cdf/endpoints/primary \
--     -p FHIR -- -d databricks_postgres -f resources/lakebase-cdf-setup.sql
--
-- Ownership requirements (observed on this DB):
--   • DROP TABLE succeeds for a member of the schema owner (pg_database_owner),
--     which the database owner (douglas.moore@databricks.com) is.
--   • ALTER TABLE ... REPLICA IDENTITY requires the TABLE owner specifically —
--     here the Medplum app service principal (role 5dab691c-... /
--     dbrx-apps-5dab691c-...). databricks_superuser is NOT a Postgres superuser
--     and cannot do it. Run this authenticated AS the app service principal via
--     OAuth M2M (DATABRICKS_CLIENT_ID/SECRET + DATABRICKS_AUTH_TYPE=oauth-m2m),
--     which owns all public tables. If the ALTERs below report skips with
--     "must be owner of table", you are connected as the wrong role.
--
-- WARNING — dropping is intentional per operator request. Address/ContactPoint/
--   Identifier are still defined by the current Medplum schema code (they are
--   registered lookup tables), so a future Medplum migration or server start
--   MAY recreate them (CDF's schema-level config would then pick them up on
--   their first write, provided they too get FULL identity). The drops are
--   guarded to only fire when the table is EMPTY.
--
-- Idempotent / re-runnable:
--   REPLICA IDENTITY FULL is a no-op if already set; DROP uses IF EXISTS and an
--   emptiness guard. Safe to run repeatedly.
-- ============================================================================

\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. REPLICA IDENTITY FULL on EVERY public base table not already FULL.
--    Skips (with a warning) rather than aborting if we do not own a table.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r        record;
  n_set    int := 0;
  n_skip   int := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public' AND c.relkind = 'r' AND c.relreplident <> 'f'
    ORDER  BY c.relname
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL;', r.relname);
      n_set := n_set + 1;
    EXCEPTION WHEN insufficient_privilege THEN
      n_skip := n_skip + 1;
      RAISE WARNING 'SKIPPED public.% — must be table owner (app service principal)', r.relname;
    END;
  END LOOP;

  RAISE NOTICE 'REPLICA IDENTITY FULL set on % table(s); % already FULL, % skipped (not owner)',
               n_set,
               (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relreplident = 'f') - n_set,
               n_skip;

  IF n_skip > 0 THEN
    RAISE WARNING '% table(s) still need REPLICA IDENTITY FULL — re-run as the '
                  'app service principal (oauth-m2m) or a superuser.', n_skip;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Drop the three unused, empty lookup tables (Address, ContactPoint,
--    Identifier). Guarded: only drops when the table exists AND has 0 rows, so
--    a re-run (or a table that has since gained data) is safe.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t        text;
  targets  text[] := ARRAY['Address', 'ContactPoint', 'Identifier'];
  n_rows   bigint;
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'public.% already absent — nothing to drop', t;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n_rows;
    IF n_rows <> 0 THEN
      RAISE WARNING 'public.% has % row(s) — NOT dropping (guard: empty only)', t, n_rows;
      CONTINUE;
    END IF;

    BEGIN
      EXECUTE format('DROP TABLE IF EXISTS public.%I', t);
      RAISE NOTICE 'Dropped empty table public.%', t;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'SKIPPED drop of public.% — insufficient privilege', t;
    END;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Verification.
-- ----------------------------------------------------------------------------
-- 3a. Replica-identity coverage across all public base tables.
--     Expect every row under 'FULL' and zero under 'not-full'.
SELECT CASE c.relreplident WHEN 'f' THEN 'FULL' ELSE 'not-full' END AS replica_identity,
       count(*) AS table_count
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind = 'r'
GROUP  BY 1
ORDER  BY 2 DESC;

-- 3b. Any public base table still NOT FULL (expect zero rows).
SELECT c.relname AS table_not_full
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public' AND c.relkind = 'r' AND c.relreplident <> 'f'
ORDER  BY c.relname;

-- 3c. The dropped tables should no longer exist (expect zero rows returned).
SELECT c.relname AS still_present_should_be_empty
FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public'
  AND  c.relname IN ('Address', 'ContactPoint', 'Identifier')
  AND  c.relkind = 'r';
