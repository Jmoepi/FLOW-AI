-- 0005: row-level security and least-privilege grants. Idempotent.
-- Default deny: RLS is ENABLED and FORCED on every table; only explicit per-command policies for flow_guard exist,
-- and only where a GRANT exists. No policy for anon, authenticated or PUBLIC. No DELETE or TRUNCATE for anyone.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'businesses', 'business_members', 'treasury_wallets', 'balance_snapshots', 'suppliers', 'invoices',
    'treasury_policies', 'daily_spend_reservations', 'payments', 'agent_runs', 'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
  END LOOP;
END
$$;

-- Supabase roles (when present) get nothing, on tables, functions and sequences.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- Functions: no implicit EXECUTE for PUBLIC.
REVOKE ALL ON FUNCTION payments_guard_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION payments_guard_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION payments_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION reservations_guard_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION reservations_enforce_cap() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_row_hash(text, bigint, uuid, text, text, text, text, text, jsonb, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION verify_audit_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_row_hash(text, bigint, uuid, text, text, text, text, text, jsonb, text, timestamptz) TO flow_guard;
GRANT EXECUTE ON FUNCTION verify_audit_chain(uuid) TO flow_guard;

-- Table grants for the guard (re-granting is idempotent).
GRANT SELECT ON businesses, treasury_wallets, suppliers, invoices, treasury_policies, payments,
                daily_spend_reservations, balance_snapshots, audit_events TO flow_guard;
GRANT INSERT ON payments, daily_spend_reservations, balance_snapshots, audit_events TO flow_guard;
GRANT UPDATE (status, tx_hash, last_ledger_sequence, first_ledger_sequence, ledger_index, result_code, delivered_amount,
              fee_drops, failure_code, failure_message, signed_blob, submitted_at, validated_at, updated_at)
  ON payments TO flow_guard;
GRANT UPDATE (status, updated_at) ON daily_spend_reservations TO flow_guard;
GRANT UPDATE (status, updated_at) ON invoices TO flow_guard;

-- Explicit policies, one per command that has a grant.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'businesses', 'treasury_wallets', 'suppliers', 'invoices', 'treasury_policies', 'payments',
    'daily_spend_reservations', 'balance_snapshots', 'audit_events'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'guard_select') THEN
      EXECUTE format('CREATE POLICY guard_select ON public.%I FOR SELECT TO flow_guard USING (true)', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['payments', 'daily_spend_reservations', 'balance_snapshots', 'audit_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'guard_insert') THEN
      EXECUTE format('CREATE POLICY guard_insert ON public.%I FOR INSERT TO flow_guard WITH CHECK (true)', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['payments', 'daily_spend_reservations', 'invoices'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'guard_update') THEN
      EXECUTE format('CREATE POLICY guard_update ON public.%I FOR UPDATE TO flow_guard USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END
$$;
