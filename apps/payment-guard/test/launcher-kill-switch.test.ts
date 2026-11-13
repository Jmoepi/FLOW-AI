import { describe, expect, it } from "vitest";
import { baseGuardEnv, killSwitchValue } from "../../../scripts/lib/guard-launcher";

describe("guard launcher kill switch", () => {
  it("keeps execution on for m3-e2e (default) and off only when explicitly disabled", () => {
    expect(killSwitchValue({})).toBe("true");
    expect(killSwitchValue({ executionEnabled: true })).toBe("true");
    expect(killSwitchValue({ executionEnabled: false })).toBe("false");
  });
  it("does not leak the kill switch or secrets from the parent environment", () => {
    const env = baseGuardEnv({ PATH: "/bin", PAYMENT_EXECUTION_ENABLED: "true", DATABASE_URL: "x", XRPL_DEMO_SIGNER_SEED: "x" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
