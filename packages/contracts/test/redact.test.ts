import { describe, expect, it } from "vitest";
import { REDACTED, SECRET_RULES, redactError, redactString, redactValue, safeStringify } from "../src/index";

// All "secrets" below are synthetic and assembled at runtime so this file holds no secret-shaped literal.
const b58 = "Ab3Xy9QwErTpUiOo".replace(/[Oo]/g, "K"); // base58-safe filler
const fakeSeed = "s" + (b58 + b58 + b58).slice(0, 28); // 29 chars, family-seed shaped
const fakeEdSeed = "sEd" + (b58 + b58 + b58).slice(0, 26);
const fakeBlob = "12000022800000002400000001".padEnd(400, "AB");
const fakeEdKey = "ED" + "0123456789ABCDEF".repeat(4);
const fakeAnthropic = ["sk", "ant", "api03"].join("-") + "-" + "Zq8".repeat(12);
const fakeOpenAi = "sk-" + "Qw3Er5".repeat(8);
const fakeJwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVl"].join(".");
const fakeBearer = "Bearer " + "abcDEF1234567890".repeat(2);
const pemHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const fakePem = [pemHeader, "MIIEvQIBADANBg", ["-----END", "PRIVATE KEY-----"].join(" ")].join("\n");

describe("redactString", () => {
  it.each([
    ["family seed", fakeSeed],
    ["ed25519 seed", fakeEdSeed],
    ["signed tx blob", fakeBlob],
    ["hex private key", fakeEdKey],
    ["anthropic key", fakeAnthropic],
    ["openai-style key", fakeOpenAi],
    ["jwt", fakeJwt],
    ["bearer token", fakeBearer],
    ["pem block", fakePem],
  ])("removes a %s", (_name, secret) => {
    const out = redactString(`before ${secret} after`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out.startsWith("before ")).toBe(true);
  });

  it("removes a seed glued to punctuation or underscores", () => {
    expect(redactString(`x_${fakeSeed}_y`)).not.toContain(fakeSeed);
    expect(redactString(`"${fakeSeed}",`)).not.toContain(fakeSeed);
  });

  it("removes secret env assignments and labelled values", () => {
    expect(redactString("XRPL_DEMO_SIGNER_SEED=hunter2hunter2")).toBe(`XRPL_DEMO_SIGNER_SEED=${REDACTED}`);
    expect(redactString('seed: "hunter2hunter2"')).not.toContain("hunter2");
    expect(redactString('{"privateKey":"' + "ab".repeat(32) + '"}')).not.toContain("ab".repeat(32));
  });

  it("removes URL credentials", () => {
    const out = redactString("wss://user:pa55word@host.example:1234/x");
    expect(out).not.toContain("pa55word");
    expect(out).toContain("host.example");
  });

  it("keeps public data: addresses, 64-hex tx hashes, short currency hex, explorer links", () => {
    const hash = "1B92943B703A0099F3104DF845042A16BA0C3845C2406034F043A1A2389BD47C";
    const text = `from rE4urd4omtoUQGqfD1FdhHhbuNQMeY6ChH hash ${hash} cur 524C555344000000000000000000000000000000 https://testnet.xrpl.org/transactions/${hash}`;
    expect(redactString(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = redactString(`a ${fakeSeed} b ${fakeJwt}`);
    expect(redactString(once)).toBe(once);
  });

  it("stays fast on hostile input (no catastrophic backtracking)", () => {
    const inputs = [
      "s" + "A".repeat(200_000),
      pemHeader.repeat(5_000),
      "Bearer " + "a".repeat(200_000),
      "ab".repeat(200_000),
      "seed=" + " ".repeat(200_000),
      "://" + "a:".repeat(50_000),
    ];
    const t0 = Date.now();
    for (const i of inputs) redactString(i);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("redactValue / safeStringify / redactError", () => {
  it("redacts nested objects, arrays and sensitive keys", () => {
    const input = {
      ok: "fine",
      nested: { list: [`seed is ${fakeSeed}`, { deep: fakeBlob }] },
      seed: "anything-at-all",
      txBlob: "00",
      headers: { Authorization: "whatever", cookie: "c=1" },
      empty: { token: "" },
    };
    const out = JSON.stringify(redactValue(input));
    for (const s of [fakeSeed, fakeBlob, "anything-at-all", "whatever", "c=1"]) expect(out).not.toContain(s);
    expect(out).toContain("fine");
    expect(JSON.parse(out).seed).toBe(REDACTED);
  });

  it("does not mutate its input", () => {
    const input = { seed: fakeSeed, list: [fakeSeed] };
    redactValue(input);
    expect(input.seed).toBe(fakeSeed);
    expect(input.list[0]).toBe(fakeSeed);
  });

  it("redacts Error message, cause and (optional) stack; omits stack by default", () => {
    const err = new Error(`bad ${fakeSeed}`, { cause: new Error(`inner ${fakeBlob}`) });
    const plain = JSON.stringify(redactValue(err));
    expect(plain).not.toContain(fakeSeed);
    expect(plain).not.toContain(fakeBlob);
    expect(plain).not.toContain("stack");
    const withStack = JSON.stringify(redactValue(err, { includeStack: true }));
    expect(withStack).not.toContain(fakeSeed);
    expect(withStack).toContain("stack");
  });

  it("handles cycles, bigint and depth without throwing", () => {
    const a: Record<string, unknown> = { n: 10n };
    a.self = a;
    expect(() => safeStringify(a)).not.toThrow();
    expect(safeStringify(a)).toContain("[Circular]");
    let deep: Record<string, unknown> = { v: fakeSeed };
    for (let i = 0; i < 30; i++) deep = { deep };
    expect(safeStringify(deep)).not.toContain(fakeSeed);
  });

  it("drops __proto__ keys and does not pollute prototypes", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as unknown;
    const out = redactValue(hostile) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("safeStringify output is valid JSON with secrets removed", () => {
    const s = safeStringify({ msg: `x ${fakeEdSeed}`, k: fakeAnthropic }, 2);
    expect(() => JSON.parse(s)).not.toThrow();
    expect(s).not.toContain(fakeEdSeed);
    expect(s).not.toContain(fakeAnthropic);
  });

  it("redactError handles Error, string and arbitrary values", () => {
    expect(redactError(new Error(`boom ${fakeSeed}`))).not.toContain(fakeSeed);
    expect(redactError(`boom ${fakeSeed}`)).not.toContain(fakeSeed);
    expect(redactError({ seed: fakeSeed })).not.toContain(fakeSeed);
  });
});

describe("SECRET_RULES", () => {
  it("every rule has a non-global pattern (safe for .test)", () => {
    for (const r of SECRET_RULES) expect(r.pattern.global).toBe(false);
  });
});
