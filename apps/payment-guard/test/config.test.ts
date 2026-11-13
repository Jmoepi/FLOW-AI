import { describe, expect, it } from "vitest";
import { AGENT_PAYMENT_WAIT_SECONDS, AGENT_RUN_STALE_MIN_SECONDS, ConfigError, assertLeastPrivilegeRole, loadConfig } from "../src/config";
import { TOKEN, TOKEN_NEXT, validEnv } from "./helpers";
const fields = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return [...e.fields];
    throw e;
  }
  return [];
};
describe("loadConfig fails closed", () => {
  it("accepts a valid environment and applies defaults", () => {
    const c = loadConfig(validEnv());
    expect(c).toMatchObject({ host: "127.0.0.1", port: 4002, staleReservationTimeoutSeconds: 300, agentRunStaleSeconds: 180, balancePollIntervalSeconds: 30, reconcileIntervalSeconds: 15, rateLimitPerMinute: 30 });
    expect(c.tokens).toEqual([TOKEN]);
  });
  it("does not parse the kill switch or read the signer seed", () => {
    const c = loadConfig(validEnv({ PAYMENT_EXECUTION_ENABLED: "garbage", XRPL_DEMO_SIGNER_SEED: "x" }));
    expect(JSON.stringify(c)).not.toMatch(/EXECUTION|SEED/i);
  });
  it.each([
    ["non-testnet network", { XRPL_NETWORK: "xrpl-mainnet" }, "XRPL_NETWORK"],
    ["missing network", { XRPL_NETWORK: undefined }, "XRPL_NETWORK"],
    ["mainnet websocket", { XRPL_WS_URL: "wss://xrplcluster.com" }, "XRPL_WS_URL"],
    ["websocket with userinfo", { XRPL_WS_URL: "wss://u:p@s.altnet.rippletest.net:51233" }, "XRPL_WS_URL"],
    ["mainnet issuer", { RLUSD_ISSUER: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" }, "RLUSD_ISSUER"],
    ["bad currency hex", { RLUSD_CURRENCY_HEX: "RLUSD" }, "RLUSD_CURRENCY_HEX"],
    ["short token", { AGENT_TO_PAYMENT_GUARD_TOKEN: "short-token" }, "AGENT_TO_PAYMENT_GUARD_TOKEN"],
    ["missing token", { AGENT_TO_PAYMENT_GUARD_TOKEN: undefined }, "AGENT_TO_PAYMENT_GUARD_TOKEN"],
    ["short next token", { AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT: "short" }, "AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT"],
    ["next equals current", { AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT: TOKEN }, "AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT"],
    ["missing database url", { GUARD_DATABASE_URL: undefined }, "GUARD_DATABASE_URL"],
    ["non-postgres database url", { GUARD_DATABASE_URL: "mysql://x" }, "GUARD_DATABASE_URL"],
    ["bad port", { GUARD_PORT: "70000" }, "GUARD_PORT"],
    ["non-numeric port", { GUARD_PORT: "80a" }, "GUARD_PORT"],
    ["stale timeout below bound", { STALE_RESERVATION_TIMEOUT_SECONDS: "5" }, "STALE_RESERVATION_TIMEOUT_SECONDS"],
    ["agent run stale timeout below bound", { AGENT_RUN_STALE_SECONDS: "5" }, "AGENT_RUN_STALE_SECONDS"],
    ["agent run stale timeout at the payment wait (55 s)", { AGENT_RUN_STALE_SECONDS: "55" }, "AGENT_RUN_STALE_SECONDS"],
    ["agent run stale timeout just under the 120 s floor", { AGENT_RUN_STALE_SECONDS: "119" }, "AGENT_RUN_STALE_SECONDS"],
    ["poll interval above bound", { BALANCE_POLL_INTERVAL_SECONDS: "601" }, "BALANCE_POLL_INTERVAL_SECONDS"],
    ["bad business id", { GUARD_BUSINESS_ID: "not-a-uuid" }, "GUARD_BUSINESS_ID"],
  ])("refuses %s", (_name, over, field) => {
    expect(fields(validEnv(over))).toContain(field);
  });
  it("keeps the agent run stale floor strictly above the 55 s payment wait plus margin", () => {
    expect(AGENT_RUN_STALE_MIN_SECONDS).toBeGreaterThanOrEqual(AGENT_PAYMENT_WAIT_SECONDS + 60);
    expect(loadConfig(validEnv({ AGENT_RUN_STALE_SECONDS: String(AGENT_RUN_STALE_MIN_SECONDS) })).agentRunStaleSeconds).toBe(120);
    expect(loadConfig(validEnv({})).agentRunStaleSeconds).toBe(180);
  });
  it("accepts a rotation token and a pinned business", () => {
    const c = loadConfig(validEnv({ AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT: TOKEN_NEXT, GUARD_BUSINESS_ID: "3F2B8C1E-5D4A-4B6F-9A7E-1C2D3E4F5A6B" }));
    expect(c.tokens).toEqual([TOKEN, TOKEN_NEXT]);
    expect(c.businessId).toBe("3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b");
  });
  it("never puts a value in the error message", () => {
    let message = "";
    try {
      loadConfig(validEnv({ AGENT_TO_PAYMENT_GUARD_TOKEN: "short", GUARD_DATABASE_URL: "mysql://user:hunter2pass@host/db" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("GUARD_DATABASE_URL");
    expect(message).not.toMatch(/hunter2|short|mysql/);
  });
});
describe("assertLeastPrivilegeRole", () => {
  it("refuses superuser and BYPASSRLS roles", () => {
    expect(() => assertLeastPrivilegeRole({ rolsuper: true, rolbypassrls: false })).toThrow(/superuser/);
    expect(() => assertLeastPrivilegeRole({ rolsuper: false, rolbypassrls: true })).toThrow(/BYPASSRLS/);
    expect(() => assertLeastPrivilegeRole({ rolsuper: false, rolbypassrls: false })).not.toThrow();
  });
});
describe("GUARD_BUSINESS_ID tenant pin (M-2)", () => {
  const ID = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
  it("is optional in local and test use", () => {
    expect(fields(validEnv())).toEqual([]);
    expect(fields(validEnv({ NODE_ENV: "test" }))).toEqual([]);
    expect(fields(validEnv({ NODE_ENV: "development", GUARD_HOST: "localhost" }))).toEqual([]);
    expect(fields(validEnv({ GUARD_HOST: "::1" }))).toEqual([]);
  });
  it("is required when NODE_ENV=production, failing closed with the variable name only", () => {
    expect(fields(validEnv({ NODE_ENV: "production" }))).toEqual(["GUARD_BUSINESS_ID"]);
    expect(fields(validEnv({ NODE_ENV: "production", GUARD_BUSINESS_ID: "" }))).toEqual(["GUARD_BUSINESS_ID"]);
    expect(loadConfig(validEnv({ NODE_ENV: "production", GUARD_BUSINESS_ID: ID })).businessId).toBe(ID);
  });
  it("is required for a non-loopback bind (a deployment)", () => {
    for (const host of ["0.0.0.0", "10.0.0.5", "guard.internal"]) expect(fields(validEnv({ GUARD_HOST: host }))).toEqual(["GUARD_BUSINESS_ID"]);
    expect(fields(validEnv({ GUARD_HOST: "0.0.0.0", GUARD_BUSINESS_ID: ID }))).toEqual([]);
  });
  it("still rejects a malformed id in production", () => {
    expect(fields(validEnv({ NODE_ENV: "production", GUARD_BUSINESS_ID: "not-a-uuid" }))).toEqual(["GUARD_BUSINESS_ID"]);
  });
});
describe("AUDIT_VERIFY_INTERVAL_SECONDS", () => {
  it("defaults to 300 and is bounded", () => {
    expect(loadConfig(validEnv()).auditVerifyIntervalSeconds).toBe(300);
    expect(loadConfig(validEnv({ AUDIT_VERIFY_INTERVAL_SECONDS: "60" })).auditVerifyIntervalSeconds).toBe(60);
    expect(fields(validEnv({ AUDIT_VERIFY_INTERVAL_SECONDS: "1" }))).toEqual(["AUDIT_VERIFY_INTERVAL_SECONDS"]);
    expect(fields(validEnv({ AUDIT_VERIFY_INTERVAL_SECONDS: "abc" }))).toEqual(["AUDIT_VERIFY_INTERVAL_SECONDS"]);
  });
});
