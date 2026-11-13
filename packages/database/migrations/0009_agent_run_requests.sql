-- 0009: owner "Run treasury agent" request queue (M6). Idempotent.
-- The web process must not hold the agent token, so the owner's button writes a tenant-scoped request row and the agent
-- (through the payment guard) claims it. The row carries no payment data and no instruction beyond "run once": what to
-- pay is still decided by the agent and enforced by the guard's rules.
-- flow_web: SELECT and INSERT, plus UPDATE of status that a policy limits to expiring a stale open request (so an unclaimed
-- request cannot block a new one forever). flow_guard: SELECT and UPDATE of status and claimed_at only. No DELETE.
CREATE TABLE IF NOT EXISTS agent_run_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 64),
  requested_at timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'expired')),
  claimed_at   timestamptz
);
COMMENT ON TABLE agent_run_requests IS 'Owner requests to run the treasury agent once. Open requests older than 10 minutes expire at claim time.';
-- At most one open request per business.
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_requests_one_open ON agent_run_requests (business_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS agent_run_requests_business_idx ON agent_run_requests (business_id, requested_at DESC);
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_run_requests'] LOOP
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
GRANT SELECT, INSERT ON agent_run_requests TO flow_web;
GRANT UPDATE (status) ON agent_run_requests TO flow_web;
GRANT SELECT ON agent_run_requests TO flow_guard;
GRANT UPDATE (status, claimed_at) ON agent_run_requests TO flow_guard;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_run_requests' AND policyname = 'web_select') THEN
    CREATE POLICY web_select ON public.agent_run_requests FOR SELECT TO flow_web
      USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_run_requests' AND policyname = 'web_insert') THEN
    CREATE POLICY web_insert ON public.agent_run_requests FOR INSERT TO flow_web
      WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid AND status = 'open');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_run_requests' AND policyname = 'web_expire') THEN
    CREATE POLICY web_expire ON public.agent_run_requests FOR UPDATE TO flow_web
      USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid AND status = 'open' AND requested_at < now() - interval '10 minutes')
      WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid AND status = 'expired');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_run_requests' AND policyname = 'guard_select') THEN
    CREATE POLICY guard_select ON public.agent_run_requests FOR SELECT TO flow_guard USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_run_requests' AND policyname = 'guard_update') THEN
    CREATE POLICY guard_update ON public.agent_run_requests FOR UPDATE TO flow_guard USING (true) WITH CHECK (true);
  END IF;
END
$$;
