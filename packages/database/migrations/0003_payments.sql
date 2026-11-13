-- 0003: payments, reservations and the state-machine / cap triggers. Idempotent.
-- Additive payments columns beyond spec 8.1: request_hash, signed_blob, first_ledger_sequence, previous_payment_id,
-- business_date, updated_at.
-- Concurrency: the policy "lock" is a transaction-scoped advisory lock keyed on the business. The guard has no UPDATE
-- right on treasury_policies, so SELECT ... FOR UPDATE on it is not available to it by design. The app
-- (lockPolicyForUpdate) and the cap trigger use the SAME key, so they serialise against each other.

CREATE TABLE IF NOT EXISTS payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id),
  invoice_id            uuid NOT NULL,
  supplier_id           uuid NOT NULL,
  wallet_id             uuid NOT NULL,
  network               text NOT NULL CHECK (network = 'xrpl-testnet'),
  asset_currency        text NOT NULL CHECK (length(asset_currency) BETWEEN 1 AND 40),
  asset_issuer          text NOT NULL CHECK (asset_issuer ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
  amount                numeric NOT NULL CHECK (amount > 0 AND scale(amount) <= 6 AND amount < 1000000000000),
  destination_address   text NOT NULL CHECK (destination_address ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
  status                text NOT NULL CHECK (status IN ('requested', 'blocked', 'reserved', 'submitted', 'pending_confirmation', 'validated', 'failed', 'cancelled')),
  policy_version        integer NOT NULL CHECK (policy_version >= 0),
  idempotency_key       text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash          text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  tx_hash               text CHECK (tx_hash IS NULL OR tx_hash ~ '^[0-9A-F]{64}$'),
  last_ledger_sequence  integer CHECK (last_ledger_sequence IS NULL OR last_ledger_sequence > 0),
  first_ledger_sequence integer CHECK (first_ledger_sequence IS NULL OR first_ledger_sequence > 0),
  ledger_index          integer CHECK (ledger_index IS NULL OR ledger_index > 0),
  result_code           text CHECK (result_code IS NULL OR result_code ~ '^[a-zA-Z_]{3,40}$'),
  delivered_amount      numeric CHECK (delivered_amount IS NULL OR (delivered_amount >= 0 AND scale(delivered_amount) <= 6 AND delivered_amount < 1000000000000)),
  fee_drops             bigint CHECK (fee_drops IS NULL OR fee_drops >= 0),
  failure_code          text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{2,64}$'),
  failure_message       text CHECK (failure_message IS NULL OR length(failure_message) <= 500),
  agent_reason          text CHECK (agent_reason IS NULL OR length(agent_reason) <= 280),
  signed_blob           text CHECK (signed_blob IS NULL OR (signed_blob ~ '^[0-9A-F]+$' AND length(signed_blob) BETWEEN 2 AND 100000)),
  previous_payment_id   uuid REFERENCES payments(id),
  business_date         date NOT NULL,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  submitted_at          timestamptz,
  validated_at          timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (invoice_id, business_id) REFERENCES invoices (id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers (id, business_id),
  FOREIGN KEY (wallet_id, business_id) REFERENCES treasury_wallets (id, business_id),
  CONSTRAINT payments_signed_needs_hash CHECK (
    status NOT IN ('submitted', 'pending_confirmation', 'validated') OR (tx_hash IS NOT NULL AND last_ledger_sequence IS NOT NULL)
  ),
  CONSTRAINT payments_blocked_needs_code CHECK (status <> 'blocked' OR failure_code IS NOT NULL),
  CONSTRAINT payments_blob_only_while_open CHECK (
    signed_blob IS NULL OR (status IN ('submitted', 'pending_confirmation') AND tx_hash IS NOT NULL)
  )
);
COMMENT ON TABLE payments IS 'Durable payment attempts (spec 5A). signed_blob is sensitive and is cleared on every final outcome.';

-- At most one active attempt per invoice (validated counts: a paid invoice cannot be paid again).
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_active_per_invoice
  ON payments (invoice_id)
  WHERE status IN ('requested', 'reserved', 'submitted', 'pending_confirmation', 'validated');
CREATE INDEX IF NOT EXISTS payments_status_updated_idx ON payments (status, updated_at);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (invoice_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS daily_spend_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  business_date date NOT NULL,
  payment_id    uuid NOT NULL UNIQUE,
  amount        numeric NOT NULL CHECK (amount > 0 AND scale(amount) <= 6 AND amount < 1000000000000),
  status        text NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payment_id, business_id) REFERENCES payments (id, business_id)
);
COMMENT ON TABLE daily_spend_reservations IS 'Daily-cap holds. Cap enforced by trigger so an application bug cannot overspend.';
CREATE INDEX IF NOT EXISTS reservations_day_idx ON daily_spend_reservations (business_id, business_date, status);

-- ---------------------------------------------------------------------------------------------------------------
-- Payment state machine
-- ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payments_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status NOT IN ('requested', 'blocked') THEN
    RAISE EXCEPTION 'payment may only be created as requested or blocked, not %', NEW.status USING ERRCODE = '55000';
  END IF;
  IF NEW.tx_hash IS NOT NULL OR NEW.signed_blob IS NOT NULL OR NEW.last_ledger_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'a new payment cannot carry signing data' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION payments_guard_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  legal text[] := ARRAY[
    'requested>blocked', 'requested>reserved', 'requested>cancelled',
    'reserved>submitted', 'reserved>cancelled',
    'submitted>validated', 'submitted>failed', 'submitted>pending_confirmation',
    'pending_confirmation>validated', 'pending_confirmation>failed'
  ];
BEGIN
  IF OLD.status IN ('blocked', 'validated', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'payment is in terminal status % and cannot be updated', OLD.status USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
     OR NEW.network IS DISTINCT FROM OLD.network
     OR NEW.asset_currency IS DISTINCT FROM OLD.asset_currency
     OR NEW.asset_issuer IS DISTINCT FROM OLD.asset_issuer
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.destination_address IS DISTINCT FROM OLD.destination_address
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.previous_payment_id IS DISTINCT FROM OLD.previous_payment_id
     OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.agent_reason IS DISTINCT FROM OLD.agent_reason
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'immutable payment column changed' USING ERRCODE = '55000';
  END IF;
  -- Write-once signing facts: once a hash exists it can never change or disappear.
  IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
    RAISE EXCEPTION 'tx_hash is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.last_ledger_sequence IS NOT NULL AND NEW.last_ledger_sequence IS DISTINCT FROM OLD.last_ledger_sequence THEN
    RAISE EXCEPTION 'last_ledger_sequence is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.first_ledger_sequence IS NOT NULL AND NEW.first_ledger_sequence IS DISTINCT FROM OLD.first_ledger_sequence THEN
    RAISE EXCEPTION 'first_ledger_sequence is write-once' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status || '>' || NEW.status) = ANY (legal)) THEN
    RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION payments_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'payments cannot be deleted' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION reservations_guard_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status IN ('committed', 'released') THEN
    RAISE EXCEPTION 'reservation is in terminal status % and cannot be updated', OLD.status USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'immutable reservation column changed' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status || '>' || NEW.status) = ANY (ARRAY['reserved>committed', 'reserved>released'])) THEN
    RAISE EXCEPTION 'illegal reservation transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Daily cap, enforced in the database: serialise on the business, then sum reserved+committed for the day.
CREATE OR REPLACE FUNCTION reservations_enforce_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  cap numeric;
  used numeric;
  pay_amount numeric;
BEGIN
  IF NEW.status <> 'reserved' THEN
    RAISE EXCEPTION 'a reservation must be created as reserved' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('policy:' || NEW.business_id::text, 0));
  SELECT p.amount INTO pay_amount FROM payments p WHERE p.id = NEW.payment_id AND p.business_id = NEW.business_id AND p.status = 'reserved';
  IF pay_amount IS NULL OR pay_amount <> NEW.amount THEN
    RAISE EXCEPTION 'reservation must match a reserved payment of the same amount' USING ERRCODE = '55000';
  END IF;
  SELECT tp.daily_spend_limit INTO cap FROM treasury_policies tp WHERE tp.business_id = NEW.business_id;
  IF cap IS NULL THEN
    RAISE EXCEPTION 'no treasury policy for business' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(sum(r.amount), 0) INTO used
    FROM daily_spend_reservations r
   WHERE r.business_id = NEW.business_id AND r.business_date = NEW.business_date AND r.status IN ('reserved', 'committed');
  IF used + NEW.amount > cap THEN
    RAISE EXCEPTION 'daily spend limit exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payments_guard_insert' AND tgrelid = 'payments'::regclass) THEN
    CREATE TRIGGER payments_guard_insert BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard_insert();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payments_guard_transition' AND tgrelid = 'payments'::regclass) THEN
    CREATE TRIGGER payments_guard_transition BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard_transition();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payments_no_delete' AND tgrelid = 'payments'::regclass) THEN
    CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_no_delete();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reservations_enforce_cap' AND tgrelid = 'daily_spend_reservations'::regclass) THEN
    CREATE TRIGGER reservations_enforce_cap BEFORE INSERT ON daily_spend_reservations FOR EACH ROW EXECUTE FUNCTION reservations_enforce_cap();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reservations_guard_transition' AND tgrelid = 'daily_spend_reservations'::regclass) THEN
    CREATE TRIGGER reservations_guard_transition BEFORE UPDATE ON daily_spend_reservations FOR EACH ROW EXECUTE FUNCTION reservations_guard_transition();
  END IF;
END
$$;
