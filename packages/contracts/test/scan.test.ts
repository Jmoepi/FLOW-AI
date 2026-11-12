import { describe, expect, it } from "vitest";
import { forbiddenFileRule, scanText } from "../src/index";

// Synthetic, runtime-assembled examples only: no secret-shaped literal lives in this file.
const filler = "Ab3Xy9QwErTpUiKk";
const fakeSeed = "s" + (filler + filler).slice(0, 28);
const fakeEdSeed = "sEd" + (filler + filler).slice(0, 26);
const rules = (text: string) => scanText(text).map((f) => f.rule);

describe("scanText", () => {
  it("flags family and ed25519 seeds, even glued to punctuation", () => {
    expect(rules(`seed = "${fakeSeed}"`)).toContain("xrpl-family-seed-pattern");
    expect(rules(fakeEdSeed)).toContain("xrpl-family-seed-pattern");
    expect(rules(`x_${fakeSeed}_y`)).toContain("xrpl-family-seed-pattern");
  });

  it("flags hex private keys, labelled hex secrets and signed blobs", () => {
    expect(rules("ED" + "0123456789ABCDEF".repeat(4))).toContain("hex-private-key-pattern");
    expect(rules('privateKey: "' + "ab".repeat(32) + '"')).toContain("labelled-hex-secret");
    expect(rules("12000022800000002400000001".padEnd(400, "AB"))).toContain("signed-tx-blob-pattern");
  });

  it("flags API keys, JWTs, bearer tokens and PEM headers", () => {
    expect(rules(["sk", "ant", "api03"].join("-") + "-" + "Zq8".repeat(12))).toContain("anthropic-api-key");
    expect(rules("sk-" + "Qw3Er5".repeat(8))).toContain("openai-style-api-key");
    expect(rules(["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVl"].join("."))).toContain("jwt");
    expect(rules("Authorization: Bearer " + "abcDEF1234567890".repeat(2))).toContain("bearer-token");
    expect(rules(["-----BEGIN", "EC PRIVATE KEY-----"].join(" "))).toContain("pem-private-key-block");
  });

  it("flags non-empty secret env assignments but allows empty or placeholder values", () => {
    expect(rules("XRPL_DEMO_SIGNER_SEED=abc123")).toContain("non-empty XRPL_DEMO_SIGNER_SEED");
    expect(rules("export AI_API_KEY='x'")).toContain("non-empty AI_API_KEY");
    expect(scanText("XRPL_DEMO_SIGNER_SEED=")).toEqual([]);
    expect(scanText("AI_API_KEY=<your key>")).toEqual([]);
    expect(scanText("AI_API_KEY= # set locally")).toEqual([]);
    expect(scanText('DATABASE_URL=""')).toEqual([]);
  });

  it("does not flag addresses, 64-hex tx hashes, currency hex or plain words", () => {
    const text = [
      "rE4urd4omtoUQGqfD1FdhHhbuNQMeY6ChH",
      "1B92943B703A0099F3104DF845042A16BA0C3845C2406034F043A1A2389BD47C",
      "524C555344000000000000000000000000000000",
      "sustainabilitytransformationwords",
      "task-management-and-disk-usage-statistics-report",
    ].join("\n");
    expect(scanText(text)).toEqual([]);
  });

  it("reports line numbers and never the value", () => {
    const out = scanText(`ok\n${fakeSeed}\nok`);
    expect(out).toEqual([{ line: 2, rule: "xrpl-family-seed-pattern" }]);
    expect(JSON.stringify(out)).not.toContain(fakeSeed);
  });

  it("is linear on hostile input (no ReDoS)", () => {
    const t0 = Date.now();
    scanText("XRPL_DEMO_SIGNER_SEED=a" + " ".repeat(300_000) + "b");
    scanText("s" + "A".repeat(300_000));
    scanText("ab".repeat(300_000));
    scanText("Bearer " + "a".repeat(300_000));
    scanText("a ".repeat(300_000));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("forbiddenFileRule", () => {
  it.each([".env", ".env.local", "a/b/.env.production", "x.pem", "k/server.key", ".secrets/anything.json", "testnet-wallets.json", "cert.p12"])(
    "forbids %s",
    (p) => expect(forbiddenFileRule(p)).not.toBeNull(),
  );
  it.each([".env.example", "src/index.ts", "docs/security-review.md", "keyboard.ts", "package.json"])("allows %s", (p) =>
    expect(forbiddenFileRule(p)).toBeNull(),
  );
});
