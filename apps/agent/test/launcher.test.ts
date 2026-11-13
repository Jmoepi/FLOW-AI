import { describe, expect, it } from "vitest";
import { AGENT_SETTING_NAMES, findForbiddenEnv } from "../src/env-guard";
import { AGENT_ENV_ALLOWLIST, aiKeyDropped, buildAgentEnv, pickAgentSettings } from "../../../scripts/lib/agent-launcher";

const TOKEN = "a".repeat(64);

describe("agent launcher environment", () => {
  const parent = {
    PATH: "/bin",
    SystemRoot: "C:\\Windows",
    DATABASE_URL: "postgres://admin:pw@db/x",
    GUARD_DATABASE_URL: "postgres://g:pw@db/x",
    XRPL_DEMO_SIGNER_SEED: "sEdSECRET",
    OWNER_TREASURY_MASTER_SEED: "sEdSECRET2",
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    PAYMENT_EXECUTION_ENABLED: "true",
    AGENT_MODE: "deterministic",
    UNRELATED: "x",
  };
  const dotenvValues = { AI_API_KEY: "from-dotenv", AI_MODEL: "m", DATABASE_URL: "postgres://root-env", AGENT_MODE: "llm" };

  it("passes only OS essentials, allowlisted settings, the guard URL and the token", () => {
    const env = buildAgentEnv({ parent, dotenvValues, token: TOKEN, guardPort: 4010 });
    expect(Object.keys(env).sort()).toEqual(["AGENT_MODE", "AGENT_TO_PAYMENT_GUARD_TOKEN", "AI_MODEL", "PATH", "PAYMENT_GUARD_INTERNAL_URL", "SystemRoot"].sort());
    expect(env.PAYMENT_GUARD_INTERNAL_URL).toBe("http://127.0.0.1:4010");
    expect(env.AGENT_MODE).toBe("deterministic"); // real environment wins over the root .env
  });
  it("L-2: AI_API_KEY is dropped unless the mode is llm, and is forwarded in llm mode", () => {
    const det = buildAgentEnv({ parent, dotenvValues, token: TOKEN, guardPort: 4010 });
    expect(Object.keys(det)).not.toContain("AI_API_KEY");
    expect(Object.values(det)).not.toContain("from-dotenv");
    expect(aiKeyDropped(parent, dotenvValues)).toBe(true);
    const llmParent = { ...parent, AGENT_MODE: "llm" };
    expect(buildAgentEnv({ parent: llmParent, dotenvValues, token: TOKEN, guardPort: 4010 }).AI_API_KEY).toBe("from-dotenv");
    expect(aiKeyDropped(llmParent, dotenvValues)).toBe(false);
    expect(pickAgentSettings({}, { AI_API_KEY: "k" })).toEqual({}); // no mode set: default is deterministic
    expect(aiKeyDropped({}, {})).toBe(false);
  });
  it("every launcher setting is on the agent's own allowlist", () => {
    for (const k of AGENT_ENV_ALLOWLIST) expect(AGENT_SETTING_NAMES as readonly string[]).toContain(k);
  });

  it("the resulting environment passes the agent's own forbidden-variable check", () => {
    expect(findForbiddenEnv(buildAgentEnv({ parent, dotenvValues, token: TOKEN, guardPort: 4002 }))).toEqual([]);
  });

  it("the allowlist itself contains no forbidden name", () => {
    expect(findForbiddenEnv(Object.fromEntries(AGENT_ENV_ALLOWLIST.map((k) => [k, "x"])))).toEqual([]);
    expect(pickAgentSettings({}, { DATABASE_URL: "x" })).toEqual({});
  });
});
