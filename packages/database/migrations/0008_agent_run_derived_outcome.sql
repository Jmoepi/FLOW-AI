-- 0008: guard-derived agent run outcomes (M5 fix M-1). Idempotent.
-- The agent is untrusted. From this migration on, agent_runs.status for a finished run is DERIVED by the payment guard from
-- its own records (the payment requests it observed during the run and the payments table), never copied from the agent.
-- What the agent claimed is kept apart in client_status (an untrusted hint; never used to display an outcome).
-- The database also refuses the two dangerous shapes: a payment id that this run never requested, and 'paid' without a
-- validated payment that this run requested.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS client_status text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_client_status_valid' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_client_status_valid CHECK (client_status IS NULL OR client_status IN
      ('paid', 'pending', 'blocked', 'no_candidate', 'failed', 'timed_out', 'limit_exceeded', 'interrupted'));
  END IF;
END
$$;
COMMENT ON COLUMN agent_runs.client_status IS 'UNTRUSTED status hint reported by the agent. Stored for diagnosis only; status is derived by the guard.';
-- One row per payment request the guard served to the agent while a run was running. Written by the guard, insert-only.
CREATE TABLE IF NOT EXISTS agent_run_payment_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES agent_runs(id),
  business_id           uuid NOT NULL REFERENCES businesses(id),
  invoice_id            uuid NOT NULL REFERENCES invoices(id),
  idempotency_key       text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  payment_id            uuid REFERENCES payments(id),
  observed_status       text NOT NULL CHECK (observed_status IN
                          ('requested', 'blocked', 'reserved', 'submitted', 'validated', 'failed', 'pending_confirmation', 'cancelled')),
  observed_decision_code text CHECK (observed_decision_code IS NULL OR observed_decision_code ~ '^[A-Z_]{1,64}$'),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, idempotency_key)
);
COMMENT ON TABLE agent_run_payment_requests IS 'Payment requests the guard served during an agent run (guard-observed, insert-only). The run outcome is derived from these rows and the payments table.';
CREATE INDEX IF NOT EXISTS agent_run_payment_requests_run_idx ON agent_run_payment_requests (run_id, created_at);
CREATE INDEX IF NOT EXISTS agent_run_payment_requests_payment_idx ON agent_run_payment_requests (payment_id) WHERE payment_id IS NOT NULL;
CREATE OR REPLACE FUNCTION agent_run_payment_requests_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  run_status text;
  run_business uuid;
  n integer;
BEGIN
  SELECT r.status, r.business_id INTO run_status, run_business FROM agent_runs r WHERE r.id = NEW.run_id;
  IF run_status IS NULL OR run_status <> 'running' THEN
    RAISE EXCEPTION 'agent run is not running' USING ERRCODE = '55000';
  END IF;
  IF run_business <> NEW.business_id THEN
    RAISE EXCEPTION 'request business does not match the run' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id AND i.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'invoice does not belong to this business' USING ERRCODE = '23514';
  END IF;
  IF NEW.payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id AND p.business_id = NEW.business_id AND p.invoice_id = NEW.invoice_id) THEN
    RAISE EXCEPTION 'payment does not belong to this business and invoice' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO n FROM agent_run_payment_requests q WHERE q.run_id = NEW.run_id;
  IF n >= 5 THEN
    RAISE EXCEPTION 'too many payment requests recorded for this run' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION agent_run_payment_requests_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'agent_run_payment_requests is append-only' USING ERRCODE = '55000';
END
$$;
-- Extends the 0007 transition guard: a terminal run may only reference a payment that it requested itself, and 'paid'
-- requires one of those payments to be validated. client_status is stored with the transition and then immutable (the
-- whole row is immutable once finished).
CREATE OR REPLACE FUNCTION agent_runs_guard_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.completed_at IS NOT NULL OR NEW.payment_id IS NOT NULL OR NEW.tool_call_count <> 0 OR NEW.client_status IS NOT NULL THEN
      RAISE EXCEPTION 'agent run must start as running' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'agent run is finished and immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.seq <> OLD.seq OR NEW.business_id <> OLD.business_id OR NEW.trigger <> OLD.trigger
     OR NEW.mode <> OLD.mode OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'agent run identity columns are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> 'running' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, clock_timestamp());
  ELSIF NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a running agent run cannot have completed_at' USING ERRCODE = '55000';
  END IF;
  IF NEW.payment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM agent_run_payment_requests q
        WHERE q.run_id = NEW.id AND q.business_id = NEW.business_id AND q.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment was not requested by this run' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'paid' AND NOT EXISTS (
       SELECT 1 FROM payments p WHERE p.id = NEW.payment_id AND p.business_id = NEW.business_id AND p.status = 'validated') THEN
    RAISE EXCEPTION 'a paid run needs a validated payment of its own' USING ERRCODE = '23514';
  END IF;
  IF NEW.candidate_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = NEW.candidate_invoice_id AND i.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'invoice does not belong to this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION agent_run_payment_requests_guard_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_payment_requests_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_runs_guard_transition() FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_run_payment_requests_guard_insert' AND tgrelid = 'agent_run_payment_requests'::regclass) THEN
    CREATE TRIGGER agent_run_payment_requests_guard_insert BEFORE INSERT ON agent_run_payment_requests FOR EACH ROW EXECUTE FUNCTION agent_run_payment_requests_guard_insert();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_run_payment_requests_immutable' AND tgrelid = 'agent_run_payment_requests'::regclass) THEN
    CREATE TRIGGER agent_run_payment_requests_immutable BEFORE UPDATE OR DELETE ON agent_run_payment_requests FOR EACH ROW EXECUTE FUNCTION agent_run_payment_requests_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_run_payment_requests_no_truncate' AND tgrelid = 'agent_run_payment_requests'::regclass) THEN
    CREATE TRIGGER agent_run_payment_requests_no_truncate BEFORE TRUNCATE ON agent_run_payment_requests FOR EACH STATEMENT EXECUTE FUNCTION agent_run_payment_requests_immutable();
  END IF;
END
$$;
-- RLS: enabled and forced; nothing for PUBLIC, anon or authenticated.
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_run_payment_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
GRANT SELECT, INSERT ON agent_run_payment_requests TO flow_guard;
GRANT UPDATE (client_status) ON agent_runs TO flow_guard;
GRANT SELECT ON agent_run_payment_requests TO flow_web;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_run_payment_requests' AND policyname = 'guard_select') THEN
    CREATE POLICY guard_select ON public.agent_run_payment_requests FOR SELECT TO flow_guard USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_run_payment_requests' AND policyname = 'guard_insert') THEN
    CREATE POLICY guard_insert ON public.agent_run_payment_requests FOR INSERT TO flow_guard WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_run_payment_requests' AND policyname = 'web_select') THEN
    CREATE POLICY web_select ON public.agent_run_payment_requests FOR SELECT TO flow_web
      USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
  END IF;
END
$$;
