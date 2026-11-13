/**
 * Dev launcher for the payment guard. The signer seed is read from .secrets inside this process, placed in the CHILD's
 * environment in memory, and never printed, logged, written to disk or put on argv. The agent bearer token is random
 * per launch and lives in memory only. Spawned with an argument array and no shell.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ROOT, loadConfig, loadGuardSignerSeed } from "./common";

export interface GuardLaunchOptions {
  /** Connection string for the flow_guard role. Passed to the child via env only. */
  databaseUrl: string;
  businessId?: string;
  port: number;
  treasuryLabel: string;
  /** Kill switch value for the child. Defaults to true (m3-e2e); pass false for a smoke test that must not pay. */
  executionEnabled?: boolean;
  /** Fixed bearer token (dev only, read from a gitignored file). Random per launch when omitted. */
  token?: string;
}

export interface GuardHandle {
  port: number;
  /** In-memory bearer token for the internal API. Never print it. */
  token: string;
  child: ChildProcess;
  exited: () => boolean;
  stop: () => Promise<void>;
}

/** Only what node and tsx need to run. Nothing else from the parent environment reaches the guard (13.1B least privilege). */
const ENV_ALLOWLIST = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "OS", "LANG"] as const;
export function baseGuardEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) if (parent[k] !== undefined) env[k] = parent[k];
  // Path to the public CA certificate for a remote database (not a secret); the child verifies TLS against it.
  if (parent.DATABASE_SSL_CA_FILE !== undefined && parent.DATABASE_SSL_CA_FILE !== "") env.DATABASE_SSL_CA_FILE = parent.DATABASE_SSL_CA_FILE;
  return env;
}
/** Pure: the kill switch is "true" unless the caller passes executionEnabled: false. */
export function killSwitchValue(opts: Pick<GuardLaunchOptions, "executionEnabled">): "true" | "false" {
  return opts.executionEnabled === false ? "false" : "true";
}
export function startGuard(opts: GuardLaunchOptions): GuardHandle {
  const cfg = loadConfig(); // fails closed unless Testnet
  const token = opts.token ?? randomBytes(32).toString("hex");
  // Allowlist, not a copy of process.env: the guard never sees an admin database credential, a Supabase service key or a provider key.
  const env = baseGuardEnv(process.env);
  Object.assign(env, {
    XRPL_NETWORK: cfg.network,
    XRPL_WS_URL: cfg.wsUrl,
    RLUSD_ISSUER: cfg.issuer,
    RLUSD_CURRENCY_HEX: cfg.currencyHex,
    GUARD_DATABASE_URL: opts.databaseUrl,
    AGENT_TO_PAYMENT_GUARD_TOKEN: token,
    GUARD_PORT: String(opts.port),
    GUARD_HOST: "127.0.0.1",
    PAYMENT_EXECUTION_ENABLED: killSwitchValue(opts),
    XRPL_DEMO_SIGNER_SEED: loadGuardSignerSeed(opts.treasuryLabel),
  });
  if (opts.businessId !== undefined) env.GUARD_BUSINESS_ID = opts.businessId;
  const child = spawn(process.execPath, ["--import", "tsx", path.join("apps", "payment-guard", "src", "main.ts")], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    shell: false,
  });
  let done = false;
  const finished = new Promise<void>((resolve) => {
    child.once("exit", () => {
      done = true;
      resolve();
    });
    child.once("error", () => {
      done = true;
      resolve();
    });
  });
  return {
    port: opts.port,
    token,
    child,
    exited: () => done,
    stop: async () => {
      if (!done) child.kill("SIGTERM");
      await Promise.race([finished, new Promise((r) => setTimeout(r, 10_000))]);
      if (!done) child.kill("SIGKILL");
    },
  };
}

/** Polls /readyz until 200 or the deadline passes. */
export async function waitReady(handle: GuardHandle, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.exited()) throw new Error("The guard process exited before it became ready.");
    try {
      const res = await fetch(`http://127.0.0.1:${String(handle.port)}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The guard did not become ready in time.");
}
