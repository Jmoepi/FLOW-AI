import { describe, expect, it } from "vitest";
import { MAINNET_RLUSD_ISSUER as ADAPTER_MAINNET } from "../../../packages/xrpl-adapter/src/index";
import { MAINNET_RLUSD_ISSUER, WebConfigError, assertLeastPrivilegeRole, forbiddenEnvNames, loadWebConfig } from "../src/server/config";
import { ISSUER, validEnv } from "./helpers";
const fieldsOf = (env: NodeJS.ProcessEnv): readonly string[] => {
  try {
    loadWebConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(WebConfigError);
    return (e as WebConfigError).fields;
  }
  return [];
};
describe("loadWebConfig", () => {
  it("accepts a valid environment and applies defaults", () => {
    const c = loadWebConfig(validEnv());
    expect(c.appOrigin).toBe("http://127.0.0.1:3000");
    expect(c.sessionIdleSeconds).toBe(1800);
    expect(c.sessionAbsoluteSeconds).toBe(28_800);
    expect(c.stepUpSeconds).toBe(900);
    expect(c.cookieSecure).toBe(false);
    expect(c.trustedProxyHops).toBe(0);
  });
  it("fails closed on each missing required variable, naming only the variable", () => {
    for (const name of ["WEB_DATABASE_URL", "APP_BASE_URL", "RLUSD_ISSUER", "RLUSD_CURRENCY_HEX"]) {
      expect(fieldsOf(validEnv({ [name]: undefined })), name).toContain(name);
      expect(fieldsOf(validEnv({ [name]: "" })), name).toContain(name);
    }
  });
  it("never puts a value in the error message", () => {
    const secret = "postgres://flow_web:hunter2hunter2@db.example.com/x";
    try {
      loadWebConfig(validEnv({ WEB_DATABASE_URL: secret, APP_BASE_URL: "ftp://x" }));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
      expect((e as Error).message).not.toContain("db.example.com");
    }
  });
  it("rejects garbled values", () => {
    expect(fieldsOf(validEnv({ SESSION_IDLE_SECONDS: "abc" }))).toContain("SESSION_IDLE_SECONDS");
    expect(fieldsOf(validEnv({ SESSION_IDLE_SECONDS: "5" }))).toContain("SESSION_IDLE_SECONDS");
    expect(fieldsOf(validEnv({ SESSION_IDLE_SECONDS: "9000", SESSION_ABSOLUTE_SECONDS: "600" }))).toContain("SESSION_IDLE_SECONDS");
    expect(fieldsOf(validEnv({ WEB_DATABASE_URL: "mysql://x" }))).toContain("WEB_DATABASE_URL");
    expect(fieldsOf(validEnv({ RLUSD_CURRENCY_HEX: "524c555344" }))).toContain("RLUSD_CURRENCY_HEX");
    expect(fieldsOf(validEnv({ WEB_TRUST_PROXY: "yes" }))).toContain("WEB_TRUST_PROXY");
  });
  it("reads the trusted proxy hop count, with WEB_TRUST_PROXY=true as an alias for one hop", () => {
    expect(loadWebConfig(validEnv({ WEB_TRUSTED_PROXY_HOPS: "2" })).trustedProxyHops).toBe(2);
    expect(loadWebConfig(validEnv({ WEB_TRUST_PROXY: "true" })).trustedProxyHops).toBe(1);
    expect(loadWebConfig(validEnv({ WEB_TRUST_PROXY: "true", WEB_TRUSTED_PROXY_HOPS: "1" })).trustedProxyHops).toBe(1);
    expect(loadWebConfig(validEnv({ WEB_TRUST_PROXY: "false", WEB_TRUSTED_PROXY_HOPS: "0" })).trustedProxyHops).toBe(0);
  });
  it("rejects a bad or conflicting proxy setting, naming only the variable", () => {
    for (const v of ["6", "-1", "x", "1.5", "01"]) expect(fieldsOf(validEnv({ WEB_TRUSTED_PROXY_HOPS: v })), v).toContain("WEB_TRUSTED_PROXY_HOPS");
    expect(fieldsOf(validEnv({ WEB_TRUST_PROXY: "true", WEB_TRUSTED_PROXY_HOPS: "2" }))).toContain("WEB_TRUSTED_PROXY_HOPS");
    expect(fieldsOf(validEnv({ WEB_TRUST_PROXY: "false", WEB_TRUSTED_PROXY_HOPS: "1" }))).toContain("WEB_TRUSTED_PROXY_HOPS");
  });
  it("refuses the Mainnet RLUSD issuer", () => {
    expect(fieldsOf(validEnv({ RLUSD_ISSUER: MAINNET_RLUSD_ISSUER }))).toContain("RLUSD_ISSUER");
    expect(ISSUER).not.toBe(MAINNET_RLUSD_ISSUER);
  });
  it("keeps the Mainnet constant in step with the XRPL adapter", () => {
    expect(MAINNET_RLUSD_ISSUER).toBe(ADAPTER_MAINNET);
  });
  it("constrains APP_BASE_URL: https outside loopback, no credentials, path or query", () => {
    expect(fieldsOf(validEnv({ APP_BASE_URL: "http://example.com" }))).toContain("APP_BASE_URL");
    expect(fieldsOf(validEnv({ APP_BASE_URL: "https://user:pw@example.com" }))).toContain("APP_BASE_URL");
    expect(fieldsOf(validEnv({ APP_BASE_URL: "https://example.com/app" }))).toContain("APP_BASE_URL");
    expect(fieldsOf(validEnv({ APP_BASE_URL: "https://example.com/?x=1" }))).toContain("APP_BASE_URL");
    expect(fieldsOf(validEnv({ APP_BASE_URL: "not a url" }))).toContain("APP_BASE_URL");
    expect(fieldsOf(validEnv({ APP_BASE_URL: "http://127.0.0.1:3000", NODE_ENV: "production" }))).toContain("APP_BASE_URL");
    const c = loadWebConfig(validEnv({ APP_BASE_URL: "https://app.example.com", NODE_ENV: "production" }));
    expect(c.cookieSecure).toBe(true);
    expect(c.appOrigin).toBe("https://app.example.com");
  });
  it("refuses to start when guard, agent, admin or signer secrets are present (SV-5)", () => {
    for (const name of [
      "XRPL_DEMO_SIGNER_SEED",
      "XRPL_REGULAR_KEY_SEED",
      "XRPL_ANYTHING_SEED",
      "OWNER_TREASURY_MASTER_SEED",
      "AGENT_TO_PAYMENT_GUARD_TOKEN",
      "AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT",
      "SUPABASE_SERVICE_ROLE_KEY",
      "GUARD_DATABASE_URL",
      "DATABASE_URL",
      "AI_API_KEY",
    ]) {
      expect(fieldsOf(validEnv({ [name]: "x" })), name).toContain(name);
    }
    expect(forbiddenEnvNames({ NODE_ENV: "test", XRPL_DEMO_SIGNER_SEED: "", PATH: "x" })).toEqual([]);
  });
});
describe("assertLeastPrivilegeRole", () => {
  it("refuses a superuser or BYPASSRLS role", () => {
    expect(() => assertLeastPrivilegeRole({ rolsuper: true, rolbypassrls: false })).toThrow(/Refusing to start/);
    expect(() => assertLeastPrivilegeRole({ rolsuper: false, rolbypassrls: true })).toThrow(/Refusing to start/);
    expect(() => assertLeastPrivilegeRole({ rolsuper: false, rolbypassrls: false })).not.toThrow();
  });
});
