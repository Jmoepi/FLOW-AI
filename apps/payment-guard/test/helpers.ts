import { randomBytes } from "node:crypto";
import type { GuardLedgerGateway } from "@flow-ai/xrpl-adapter";
import type { Pool } from "@flow-ai/database";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
/** Fake secrets are built at runtime, never written in source. */
export const TOKEN = randomBytes(24).toString("hex");
export const TOKEN_NEXT = randomBytes(24).toString("hex");
export function validEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    XRPL_NETWORK: "xrpl-testnet",
    XRPL_WS_URL: "wss://s.altnet.rippletest.net:51233",
    RLUSD_ISSUER: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
    RLUSD_CURRENCY_HEX: "524C555344000000000000000000000000000000",
    GUARD_DATABASE_URL: "postgres://flow_guard:placeholder@127.0.0.1:54329/flow",
    AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN,
    ...over,
  };
}
export const deadPool = { query: () => Promise.reject(new Error("db down")), connect: () => Promise.reject(new Error("db down")) } as unknown as Pool;
const gateway = { getNetworkInfo: () => Promise.reject(new Error("ledger down")) } as unknown as GuardLedgerGateway;
export async function makeApp(env: Record<string, string | undefined> = {}, lines: string[] = []) {
  return buildApp({ pool: deadPool, gateway, config: loadConfig(validEnv(env)), env: () => ({ PAYMENT_EXECUTION_ENABLED: "false" }), logger: createLogger((l) => lines.push(l)) });
}
export const bearer = (t: string = TOKEN) => ({ authorization: `Bearer ${t}` });
