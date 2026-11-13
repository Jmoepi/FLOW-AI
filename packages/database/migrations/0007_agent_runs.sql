-- 0007: agent run records (M5). Idempotent.
-- The agent has no database access. It records runs THROUGH the payment guard (flow_guard), which is append-only here:
-- runs move running -> one terminal state exactly once, events are insert-only and gap-free (max 32 per run), and at most
-- one run per business can be `running` (the guard-side lock). flow_web gets SELECT on its own tenant for the Agent
-- activity page. Free text is never stored from the model except the bounded, control-stripped agent_reason.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS effective_mode text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES payments(id);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS decision_code text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_reason text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_status_valid' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_valid CHECK (status IN
      ('running', 'paid', 'pending', 'blocked', 'no_candidate', 'failed', 'timed_out', 'limit_exceeded', 'interrupted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_effective_mode_valid' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_effective_mode_valid CHECK (effective_mode IS NULL OR effective_mode IN ('llm', 'deterministic'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_decision_code_valid' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_decision_code_valid CHECK (decision_code IS NULL OR decision_code ~ '^[A-Z_]{1,64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_agent_reason_len' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_agent_reason_len CHECK (agent_reason IS NULL OR length(agent_reason) <= 280);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_tool_calls_max' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_tool_calls_max CHECK (tool_call_count <= 5);
  END IF;
END
$$;

-- Guard-side lock: at most one running run per business.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_running ON agent_runs (business_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS agent_runs_business_seq_idx ON agent_runs (business_id, seq DESC);
CREATE INDEX IF NOT EXISTS agent_runs_running_activity_idx ON agent_runs (last_activity_at) WHERE status = 'running';
COMMENT ON TABLE agent_runs IS 'Agent run bookkeeping, written only through the payment guard (append-only; terminal states are immutable). The agent itself has no database access.';

CREATE TABLE IF NOT EXISTS agent_run_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES agent_runs(id),
  business_id uuid NOT NULL REFERENCES businesses(id),
  seq         integer NOT NULL CHECK (seq BETWEEN 1 AND 32),
  kind        text NOT NULL CHECK (kind IN ('tool_call', 'decision', 'model_turn', 'mode_fallback', 'note')),
  tool_name   text CHECK (tool_name IS NULL OR tool_name IN
                ('get_business_snapshot', 'list_open_invoices', 'get_invoice_details', 'request_supplier_payment', 'get_payment_status')),
  ok          boolean,
  error_code  text CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{1,64}$'),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  input       jsonb CHECK (input IS NULL OR (jsonb_typeof(input) = 'object' AND pg_column_size(input) <= 8192)),
  output      jsonb CHECK (output IS NULL OR (jsonb_typeof(output) = 'object' AND pg_column_size(output) <= 8192)),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, seq)
);
COMMENT ON TABLE agent_run_events IS 'Append-only agent tool-call trail with redacted, bounded inputs and outputs. Never holds raw invoice text, secrets or tokens.';
CREATE INDEX IF NOT EXISTS agent_run_events_business_idx ON agent_run_events (business_id, run_id);

-- Runs: INSERT only as `running`; UPDATE only running -> terminal (once); identity columns immutable; references stay in-tenant.
CREATE OR REPLACE FUNCTION agent_runs_guard_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'running' OR NEW.completed_at IS NOT NULL OR NEW.payment_id IS NOT NULL OR NEW.tool_call_count <> 0 THEN
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
  IF NEW.payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id AND p.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'payment does not belong to this business' USING ERRCODE = '23514';
  END IF;
  IF NEW.candidate_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = NEW.candidate_invoice_id AND i.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'invoice does not belong to this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION agent_runs_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'agent_runs rows cannot be deleted' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION agent_run_events_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'agent_run_events is append-only' USING ERRCODE = '55000';
END
$$;

-- Events: the run must be running and in the same tenant; seq must be the next number (so no gaps, max 32 events).
CREATE OR REPLACE FUNCTION agent_run_events_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  run_status text;
  run_business uuid;
  last_seq integer;
BEGIN
  SELECT r.status, r.business_id INTO run_status, run_business FROM agent_runs r WHERE r.id = NEW.run_id;
  IF run_status IS NULL OR run_status <> 'running' THEN
    RAISE EXCEPTION 'agent run is not running' USING ERRCODE = '55000';
  END IF;
  IF run_business <> NEW.business_id THEN
    RAISE EXCEPTION 'event business does not match the run' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max(e.seq), 0) INTO last_seq FROM agent_run_events e WHERE e.run_id = NEW.run_id;
  IF NEW.seq <> last_seq + 1 THEN
    RAISE EXCEPTION 'agent run event seq must be the next number' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION agent_runs_guard_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_runs_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_events_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_events_guard_insert() FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_runs_guard_transition' AND tgrelid = 'agent_runs'::regclass) THEN
    CREATE TRIGGER agent_runs_guard_transition BEFORE INSERT OR UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_runs_guard_transition();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_runs_no_delete' AND tgrelid = 'agent_runs'::regclass) THEN
    CREATE TRIGGER agent_runs_no_delete BEFORE DELETE ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_runs_no_delete();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_runs_no_truncate' AND tgrelid = 'agent_runs'::regclass) THEN
    CREATE TRIGGER agent_runs_no_truncate BEFORE TRUNCATE ON agent_runs FOR EACH STATEMENT EXECUTE FUNCTION agent_runs_no_delete();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_run_events_guard_insert' AND tgrelid = 'agent_run_events'::regclass) THEN
    CREATE TRIGGER agent_run_events_guard_insert BEFORE INSERT ON agent_run_events FOR EACH ROW EXECUTE FUNCTION agent_run_events_guard_insert();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_run_events_immutable' AND tgrelid = 'agent_run_events'::regclass) THEN
    CREATE TRIGGER agent_run_events_immutable BEFORE UPDATE OR DELETE ON agent_run_events FOR EACH ROW EXECUTE FUNCTION agent_run_events_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_run_events_no_truncate' AND tgrelid = 'agent_run_events'::regclass) THEN
    CREATE TRIGGER agent_run_events_no_truncate BEFORE TRUNCATE ON agent_run_events FOR EACH STATEMENT EXECUTE FUNCTION agent_run_events_immutable();
  END IF;
END
$$;

-- RLS: enabled and forced; nothing for PUBLIC, anon or authenticated.
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs', 'agent_run_events'] LOOP
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

-- Grants. No DELETE or TRUNCATE for anyone; events are insert-only for the guard.
GRANT SELECT, INSERT ON agent_runs, agent_run_events TO flow_guard;
GRANT UPDATE (status, completed_at, summary, tool_call_count, candidate_invoice_id, payment_id, decision_code, agent_reason, effective_mode, last_activity_at)
  ON agent_runs TO flow_guard;
GRANT SELECT ON agent_runs, agent_run_events TO flow_web;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs', 'agent_run_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'guard_select') THEN
      EXECUTE format('CREATE POLICY guard_select ON public.%I FOR SELECT TO flow_guard USING (true)', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'guard_insert') THEN
      EXECUTE format('CREATE POLICY guard_insert ON public.%I FOR INSERT TO flow_guard WITH CHECK (true)', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'web_select') THEN
      EXECUTE format($p$CREATE POLICY web_select ON public.%I FOR SELECT TO flow_web
        USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_runs' AND policyname = 'guard_update') THEN
    CREATE POLICY guard_update ON public.agent_runs FOR UPDATE TO flow_guard USING (true) WITH CHECK (true);
  END IF;
END
$$;
