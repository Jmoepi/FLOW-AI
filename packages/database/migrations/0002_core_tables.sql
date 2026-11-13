-- 0002: core tables (spec 8.1). Idempotent.
-- Money: unconstrained numeric with CHECKs (NOT numeric(18,6), which would silently round over-precise input).
-- NaN fails the upper bound (NaN sorts above every number), negatives and >6 decimals fail explicitly.

CREATE TABLE IF NOT EXISTS businesses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  country_code text NOT NULL DEFAULT 'ZA' CHECK (country_code ~ '^[A-Z]{2}$'),
  timezone     text NOT NULL DEFAULT 'Africa/Johannesburg' CHECK (length(timezone) BETWEEN 1 AND 64),
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE businesses IS 'Tenant. timezone is the single source of timezone (spec 8.1). RLS forced; guard read-only.';

CREATE TABLE IF NOT EXISTS business_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);
COMMENT ON TABLE business_members IS 'Web-app membership. The payment guard has no access (separation of duties, 13.1B).';

CREATE TABLE IF NOT EXISTS treasury_wallets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id),
  network          text NOT NULL CHECK (network = 'xrpl-testnet'),
  address          text NOT NULL CHECK (address ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
  asset_currency   text NOT NULL DEFAULT 'RLUSD' CHECK (length(asset_currency) BETWEEN 1 AND 40),
  asset_issuer     text NOT NULL CHECK (asset_issuer ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
  signing_key_mode text NOT NULL DEFAULT 'master_env' CHECK (signing_key_mode IN ('master_env', 'regular_key', 'revoked')),
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  UNIQUE (business_id, address)
);
COMMENT ON TABLE treasury_wallets IS 'Public wallet addresses only. The seed is never stored here.';

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     uuid NOT NULL REFERENCES treasury_wallets(id),
  rlusd_balance numeric CHECK (rlusd_balance IS NULL OR (rlusd_balance >= 0 AND scale(rlusd_balance) <= 6 AND rlusd_balance < 1000000000000)),
  xrp_balance   numeric NOT NULL CHECK (xrp_balance >= 0 AND scale(xrp_balance) <= 6 AND xrp_balance < 1000000000000),
  as_of         timestamptz NOT NULL DEFAULT now(),
  ledger_index  integer CHECK (ledger_index IS NULL OR ledger_index >= 0)
);
COMMENT ON TABLE balance_snapshots IS 'Written by the guard poller. Informational; the guard re-queries live at decision time.';
CREATE INDEX IF NOT EXISTS balance_snapshots_wallet_as_of_idx ON balance_snapshots (wallet_id, as_of DESC);

CREATE TABLE IF NOT EXISTS suppliers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  xrpl_address text NOT NULL CHECK (xrpl_address ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  is_approved  boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
COMMENT ON TABLE suppliers IS 'is_approved and is_active are the single sources of approval and active status (spec 8.1).';

CREATE TABLE IF NOT EXISTS invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id),
  supplier_id    uuid NOT NULL,
  invoice_number text NOT NULL CHECK (length(invoice_number) BETWEEN 1 AND 64),
  description    text CHECK (description IS NULL OR length(description) <= 2000),
  amount         numeric NOT NULL CHECK (amount > 0 AND scale(amount) <= 6 AND amount < 1000000000000),
  currency       text NOT NULL DEFAULT 'RLUSD' CHECK (length(currency) BETWEEN 1 AND 40),
  issue_date     date NOT NULL,
  due_date       date NOT NULL,
  priority       integer,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'processing', 'paid', 'blocked', 'cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  UNIQUE (business_id, invoice_number),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers (id, business_id)
);
COMMENT ON TABLE invoices IS 'description is untrusted text: stored and displayed as data, never interpolated (13.1A).';

CREATE TABLE IF NOT EXISTS treasury_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL UNIQUE REFERENCES businesses(id),
  enabled            boolean NOT NULL DEFAULT false,
  max_payment_amount numeric NOT NULL CHECK (max_payment_amount >= 0 AND scale(max_payment_amount) <= 6 AND max_payment_amount < 1000000000000),
  daily_spend_limit  numeric NOT NULL CHECK (daily_spend_limit >= 0 AND scale(daily_spend_limit) <= 6 AND daily_spend_limit < 1000000000000),
  minimum_reserve    numeric NOT NULL CHECK (minimum_reserve >= 0 AND scale(minimum_reserve) <= 6 AND minimum_reserve < 1000000000000),
  allowed_assets     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_assets) = 'array'),
  valid_until        timestamptz,
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 0),
  updated_by         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE treasury_policies IS 'Owner-controlled rules. The guard may read but never write.';

CREATE TABLE IF NOT EXISTS agent_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL REFERENCES businesses(id),
  status               text NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
  trigger              text NOT NULL CHECK (trigger IN ('manual', 'interval')),
  mode                 text NOT NULL CHECK (mode IN ('llm', 'deterministic')),
  started_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  summary              text CHECK (summary IS NULL OR length(summary) <= 4000),
  tool_call_count      integer NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  candidate_invoice_id uuid REFERENCES invoices(id)
);
COMMENT ON TABLE agent_runs IS 'Agent bookkeeping. The payment guard has no access.';
