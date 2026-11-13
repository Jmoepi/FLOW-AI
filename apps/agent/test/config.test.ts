import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentConfigError, agentConfigWarnings, buildToolServerEnv, loadAgentConfig } from "../src/config";
import { AGENT_SETTING_NAMES, OS_ENV_NAMES, findForbiddenEnv } from "../src/env-guard";

const TOKEN = "k".repeat(48);
const KEY = ["sk", "ant", "test-key-SHOULD-NEVER-PRINT-123456"].join("-"); // assembled so the secret scanner ignores the fixture
const base = { AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN };

describe("forbidden variables", () => {
  const SECRET_VALUE = "super-secret-value-9876";
  for (const name of ["DATABASE_URL", "GUARD_DATABASE_URL", "XRPL_DEMO_SIGNER_SEED", "XRPL_REGULAR_KEY_SEED", "OWNER_TREASURY_MASTER_SEED", "SUPABASE_SERVICE_ROLE_KEY", "PAYMENT_EXECUTION_ENABLED"]) {
    it(`refuses startup when ${name} is present, without echoing the value`, () => {
      let message = "";
      try {
        loadAgentConfig({ ...base, [name]: SECRET_VALUE });
      } catch (err) {
        expect(err).toBeInstanceOf(AgentConfigError);
        message = (err as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain(SECRET_VALUE);
    });
  }
  it("checks forbidden variables before anything else", () => {
    expect(() => loadAgentConfig({ DATABASE_URL: "x" })).toThrow(/DATABASE_URL/);
  });
});

describe("L-1: strict environment allowlist", () => {
  const SECRET_VALUE = "super-secret-value-9876";
  it.each([
    "POSTGRES_URL", "POSTGRES_PASSWORD", "DB_PASSWORD", "MY_APP_SECRET", "STRIPE_SECRET_KEY", "AWS_ACCESS_KEY", "GITHUB_TOKEN", "NPM_TOKEN",
    "AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT", "JWT_SIGNING", "SENTRY_DSN", "OPENAI_API_KEY", "XRPL_REGULAR_KEY_SEED", "TREASURY_WALLET_FILE", "PGPASSWORD", "supabase_anon",
  ])("refuses startup for %s (secret-like, not on the allowlist) without echoing the value", (name) => {
    let message = "";
    try {
      loadAgentConfig({ ...base, [name]: SECRET_VALUE });
    } catch (err) {
      expect(err).toBeInstanceOf(AgentConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain(SECRET_VALUE);
  });
  it("accepts every allowlisted setting and OS variable even though some names look secret", () => {
    const env = Object.fromEntries([...AGENT_SETTING_NAMES, ...OS_ENV_NAMES].map((k) => [k, "x"]));
    expect(findForbiddenEnv(env)).toEqual([]); // AGENT_TO_PAYMENT_GUARD_TOKEN and AI_API_KEY are allowlisted by name
  });
  it("ignores unknown non-secret variables and never reads them into the config", () => {
    const c = loadAgentConfig({ ...base, UNRELATED_SETTING: "1", EDITOR: "vim", NODE_ENV: "test", COLORTERM: "truecolor" });
    expect(JSON.stringify(c)).not.toContain("UNRELATED");
    expect(findForbiddenEnv({ UNRELATED_SETTING: "1", EDITOR: "vim", NODE_ENV: "test", SESSIONNAME: "Console", SSH_AUTH_SOCK: "/s" })).toEqual([]);
  });
  it("the tool server child environment is built from names, so unknown variables are never forwarded", () => {
    const c = loadAgentConfig(base);
    const env = buildToolServerEnv(c, { PATH: "/bin", UNRELATED_SETTING: "1", EDITOR: "vim", AI_API_KEY: KEY });
    expect(Object.keys(env).sort()).toEqual(["AGENT_MAX_PAYMENTS_PER_RUN", "AGENT_MAX_TOOL_CALLS", "AGENT_TO_PAYMENT_GUARD_TOKEN", "PATH", "PAYMENT_GUARD_INTERNAL_URL"].sort());
  });
});
describe("L-2: AI key outside llm mode", () => {
  it("deterministic mode never requires the key and does not read it into the config", () => {
    expect(loadAgentConfig(base).ai).toBeNull();
    const c = loadAgentConfig({ ...base, AI_API_KEY: KEY });
    expect(c.ai).toBeNull();
    expect(JSON.stringify(c)).not.toContain(KEY);
  });
  it("warns by name only when a key is present outside llm mode", () => {
    expect(agentConfigWarnings({ ...base, AI_API_KEY: KEY })).toEqual(["AI_API_KEY is set but AGENT_MODE is not llm; it is ignored and not forwarded."]);
    expect(JSON.stringify(agentConfigWarnings({ ...base, AI_API_KEY: KEY }))).not.toContain(KEY);
    expect(agentConfigWarnings(base)).toEqual([]);
    expect(agentConfigWarnings({ ...base, AGENT_MODE: "llm", AI_API_KEY: KEY })).toEqual([]);
  });
  it("llm mode requires and validates the key", () => {
    const llm = { ...base, AGENT_MODE: "llm", AI_PROVIDER: "anthropic", AI_MODEL: "m" };
    expect(() => loadAgentConfig(llm)).toThrow(/AI_API_KEY/);
    expect(() => loadAgentConfig({ ...llm, AI_API_KEY: "   " })).toThrow(/AI_API_KEY/);
    expect(loadAgentConfig({ ...llm, AI_API_KEY: KEY }).ai?.apiKey).toBe(KEY);
  });
});
describe("defaults and bounds", () => {
  it("deterministic mode needs no AI key and uses the documented defaults", () => {
    const c = loadAgentConfig(base);
    expect(c).toMatchObject({ mode: "deterministic", maxToolCalls: 5, maxPayments: 1, reasonMaxChars: 280, runTimeoutSeconds: 60, scheduleIntervalMinutes: null, ai: null, guardUrl: "http://127.0.0.1:4002" });
  });
  it("treats an empty schedule interval as disabled", () => {
    expect(loadAgentConfig({ ...base, AGENT_SCHEDULE_INTERVAL_MINUTES: "" }).scheduleIntervalMinutes).toBeNull();
    expect(loadAgentConfig({ ...base, AGENT_SCHEDULE_INTERVAL_MINUTES: "15" }).scheduleIntervalMinutes).toBe(15);
  });
  it.each([
    ["AGENT_MAX_TOOL_CALLS", "6"],
    ["AGENT_MAX_TOOL_CALLS", "0"],
    ["AGENT_MAX_PAYMENTS_PER_RUN", "2"],
    ["AGENT_REASON_MAX_CHARS", "281"],
    ["AGENT_RUN_TIMEOUT_SECONDS", "4"],
    ["AGENT_RUN_TIMEOUT_SECONDS", "121"],
    ["AGENT_SCHEDULE_INTERVAL_MINUTES", "1441"],
    ["AGENT_SCHEDULE_INTERVAL_MINUTES", "abc"],
    ["AGENT_MODE", "autopilot"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => loadAgentConfig({ ...base, [name]: value })).toThrow(AgentConfigError);
  });
  it("rejects a missing or short token and a non-allowlisted guard URL", () => {
    expect(() => loadAgentConfig({})).toThrow(/AGENT_TO_PAYMENT_GUARD_TOKEN/);
    expect(() => loadAgentConfig({ AGENT_TO_PAYMENT_GUARD_TOKEN: "short" })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ ...base, PAYMENT_GUARD_INTERNAL_URL: "http://example.com:4002" })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ ...base, PAYMENT_GUARD_INTERNAL_URL: "https://user:pw@example.com" })).toThrow(AgentConfigError);
  });
});

describe("llm mode", () => {
  const llm = { ...base, AGENT_MODE: "llm", AI_PROVIDER: "anthropic", AI_MODEL: "some-model", AI_API_KEY: KEY };
  it("fails closed without a key, a model or the anthropic provider", () => {
    expect(() => loadAgentConfig({ ...llm, AI_API_KEY: "" })).toThrow(/AI_API_KEY/);
    expect(() => loadAgentConfig({ ...llm, AI_MODEL: "" })).toThrow(/AI_MODEL/);
    expect(() => loadAgentConfig({ ...llm, AI_MODEL: "<verify-current-anthropic-model-id>" })).toThrow(/AI_MODEL/);
    expect(() => loadAgentConfig({ ...llm, AI_PROVIDER: "other" })).toThrow(/AI_PROVIDER/);
  });
  it("never reveals the key or the token through JSON, inspect or spread", () => {
    const c = loadAgentConfig(llm);
    expect(c.ai?.apiKey).toBe(KEY); // available to the adapter only by explicit access
    for (const text of [JSON.stringify(c), inspect(c, { depth: 6 }), JSON.stringify({ ...c }), String(JSON.stringify(c.ai)), inspect(c.ai, { depth: 3, showHidden: false })]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(TOKEN);
    }
    expect(JSON.stringify(c)).toContain("[REDACTED]");
  });
});

describe("tool server environment", () => {
  it("contains only OS essentials, guard URL, token and bounds", () => {
    const c = loadAgentConfig({ ...base, AGENT_MODE: "llm", AI_PROVIDER: "anthropic", AI_MODEL: "m", AI_API_KEY: KEY });
    const env = buildToolServerEnv(c, { PATH: "/bin", SystemRoot: "C:\\Windows", AI_API_KEY: KEY, DATABASE_URL: "postgres://x", RANDOM: "1" });
    expect(Object.keys(env).sort()).toEqual(["AGENT_MAX_PAYMENTS_PER_RUN", "AGENT_MAX_TOOL_CALLS", "AGENT_TO_PAYMENT_GUARD_TOKEN", "PATH", "PAYMENT_GUARD_INTERNAL_URL", "SystemRoot"].sort());
    expect(JSON.stringify(env)).not.toContain(KEY);
  });
});
