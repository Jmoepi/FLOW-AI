-- 0011: revocable regular-key backstop (M7, spec 10.6 to 10.8). Idempotent.
-- (1) The poller records what it OBSERVES about the treasury's RegularKey on each balance snapshot (read-only, informational).
ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS regular_key_state text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'balance_snapshots_regular_key_state_check') THEN
    ALTER TABLE balance_snapshots ADD CONSTRAINT balance_snapshots_regular_key_state_check
      CHECK (regular_key_state IS NULL OR regular_key_state IN ('active', 'not_set', 'other', 'not_configured'));
  END IF;
END
$$;
-- (2) The guard may change ONE column of treasury_wallets, signing_key_mode, so a rejected signing key survives a restart (fail closed).
-- The web role has no UPDATE. Only the transitions below are possible (enforced by trigger, for every role).
GRANT UPDATE (signing_key_mode) ON treasury_wallets TO flow_guard;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'treasury_wallets' AND policyname = 'guard_update') THEN
    CREATE POLICY guard_update ON public.treasury_wallets FOR UPDATE TO flow_guard USING (true) WITH CHECK (true);
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION treasury_wallet_signing_key_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signing_key_mode IS DISTINCT FROM OLD.signing_key_mode AND NOT (
       (OLD.signing_key_mode = 'master_env'  AND NEW.signing_key_mode = 'regular_key')
    OR (OLD.signing_key_mode = 'regular_key' AND NEW.signing_key_mode = 'revoked')
    OR (OLD.signing_key_mode = 'revoked'     AND NEW.signing_key_mode = 'regular_key')
  ) THEN
    RAISE EXCEPTION 'signing_key_mode transition % -> % is not allowed', OLD.signing_key_mode, NEW.signing_key_mode USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS treasury_wallet_signing_key_transition ON treasury_wallets;
CREATE TRIGGER treasury_wallet_signing_key_transition BEFORE UPDATE ON treasury_wallets
  FOR EACH ROW EXECUTE FUNCTION treasury_wallet_signing_key_transition();
