# Supabase runbook

Verified procedure for the owner's hosted Supabase project (migrations 0001 to 0011 applied there; 0009 to 0011 were applied with `pnpm db:migrate --allow-remote` after the first run. `pnpm db:supabase:verify` reports 4 failed checks after 0009 to 0011 (see "Open verify findings")). The sections after "Verified procedure" are the general reference. No secret appears in this file; real values live only in the gitignored `.env` and `.secrets/`.

## Verified procedure (run against the real project, session pooler)

Prerequisites: `.env` holds `DATABASE_URL` (admin, session pooler, user `postgres.<project-ref>`, port 5432). The Supabase root CA (public certificate) is saved at `.secrets/supabase-ca.crt` (downloaded from the project's Database settings; `/*.crt` in the repo root is gitignored so it cannot be committed by accident).

```bash
export DATABASE_SSL_CA_FILE="<absolute path>/.secrets/supabase-ca.crt"   # path only, not a secret
pnpm db:migrate status --allow-remote          # read-only; expect "applied: 0, pending: ..." on a fresh project
pnpm db:migrate --allow-remote                 # applies 0001..0008 once; a second run says "Nothing to apply"
pnpm db:supabase:roles                         # creates flow_guard and flow_web, random 48 char passwords -> .secrets/supabase-roles.env
pnpm db:supabase:verify                        # read-only checks, exits 1 on any failure
pnpm db:seed:demo -- --supabase                # demo business, suppliers, invoices, owner login -> .secrets/web-owner.supabase.env
pnpm guard:dev -- --supabase                   # guard as flow_guard, kill switch OFF, http://127.0.0.1:4002
pnpm dev:web -- --supabase                     # web as flow_web, http://127.0.0.1:3000
pnpm agent:run                                 # deterministic run; add -- --probe-ineligible to see the guard block a request
```

Findings from the real run:
- TLS: with `DATABASE_SSL_CA_FILE` the client connects with `rejectUnauthorized: true`, the CA from that file and `servername` equal to the host. The URL's `sslmode` is ignored, so it cannot weaken the check. A missing file, a non-PEM file, a file with a private key or an unparsable certificate is refused with a fixed message. Verification stays ON; there is no no-verify path.
- The Supabase admin (`postgres`) is not a superuser (it has CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS). `ALTER ROLE ... NOSUPERUSER` is rejected for it ("permission denied to alter role"), so migrations 0001 and 0006 no longer name NOSUPERUSER in their re-assert; they only run it when the role is somehow a superuser. The migration runner accepts the earlier checksums of those two files as already applied, so existing local databases keep working.
- Custom roles log in through the session pooler as `<role>.<project-ref>` (for example `flow_guard.<ref>`) with the password set by `ALTER ROLE`. Verified for both roles; `current_user` is the bare role name and neither is superuser or BYPASSRLS. Passwords are set server-side with `format('%L')` (never interpolated in JS) and stored only in `.secrets/supabase-roles.env`. Rotate with `pnpm db:supabase:roles -- --rotate`, then restart the guard and web.
- Privileges: RLS is enabled and forced on all 17 public tables. `anon`, `authenticated` and PUBLIC hold nothing on public tables, sequences or functions, and have no USAGE or CREATE on schema public (`has_table_privilege`, `has_function_privilege`, `has_schema_privilege`). Supabase's own default ACLs for `anon` and `authenticated` exist, but only for objects created by `supabase_admin` (and in the `storage` and `graphql` schemas); objects created by the migration role get none, so no extra migration was needed (no 0009).
- Denied writes (each inside a transaction that is rolled back): both app roles get SQLSTATE 42501 for DELETE and TRUNCATE on payments and audit_events, UPDATE on audit_events, writes to businesses and treasury_wallets; `flow_web` is also denied INSERT and UPDATE on payments and UPDATE of invoice amounts; `flow_guard` is denied writes to treasury_policies. `flow_web` sees zero tenant rows without `app.business_id`. The audit chain triggers (`audit_chain`, `audit_immutable`, `audit_no_truncate`), the chain functions and the key and check constraints exist.
- Smoke test (kill switch OFF): guard `/readyz` returned db ok, ledger ok, audit_chain ok. Web login through the real flow (Origin check, then a session cookie and CSRF token) returned 200; a wrong password 401; a foreign Origin 403; policy, overview and suppliers 200 (3 suppliers); logout without the CSRF token 403, with it 200, and the policy is 401 afterwards. `pnpm agent:run` ended with no payment, and `-- --probe-ineligible` ended `blocked` with `EXECUTION_DISABLED`. Nothing was sent to the ledger.


## Open verify findings (after 0009 to 0011 were applied)
`pnpm db:supabase:verify` passes the RLS check (18 of 18 tables), role attributes and the anon/authenticated table checks, and fails 4 checks:
- `anon`, `authenticated` and PUBLIC can EXECUTE one public function. It is the trigger function `treasury_wallet_signing_key_transition()` added by 0011, which has PostgreSQL's default PUBLIC EXECUTE. A trigger function is not callable as a plain function, so the exposure is low, but the check is strict. Fix: a later migration with `REVOKE ALL ON FUNCTION treasury_wallet_signing_key_transition() FROM PUBLIC`.
- `flow_web` holds one DELETE grant. It is the intended `DELETE ON login_attempts` of 0010 (limited by a row policy to windows older than one day). The check needs an allowance for that table.
Neither fix has been applied to the Supabase project; both need the owner's decision.

## 1. Create the project

- Create a project in the region closest to the guard host. Save the database password in your password manager, not in the repo.
- Note the three connection strings: direct (port 5432), session pooler (5432 on the pooler host) and transaction pooler (port 6543).

## 2. Which connection string for what

- Migrations and the guard's data path need session features (the guard holds a session-level `pg_advisory_lock` per wallet). The transaction-mode pooler on 6543 breaks that, so do not use it for either.
- Use the DIRECT string, or the SESSION pooler, for the guard and for migrations.
- TLS is required. Preferred: set `DATABASE_SSL_CA_FILE` to the Supabase root CA (verified TLS as described above). Without it, `sslmode=require` at minimum.
- `db.<ref>.supabase.co` (direct) may be IPv6 only. The session pooler (`aws-...pooler.supabase.com:5432`, user `<role>.<project-ref>`) works over IPv4 and supports the guard's session-level advisory locks.

## 3. Migrate

```bash
# Admin role (postgres) over the DIRECT string. Set it in your shell only, never in a file that is committed.
DATABASE_SSL_CA_FILE=<abs path to CA> DATABASE_URL='<direct or session pooler string>' pnpm db:migrate --allow-remote
DATABASE_SSL_CA_FILE=<abs path to CA> DATABASE_URL='<string>' pnpm db:migrate status --allow-remote
```

The tool refuses a non-local host without `--allow-remote` and without TLS, and never prints the string.

## 4. The `flow_guard` role

- Migration 0001 creates `flow_guard` with `LOGIN NOSUPERUSER NOBYPASSRLS`. It does not set a password.
- Set the password with `pnpm db:supabase:roles` (or out-of-band in the Supabase SQL editor: `ALTER ROLE flow_guard PASSWORD '<new random password>';`). Never put it in a migration file or a commit.
- Put `GUARD_DATABASE_URL` (user `flow_guard`) only in the guard's secret store. The agent has no database credential. The web app uses its own credentials, not the guard's.
- The guard refuses to start if its role is a superuser or has `BYPASSRLS`.

## 4a. The `flow_web` role (M4)
- Migration 0006 creates `flow_web` with `LOGIN NOSUPERUSER NOBYPASSRLS` and no password. It can read tenant tables only through RLS keyed on the transaction-local `app.business_id`, update only the policy and supplier flag columns, insert audit events, and has no DELETE or TRUNCATE.
- Set the password with `pnpm db:supabase:roles` (or out-of-band: `ALTER ROLE flow_web PASSWORD '<new random password>';`). Never put it in a migration file or a commit.
- Put `WEB_DATABASE_URL` (user `flow_web`) only in the web app's secret store. The web app must not receive `DATABASE_URL`, `GUARD_DATABASE_URL`, a signer seed or the Supabase service role key (it refuses to start if it does).
- Create the owner login and its `business_members` row with an admin connection (`pnpm db:seed:demo -- --supabase`). Rotate by `ALTER ROLE` plus updating the secret store.
## 5. Keys that must not be used by the guard

- Supabase `anon` and `authenticated` roles must have no grants on these tables. The guard never uses the anon or public key.
- `SUPABASE_SERVICE_ROLE_KEY` is not used by the guard and must not be set in its environment.

## 6. Checks after migrating (run as admin)

```sql
-- RLS enabled and forced on every table in public (expect no rows):
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

-- anon / authenticated table grants (expect no rows):
SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC');

-- guard role flags (expect rolsuper = false, rolbypassrls = false):
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'flow_guard';
```

Supabase may add default privileges for `anon` and `authenticated` on new tables. Migrations 0001 and 0005 revoke them; `pnpm db:supabase:verify` checks this (and much more) after every migration.

## 7. Operations

- Network restrictions: allow only the guard host's egress IP where the plan supports it.
- Backups: enable daily backups (point-in-time recovery if available). Test a restore into a scratch project before relying on it.
- Rotation: rotate the `flow_guard` password with `ALTER ROLE` and update the guard's secret store, then restart the guard. Rotate the agent token with `AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT`: deploy the new token to both, then retire the old one.
- Audit chain: run `SELECT verify_audit_chain('<business uuid>')` periodically; it must return true.
