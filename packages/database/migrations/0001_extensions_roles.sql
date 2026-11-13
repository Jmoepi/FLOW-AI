-- 0001: roles and baseline privileges. Idempotent. No extensions are needed (built-in sha256(), gen_random_uuid()),
-- so this runs unchanged on local Postgres 15+ and on Supabase.
-- The flow_guard role is created WITHOUT a password. The password is set out of band by scripts/db-local.ts (local)
-- or by the operator (hosted) and never appears in any file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_guard') THEN
    CREATE ROLE flow_guard LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
  -- Re-assert the safe attributes on every run (a manual ALTER ROLE must not stay in effect).
  ALTER ROLE flow_guard NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  -- NOSUPERUSER is not part of the ALTER above: hosted Postgres (Supabase) admins are not superusers and may not name it.
  -- A role created above is already NOSUPERUSER; this undoes a manual escalation and fails loudly if it cannot.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_guard' AND rolsuper) THEN
    ALTER ROLE flow_guard NOSUPERUSER;
  END IF;
END
$$;

-- Nobody gets implicit access: schema usage is granted explicitly to the guard only.
DO $$
BEGIN
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO flow_guard;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not revoke PUBLIC on schema public (not the schema owner); skipped';
END
$$;

-- Supabase ships anon/authenticated with default privileges on public. Strip them (the guard is a server-side role;
-- the browser must never reach these tables through PostgREST).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;
