-- 0006: owner web app role (flow_web), local credential/session tables, business-scoped RLS. Idempotent.
-- flow_web is created WITHOUT a password (set out of band, like flow_guard). It can read its own tenant, change ONLY the
-- owner-controlled policy columns and supplier flags, and append audit events. It can never write payments,
-- reservations, wallets, invoices, or touch audit_events beyond INSERT/SELECT. Tenant isolation is RLS keyed on the
-- transaction-local setting app.business_id (set by the application from the verified session, never from input).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_web') THEN
    CREATE ROLE flow_web LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
  ALTER ROLE flow_web NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  -- NOSUPERUSER is not part of the ALTER above: hosted Postgres (Supabase) admins are not superusers and may not name it.
  -- A role created above is already NOSUPERUSER; this undoes a manual escalation and fails loudly if it cannot.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_web' AND rolsuper) THEN
    ALTER ROLE flow_web NOSUPERUSER;
  END IF;
END
$$;
DO $$
BEGIN
  GRANT USAGE ON SCHEMA public TO flow_web;
END
$$;
-- Local-provider credential and session tables (AU-1 exception documented in docs/m4-notes.md; replaced in M6).
CREATE TABLE IF NOT EXISTS web_credentials (
  user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 20 AND 512),
  failed_count  integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE web_credentials IS 'Local password credentials (scrypt hash only). Replaced by Supabase Auth in M6. Never selected by the guard.';
CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash             text PRIMARY KEY CHECK (id_hash ~ '^[0-9a-f]{64}$'),
  user_id             uuid NOT NULL REFERENCES web_credentials(user_id),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  role                text NOT NULL CHECK (role IN ('owner', 'viewer')),
  csrf_hash           text NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  authenticated_at    timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  ip_hash             text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  ua_hash             text CHECK (ua_hash IS NULL OR ua_hash ~ '^[0-9a-f]{64}$')
);
COMMENT ON TABLE web_sessions IS 'Server-side sessions. Only the sha256 of the token is stored; the token itself exists only in the cookie.';
CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions (user_id);
CREATE TABLE IF NOT EXISTS login_attempts (
  key_hash     text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (key_hash, window_start)
);
COMMENT ON TABLE login_attempts IS 'Fixed-window login attempt counters keyed by a hash of the IP or email. No raw identifiers.';
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['web_credentials', 'web_sessions', 'login_attempts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
  END LOOP;
END
$$;
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['web_credentials', 'web_sessions', 'login_attempts'] LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION audit_row_hash(text, bigint, uuid, text, text, text, text, text, jsonb, text, timestamptz) FROM PUBLIC;
-- Needed by the audit_chain trigger, which runs as the inserting role.
GRANT EXECUTE ON FUNCTION audit_row_hash(text, bigint, uuid, text, text, text, text, text, jsonb, text, timestamptz) TO flow_web;
-- Table grants (re-granting is idempotent). No DELETE, TRUNCATE or REFERENCES anywhere; no write on money tables.
GRANT SELECT ON businesses, business_members, treasury_wallets, balance_snapshots, suppliers, invoices,
                treasury_policies, payments, daily_spend_reservations, audit_events TO flow_web;
GRANT INSERT ON audit_events TO flow_web;
GRANT UPDATE (enabled, max_payment_amount, daily_spend_limit, minimum_reserve, allowed_assets, valid_until, version, updated_by, updated_at)
  ON treasury_policies TO flow_web;
GRANT UPDATE (is_approved, is_active, updated_at) ON suppliers TO flow_web;
GRANT SELECT, INSERT ON web_sessions, login_attempts TO flow_web;
GRANT UPDATE (last_seen_at, authenticated_at, csrf_hash, revoked_at) ON web_sessions TO flow_web;
GRANT UPDATE (attempts) ON login_attempts TO flow_web;
GRANT SELECT ON web_credentials TO flow_web;
GRANT UPDATE (failed_count, locked_until, password_hash) ON web_credentials TO flow_web;
-- Explicit per-command policies. Tenant tables: the row's business must equal the transaction-local app.business_id.
-- A missing or empty setting yields NULL, which matches nothing (default deny).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'web_select') THEN
      EXECUTE format($p$CREATE POLICY web_select ON public.%I FOR SELECT TO flow_web
        USING (id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['treasury_wallets', 'suppliers', 'invoices', 'treasury_policies', 'payments', 'daily_spend_reservations', 'audit_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'web_select') THEN
      EXECUTE format($p$CREATE POLICY web_select ON public.%I FOR SELECT TO flow_web
        USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
    END IF;
  END LOOP;
  -- Membership is looked up by user id at login (before the business is known), or by business afterwards.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_members' AND policyname = 'web_select') THEN
    CREATE POLICY web_select ON public.business_members FOR SELECT TO flow_web
      USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid
             OR business_id = nullif(current_setting('app.business_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'balance_snapshots' AND policyname = 'web_select') THEN
    CREATE POLICY web_select ON public.balance_snapshots FOR SELECT TO flow_web
      USING (wallet_id IN (SELECT id FROM public.treasury_wallets WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_events' AND policyname = 'web_insert') THEN
    CREATE POLICY web_insert ON public.audit_events FOR INSERT TO flow_web
      WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
  END IF;
  FOREACH t IN ARRAY ARRAY['suppliers', 'treasury_policies'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'web_update') THEN
      EXECUTE format($p$CREATE POLICY web_update ON public.%I FOR UPDATE TO flow_web
        USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
        WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
    END IF;
  END LOOP;
  -- Credential, session and rate-limit rows are looked up by hash/email before any tenant is known; access is
  -- limited by the column grants above and by the fact that only hashes are stored.
  FOREACH t IN ARRAY ARRAY['web_credentials', 'web_sessions', 'login_attempts'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'web_select') THEN
      EXECUTE format('CREATE POLICY web_select ON public.%I FOR SELECT TO flow_web USING (true)', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['web_sessions', 'login_attempts'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'web_insert') THEN
      EXECUTE format('CREATE POLICY web_insert ON public.%I FOR INSERT TO flow_web WITH CHECK (true)', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['web_credentials', 'web_sessions', 'login_attempts'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'web_update') THEN
      EXECUTE format('CREATE POLICY web_update ON public.%I FOR UPDATE TO flow_web USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END
$$;
