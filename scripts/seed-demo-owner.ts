/**
 * Seeds the local demo business (if missing) and one owner login for the web app. Local Docker Postgres only.
 * Usage: pnpm db:seed:demo [-- --reset-password] [--balance <decimal>]
 *
 * - Connects as the local admin from .secrets/local-db.env and refuses any non-loopback host. No Testnet contact.
 * - Owner email: DEMO_OWNER_EMAIL (env or gitignored .env), default owner@demo.flow-ai.test.
 * - Owner password: DEMO_OWNER_PASSWORD (env), else DEMO_OWNER_PASSWORD in .secrets/web-owner.env, else a random one is
 *   generated into that file (mode 0600). The value is never printed; only the file path is.
 * - Idempotent: an existing login keeps its password unless --reset-password is given.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEMO_BUSINESS_NAME,
  LOCAL_DB,
  addBusinessMember,
  createCredential,
  createPool,
  findBusinessIdByName,
  findCredentialByEmail,
  hasBusinessMember,
  loadLocalDbSecrets,
  localAdminConfig,
  seedDemo,
  updatePasswordHash,
  withTransaction,
} from "../packages/database/src/index";
import { hashPassword, isAcceptablePassword } from "../apps/web/src/server/auth/password";
import { SECRETS_DIR, loadConfig, readPublicWallets, toErrorMessage } from "./lib/common";

const OWNER_FILE = path.join(SECRETS_DIR, "web-owner.env");
const DEFAULT_EMAIL = "owner@demo.flow-ai.test";
function isEmail(v: string): boolean {
  const at = v.indexOf("@");
  return v.length <= 254 && at > 0 && at === v.lastIndexOf("@") && !/\s/.test(v) && v.slice(at + 1).includes(".") && !v.endsWith(".");
}
/** Nominal RLUSD balance used to scale the demo fixture when the business does not exist yet (no network call is made). */
const DEFAULT_BALANCE = "10";
const BALANCE_RE = /^[0-9]{1,9}$|^[0-9]{1,9}\.[0-9]{1,6}$/;

interface Args {
  resetPassword: boolean;
  balance: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args = argv.filter((a) => a !== "--");
  let resetPassword = false;
  let balance = DEFAULT_BALANCE;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--reset-password") resetPassword = true;
    else if (a === "--balance") {
      const v = args[++i];
      if (v === undefined || !BALANCE_RE.test(v) || Number(v) <= 0) throw new Error("--balance needs a positive decimal such as 10");
      balance = v;
    } else throw new Error("Usage: db:seed:demo [--reset-password] [--balance <decimal>]");
  }
  return { resetPassword, balance };
}

/** Reads KEY=value lines from the owner file. Values are returned to the caller only; never printed. */
function readOwnerFile(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(OWNER_FILE)) return out;
  for (const line of readFileSync(OWNER_FILE, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2]);
  }
  return out;
}

function writeOwnerFile(email: string, password: string): void {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(OWNER_FILE, `DEMO_OWNER_EMAIL=${email}\nDEMO_OWNER_PASSWORD=${password}\n`, { mode: 0o600 });
  try {
    chmodSync(OWNER_FILE, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

interface OwnerLogin {
  email: string;
  password: string;
  generated: boolean;
}

function resolveOwner(forceNew: boolean): OwnerLogin {
  const file = readOwnerFile();
  const email = (process.env.DEMO_OWNER_EMAIL || file.get("DEMO_OWNER_EMAIL") || DEFAULT_EMAIL).trim().toLowerCase();
  if (!isEmail(email)) throw new Error("DEMO_OWNER_EMAIL is not a valid email address.");
  const fromEnv = process.env.DEMO_OWNER_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isAcceptablePassword(fromEnv)) throw new Error("DEMO_OWNER_PASSWORD must be 12 to 256 characters.");
    return { email, password: fromEnv, generated: false };
  }
  const fromFile = file.get("DEMO_OWNER_PASSWORD");
  if (fromFile !== undefined && !forceNew) {
    if (!isAcceptablePassword(fromFile)) throw new Error(`DEMO_OWNER_PASSWORD in ${OWNER_FILE} must be 12 to 256 characters.`);
    return { email, password: fromFile, generated: false };
  }
  return { email, password: randomBytes(24).toString("base64url"), generated: true };
}

async function main(): Promise<void> {
  const { resetPassword, balance } = parseArgs(process.argv.slice(2));
  const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
  if (secrets === null) throw new Error("No local database set up. Run: pnpm db:up && pnpm db:migrate");
  const config = localAdminConfig(secrets);
  if (config.host !== LOCAL_DB.host) throw new Error("Refusing: the demo seed only runs against the loopback database.");
  const pool = createPool({ config: { host: config.host, port: config.port, user: config.user, password: config.password, database: config.database }, max: 2, applicationName: "flow-ai-seed" });
  try {
    let businessId = (await findBusinessIdByName(pool, DEMO_BUSINESS_NAME)) ?? undefined;
    let businessCreated = false;
    if (businessId === undefined) {
      const cfg = loadConfig();
      const wallets = readPublicWallets();
      const find = (pred: (w: ReturnType<typeof readPublicWallets>[number]) => boolean, what: string): string => {
        const w = wallets.find(pred);
        if (!w) throw new Error(`No ${what} wallet in the secrets file.`);
        return w.address;
      };
      const seeded = await seedDemo(pool, {
        treasuryAddress: find((w) => w.role === "treasury", "treasury"),
        issuer: cfg.issuer,
        currencyHex: cfg.currencyHex,
        balance,
        supplierA: find((w) => w.kind === "cross-border", "cross-border supplier"),
        supplierB: find((w) => w.kind === "extra", "extra supplier"),
        supplierC: find((w) => w.kind === "domestic", "domestic supplier"),
      });
      businessId = seeded.business_id;
      businessCreated = seeded.created;
    }

    const existing = await findCredentialByEmail(pool, resolveOwner(false).email);
    let credentialCreated = false;
    let passwordChanged = false;
    let generated = false;
    let userId: string;
    if (existing === null) {
      const owner = resolveOwner(false);
      const hash = await hashPassword(owner.password);
      userId = (await createCredential(pool, { email: owner.email, password_hash: hash })).user_id;
      credentialCreated = true;
      passwordChanged = true;
      generated = owner.generated;
      if (owner.generated) writeOwnerFile(owner.email, owner.password);
    } else {
      userId = existing.user_id;
      if (resetPassword) {
        const owner = resolveOwner(true);
        await updatePasswordHash(pool, userId, await hashPassword(owner.password));
        passwordChanged = true;
        generated = owner.generated;
        if (owner.generated) writeOwnerFile(owner.email, owner.password);
      }
    }

    let memberCreated = false;
    if (!(await hasBusinessMember(pool, businessId, userId))) {
      await withTransaction(pool, (c) => addBusinessMember(c, { business_id: businessId, user_id: userId, role: "owner" }));
      memberCreated = true;
    }

    const changed = businessCreated || credentialCreated || passwordChanged || memberCreated;
    console.log(changed ? "Demo owner seed applied." : "Nothing to do: demo business and owner login already exist (no-op).");
    console.log(`  business: ${businessCreated ? "created" : "exists"}; owner login: ${credentialCreated ? "created" : "exists"}; membership: ${memberCreated ? "created" : "exists"}; password: ${passwordChanged ? "set" : "unchanged"}`);
    if (generated) console.log(`A random owner password was written to ${OWNER_FILE} (gitignored, not printed). Email: ${resolveOwner(false).email}`);
    else if (credentialCreated || passwordChanged) console.log("Owner password taken from DEMO_OWNER_PASSWORD (not printed).");
    else console.log(`Sign in with the owner email and the password from DEMO_OWNER_PASSWORD or ${OWNER_FILE}.`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(`db:seed:demo failed: ${toErrorMessage(err)}`);
  process.exitCode = 1;
});
