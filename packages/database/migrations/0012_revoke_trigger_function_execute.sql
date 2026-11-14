-- 0012: least privilege for the 0011 trigger function. Revoke-only and idempotent.
-- A trigger function is checked for EXECUTE only when the trigger is created (by the owner), never when it fires,
-- so no app role needs EXECUTE on it. PostgreSQL's default grants EXECUTE to PUBLIC on new functions.
REVOKE ALL ON FUNCTION treasury_wallet_signing_key_transition() FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'flow_guard', 'flow_web'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION treasury_wallet_signing_key_transition() FROM %I', r);
    END IF;
  END LOOP;
END
$$;
