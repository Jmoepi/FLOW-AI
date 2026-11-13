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
}

export interface GuardHandle {
  port: number;
  /** In-memory bearer token for the internal API. Never print it. */
  token: string;
  child: ChildProcess;
  exited: () => boolean;
  stop: () => Promise<void>;
}

export function startGuard(opts: GuardLaunchOptions): GuardHandle {
  const cfg = loadConfig(); // fails closed unless Testnet
  const token = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The guard must never see an admin database credential or a Supabase service key.
  delete env.DATABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  Object.assign(env, {
    XRPL_NETWORK: cfg.network,
    XRPL_WS_URL: cfg.wsUrl,
    RLUSD_ISSUER: cfg.issuer,
    RLUSD_CURRENCY_HEX: cfg.currencyHex,
    GUARD_DATABASE_URL: opts.databaseUrl,
    AGENT_TO_PAYMENT_GUARD_TOKEN: token,
    GUARD_PORT: String(opts.port),
    GUARD_HOST: "127.0.0.1",
    PAYMENT_EXECUTION_ENABLED: "true",
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
