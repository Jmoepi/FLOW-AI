import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Wallet, type Payment } from "xrpl";
import { createGuardSigner, SignerError, type SignerDeps, type SigningInstruction } from "../src/signer/signer";
import { CURRENCY_HEX, DESTINATION, ISSUER, SENDER } from "./payment-fixtures";

const SEED_VAR = "XRPL_DEMO_SIGNER_SEED";
const instruction: SigningInstruction = { account: SENDER.address, destination: DESTINATION, currency: CURRENCY_HEX, issuer: ISSUER, value: "1" };
const baseTx = (): Payment => ({
  TransactionType: "Payment", Account: SENDER.address, Destination: DESTINATION, Amount: { currency: CURRENCY_HEX, issuer: ISSUER, value: "1" },
  Fee: "12", Sequence: 5, LastLedgerSequence: 200,
});
const envWith = (over: Record<string, string | undefined> = {}) => ({ PAYMENT_EXECUTION_ENABLED: "true", [SEED_VAR]: SENDER.seed, ...over }) as NodeJS.ProcessEnv;
const make = (over: Partial<SignerDeps> = {}, env: NodeJS.ProcessEnv = envWith()) =>
  createGuardSigner(instruction, { env: () => env, isExecutionEnabled: () => env.PAYMENT_EXECUTION_ENABLED === "true", network: "xrpl-testnet", ...over });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SignerError);
    return (e as SignerError).code;
  }
  return undefined;
};

describe("guard signer (SV-5, PG-8, 10.8)", () => {
  it("signs exactly the reserved payment", () => {
    const signed = make().sign(baseTx());
    expect(signed.hash).toMatch(/^[0-9A-F]{64}$/);
    expect(signed.txBlob).toMatch(/^[0-9A-F]+$/);
  });

  it.each<[string, (t: Payment) => void]>([
    ["wrong destination", (t) => void (t.Destination = Wallet.generate().address)],
    ["wrong account", (t) => void (t.Account = Wallet.generate().address)],
    ["wrong amount", (t) => void (t.Amount = { currency: CURRENCY_HEX, issuer: ISSUER, value: "1.000001" })],
    ["wrong issuer", (t) => void (t.Amount = { currency: CURRENCY_HEX, issuer: Wallet.generate().address, value: "1" })],
    ["wrong currency", (t) => void (t.Amount = { currency: "USD", issuer: ISSUER, value: "1" })],
    ["XRP amount", (t) => void (t.Amount = "1000000")],
    ["extra amount field", (t) => void (t.Amount = { currency: CURRENCY_HEX, issuer: ISSUER, value: "1", extra: "x" } as never)],
    ["wrong type", (t) => void ((t as unknown as Record<string, unknown>).TransactionType = "AccountDelete")],
    ["partial payment flag", (t) => void (t.Flags = 0x00020000)],
    ["SendMax", (t) => void (t.SendMax = { currency: CURRENCY_HEX, issuer: ISSUER, value: "9" })],
    ["DeliverMin", (t) => void (t.DeliverMin = { currency: CURRENCY_HEX, issuer: ISSUER, value: "1" })],
    ["Paths", (t) => void (t.Paths = [[{ account: DESTINATION }]])],
    ["DestinationTag", (t) => void (t.DestinationTag = 1)],
    ["Memos", (t) => void (t.Memos = [{ Memo: { MemoData: "AA" } }])],
    ["Signers", (t) => void ((t as unknown as Record<string, unknown>).Signers = [])],
    ["SigningPubKey", (t) => void ((t as unknown as Record<string, unknown>).SigningPubKey = "AA")],
    ["unknown field", (t) => void ((t as unknown as Record<string, unknown>).Evil = "x")],
    ["huge fee", (t) => void (t.Fee = "5000000")],
    ["non-numeric fee", (t) => void (t.Fee = "1e3")],
  ])("refuses %s", (_name, mutate) => {
    const tx = baseTx();
    mutate(tx);
    expect(codeOf(() => make().sign(tx))).toBe("TX_REFUSED");
  });

  it("refuses a non-Testnet network before reading the seed", () => {
    let read = false;
    const env = new Proxy(envWith(), { get: (t, k) => ((read = read || k === SEED_VAR), Reflect.get(t, k)) });
    expect(codeOf(() => make({ network: "xrpl-mainnet" }, env).sign(baseTx()))).toBe("NETWORK_REFUSED");
    expect(read).toBe(false);
  });

  it.each(["false", "TRUE", "1", " true", "", undefined])("refuses when the kill switch is %j, without touching the seed", (value) => {
    let read = false;
    const env = new Proxy(envWith({ PAYMENT_EXECUTION_ENABLED: value }), { get: (t, k) => ((read = read || k === SEED_VAR), Reflect.get(t, k)) });
    expect(codeOf(() => make({ isExecutionEnabled: () => true }, env).sign(baseTx()))).toBe("EXECUTION_DISABLED");
    expect(read).toBe(false);
  });

  it("re-reads the kill switch on every call", () => {
    const env = envWith();
    const signer = make({}, env);
    expect(() => signer.sign(baseTx())).not.toThrow();
    env.PAYMENT_EXECUTION_ENABLED = "false";
    expect(codeOf(() => signer.sign(baseTx()))).toBe("EXECUTION_DISABLED");
  });

  it("reads the seed lazily: building the signer without a seed does not throw, signing does", () => {
    const signer = make({}, envWith({ [SEED_VAR]: undefined }));
    expect(signer.address).toBe(SENDER.address);
    expect(codeOf(() => signer.sign(baseTx()))).toBe("SEED_UNAVAILABLE");
  });

  it("refuses a seed that does not belong to the reserved account, and a garbage seed, with fixed errors", () => {
    const other = Wallet.generate();
    expect(codeOf(() => make({}, envWith({ [SEED_VAR]: other.seed })).sign(baseTx()))).toBe("ACCOUNT_MISMATCH");
    expect(codeOf(() => make({}, envWith({ [SEED_VAR]: "not-a-seed" })).sign(baseTx()))).toBe("SEED_UNAVAILABLE");
  });

  it("never exposes the seed through errors, String, JSON or inspect", () => {
    const seed = SENDER.seed as string;
    const signer = make();
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the test proves default stringification leaks nothing
    const surfaces: string[] = [String(signer), JSON.stringify(signer), inspect(signer, { depth: 8, showHidden: true })];
    for (const env of [envWith({ PAYMENT_EXECUTION_ENABLED: "false" }), envWith({ [SEED_VAR]: Wallet.generate().seed }), envWith({ [SEED_VAR]: "bad" })]) {
      try {
        make({}, env).sign(baseTx());
      } catch (e) {
        surfaces.push(String(e), JSON.stringify(e), inspect(e, { depth: 8 }), (e as Error).stack ?? "");
      }
    }
    const tx = baseTx();
    tx.Destination = Wallet.generate().address;
    try {
      signer.sign(tx);
    } catch (e) {
      surfaces.push(String(e), inspect(e, { depth: 8 }), (e as Error).stack ?? "");
    }
    for (const s of surfaces) {
      expect(s).not.toContain(seed);
      expect(s).not.toContain(SENDER.privateKey);
    }
  });

  it("mentions the seed variable in exactly one source file (SV-5)", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs|json)$/.test(name) && readFileSync(full, "utf8").includes(SEED_VAR)) hits.push(relative(root, full).split(sep).join("/"));
      }
    };
    for (const group of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(root, group))) {
        const src = join(root, group, pkg, "src");
        try {
          if (statSync(src).isDirectory()) walk(src);
        } catch {
          /* package without src */
        }
      }
    }
    // redact.ts only lists the NAME in its redaction denylist (SECRET_ENV_NAMES); it never reads the value.
    expect(hits).toEqual(["apps/payment-guard/src/signer/signer.ts", "packages/contracts/src/redact.ts"]);
    const redactSrc = readFileSync(join(root, "packages/contracts/src/redact.ts"), "utf8");
    expect(redactSrc).not.toMatch(/process\.env|\benv\s*\[/);
  });
});
