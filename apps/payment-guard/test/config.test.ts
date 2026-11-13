import { describe, expect, it } from "vitest";
import { ConfigError, assertLeastPrivilegeRole, loadConfig } from "../src/config";
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
    expect(c).toMatchObject({ host: "127.0.0.1", port: 4002, staleReservationTimeoutSeconds: 300, balancePollIntervalSeconds: 30, reconcileIntervalSeconds: 15, rateLimitPerMinute: 30 });
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
    ["poll interval above bound", { BALANCE_POLL_INTERVAL_SECONDS: "601" }, "BALANCE_POLL_INTERVAL_SECONDS"],
    ["bad business id", { GUARD_BUSINESS_ID: "not-a-uuid" }, "GUARD_BUSINESS_ID"],
  ])("refuses %s", (_name, over, field) => {
    expect(fields(validEnv(over))).toContain(field);
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
