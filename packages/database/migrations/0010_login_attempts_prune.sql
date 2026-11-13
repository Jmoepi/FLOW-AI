-- 0010: housekeeping for login_attempts (M6). Idempotent.
-- Rate-limit windows are 15 minutes long; rows older than a day have no value. The web role may delete ONLY such old rows:
-- the grant is table level (Postgres has no column-level DELETE) but the policy limits it to windows older than one day,
-- so a fresh window (the live rate-limit counter) can never be deleted by the web role. flow_guard has no grant.
GRANT DELETE ON login_attempts TO flow_web;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'login_attempts' AND policyname = 'web_delete') THEN
    CREATE POLICY web_delete ON public.login_attempts FOR DELETE TO flow_web
      USING (window_start < now() - interval '1 day');
  END IF;
END
$$;
