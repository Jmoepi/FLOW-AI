-- 0004: append-only, hash-chained audit log. Idempotent.
-- The chain (seq, prev_hash, row_hash) is computed by a BEFORE INSERT trigger under a per-business advisory lock, so
-- the application cannot forge or reorder it. Any role, including the owner, is blocked from UPDATE/DELETE/TRUNCATE.

CREATE TABLE IF NOT EXISTS audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  seq         bigint NOT NULL,
  prev_hash   text NOT NULL,
  row_hash    text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('human', 'agent', 'policy_service', 'system')),
  actor_id    text CHECK (actor_id IS NULL OR length(actor_id) <= 128),
  event_type  text NOT NULL CHECK (event_type ~ '^[a-z0-9_.]{1,64}$'),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z0-9_]{1,64}$'),
  entity_id   text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 128),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 16384),
  request_id  text CHECK (request_id IS NULL OR length(request_id) <= 128),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id, seq)
);
COMMENT ON TABLE audit_events IS 'Append-only, hash-chained. metadata must never hold secrets, seeds, tokens or signed blobs.';
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at);

CREATE OR REPLACE FUNCTION audit_row_hash(
  p_prev text, p_seq bigint, p_business uuid, p_actor_type text, p_actor_id text, p_event_type text,
  p_entity_type text, p_entity_id text, p_metadata jsonb, p_request_id text, p_created_at timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(
    p_prev || '|' || p_seq::text || '|' || p_business::text || '|' || p_actor_type || '|' || COALESCE(p_actor_id, '') || '|' ||
    p_event_type || '|' || p_entity_type || '|' || p_entity_id || '|' || p_metadata::text || '|' || COALESCE(p_request_id, '') || '|' ||
    to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.business_id::text, 0));
  SELECT a.seq, a.row_hash INTO last_seq, last_hash
    FROM audit_events a WHERE a.business_id = NEW.business_id ORDER BY a.seq DESC LIMIT 1;
  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.created_at := clock_timestamp();
  NEW.row_hash := audit_row_hash(NEW.prev_hash, NEW.seq, NEW.business_id, NEW.actor_type, NEW.actor_id, NEW.event_type,
                                 NEW.entity_type, NEW.entity_id, NEW.metadata, NEW.request_id, NEW.created_at);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '55000';
END
$$;

-- Returns true when every row of the business chain recomputes correctly and seq has no gaps.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_business uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  rec audit_events%ROWTYPE;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
BEGIN
  FOR rec IN SELECT * FROM audit_events WHERE business_id = p_business ORDER BY seq LOOP
    IF rec.seq <> expected_seq OR rec.prev_hash <> expected_prev THEN
      RETURN false;
    END IF;
    IF rec.row_hash <> audit_row_hash(rec.prev_hash, rec.seq, rec.business_id, rec.actor_type, rec.actor_id, rec.event_type,
                                      rec.entity_type, rec.entity_id, rec.metadata, rec.request_id, rec.created_at) THEN
      RETURN false;
    END IF;
    expected_prev := rec.row_hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN true;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_chain' AND tgrelid = 'audit_events'::regclass) THEN
    CREATE TRIGGER audit_chain BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_chain();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_immutable' AND tgrelid = 'audit_events'::regclass) THEN
    CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_no_truncate' AND tgrelid = 'audit_events'::regclass) THEN
    CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();
  END IF;
END
$$;
