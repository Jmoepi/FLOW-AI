/**
 * Dev launcher for the owner web app. WEB_DATABASE_URL (flow_web) is assembled in memory from .secrets and placed in the
 * CHILD's environment only. The child gets an allowlisted environment: no signer seed, no guard token, no admin password,
 * no DATABASE_URL. Spawned with an argument array and no shell. Never prints the connection string.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { ROOT, loadConfig } from "./common";
import { baseGuardEnv } from "./guard-launcher";

export interface WebLaunchOptions {
  /** Connection string for the flow_web role. Passed to the child via env only. */
  databaseUrl: string;
  port: number;
}

export interface WebHandle {
  child: ChildProcess;
  stop: () => void;
}

export function startWeb(opts: WebLaunchOptions): WebHandle {
  const cfg = loadConfig(); // fails closed unless Testnet
  const env = baseGuardEnv(process.env);
  Object.assign(env, {
    NODE_ENV: "development",
    WEB_DATABASE_URL: opts.databaseUrl,
    APP_BASE_URL: `http://127.0.0.1:${String(opts.port)}`,
    RLUSD_ISSUER: cfg.issuer,
    RLUSD_CURRENCY_HEX: cfg.currencyHex,
  });
  for (const k of ["SESSION_IDLE_SECONDS", "SESSION_ABSOLUTE_SECONDS", "STEP_UP_SECONDS"] as const) {
    const v = process.env[k];
    if (v !== undefined && v !== "") env[k] = v;
  }
  const nextBin = path.join(ROOT, "apps", "web", "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(opts.port)], {
    cwd: path.join(ROOT, "apps", "web"),
    env,
    stdio: "inherit",
    shell: false,
  });
  return { child, stop: () => void child.kill("SIGTERM") };
}
