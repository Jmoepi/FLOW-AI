# Supabase runbook (for later; nothing here was run in M3)

M3 used a local Docker Postgres only. Follow this when moving the payment guard's database to Supabase. No project has been created.

## 1. Create the project

- Create a project in the region closest to the guard host. Save the database password in your password manager, not in the repo.
- Note the three connection strings: direct (port 5432), session pooler (5432 on the pooler host) and transaction pooler (port 6543).

## 2. Which connection string for what

- Migrations and the guard's data path need session features (the guard holds a session-level `pg_advisory_lock` per wallet). The transaction-mode pooler on 6543 breaks that, so do not use it for either.
- Use the DIRECT string, or the SESSION pooler, for the guard and for migrations.
- TLS is required: `sslmode=require` at minimum, `sslmode=verify-full` with the Supabase CA certificate preferred.

## 3. Migrate

```bash
# Admin role (postgres) over the DIRECT string. Set it in your shell only, never in a file that is committed.
DATABASE_URL='<direct string>' pnpm db:migrate --allow-remote
DATABASE_URL='<direct string>' pnpm db:migrate status --allow-remote
```

The tool refuses a non-local host without `--allow-remote` and without TLS, and never prints the string.

## 4. The `flow_guard` role

- Migration 0001 creates `flow_guard` with `LOGIN NOSUPERUSER NOBYPASSRLS`. It does not set a password.
- Set the password out-of-band, once, in the Supabase SQL editor: `ALTER ROLE flow_guard PASSWORD '<new random password>';`. Never put it in a migration file or a commit.
- Put `GUARD_DATABASE_URL` (user `flow_guard`) only in the guard's secret store. The agent has no database credential. The web app uses its own credentials, not the guard's.
- The guard refuses to start if its role is a superuser or has `BYPASSRLS`.

## 4a. The `flow_web` role (M4)
- Migration 0006 creates `flow_web` with `LOGIN NOSUPERUSER NOBYPASSRLS` and no password. It can read tenant tables only through RLS keyed on the transaction-local `app.business_id`, update only the policy and supplier flag columns, insert audit events, and has no DELETE or TRUNCATE.
- Set the password out-of-band, once, in the Supabase SQL editor: `ALTER ROLE flow_web PASSWORD '<new random password>';`. Never put it in a migration file or a commit.
- Put `WEB_DATABASE_URL` (user `flow_web`) only in the web app's secret store. The web app must not receive `DATABASE_URL`, `GUARD_DATABASE_URL`, a signer seed or the Supabase service role key (it refuses to start if it does).
- Create the owner login and its `business_members` row with an admin connection (the `pnpm db:seed:demo` script is local only). Rotate by `ALTER ROLE` plus updating the secret store.
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

Supabase may add default privileges for `anon` and `authenticated` on new tables. Migrations 0001 and 0005 revoke them; confirm with the second query above after every migration.

## 7. Operations

- Network restrictions: allow only the guard host's egress IP where the plan supports it.
- Backups: enable daily backups (point-in-time recovery if available). Test a restore into a scratch project before relying on it.
- Rotation: rotate the `flow_guard` password with `ALTER ROLE` and update the guard's secret store, then restart the guard. Rotate the agent token with `AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT`: deploy the new token to both, then retire the old one.
- Audit chain: run `SELECT verify_audit_chain('<business uuid>')` periodically; it must return true.
