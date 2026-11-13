import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "xrpl";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";
import { TOKEN } from "./helpers";
describe("logger", () => {
  it("never emits seed-shaped, blob-shaped or token values", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    const seed = Wallet.generate().seed ?? "";
    const blob = "12000022800000002401".padEnd(400, "AB");
    log.info("test.event", { note: `seed ${seed} here`, signed_blob: blob, blob2: blob, header: `Bearer ${TOKEN}`, token: TOKEN, url: "postgres://u:pw12345@host/db", nested: { seed } });
    const out = lines.join("\n");
    expect(out).toContain('"event":"test.event"');
    for (const secret of [seed, blob, TOKEN, "pw12345"]) expect(out).not.toContain(secret);
  });
  it("emits one JSON object per line", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).warn("a", { n: 1 });
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "warn", event: "a", n: 1 });
  });
});
describe("code boundaries", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : [path.join(dir, n)]));
  it("has no pg import and no SQL text under apps/payment-guard/src", () => {
    for (const f of files(root)) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from "pg"|require\("pg"\)/);
      expect(text, f).not.toMatch(/\b(SELECT\s[\s\S]{1,200}?\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/);
    }
  });
});
