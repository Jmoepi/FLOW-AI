import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Wallet, type Payment } from "xrpl";
import { decode } from "xrpl";
import { createGuardSigner, regularKeyAddress, signerMode, SignerError, type SignerDeps, type SigningInstruction } from "../src/signer/signer";
import { CURRENCY_HEX, DESTINATION, ISSUER, SENDER } from "./payment-fixtures";

const SEED_VAR = "XRPL_DEMO_SIGNER_SEED";
const REGULAR_VAR = "XRPL_REGULAR_KEY_SEED";
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

  describe("regular key backend (M7, 10.8)", () => {
    const regular = Wallet.generate();
    const regEnv = (over: Record<string, string | undefined> = {}) => ({ PAYMENT_EXECUTION_ENABLED: "true", [REGULAR_VAR]: regular.seed, ...over }) as NodeJS.ProcessEnv;
    const sign = (env: NodeJS.ProcessEnv, tx: Payment = baseTx()) => make({}, env).sign(tx);
    it("signs with the regular key: Account stays the treasury, SigningPubKey is the regular key", () => {
      const signed = sign(regEnv());
      const decoded = decode(signed.txBlob) as unknown as { Account: string; SigningPubKey: string };
      expect(decoded.Account).toBe(SENDER.address);
      expect(decoded.SigningPubKey).toBe(regular.publicKey);
      expect(decoded.SigningPubKey).not.toBe(SENDER.publicKey);
    });
    it("signs with the master only when no regular key is configured", () => {
      expect(signerMode(envWith())).toBe("master_env");
      expect(signerMode(regEnv())).toBe("regular_key");
      expect((decode(sign(envWith()).txBlob) as unknown as { SigningPubKey: string }).SigningPubKey).toBe(SENDER.publicKey);
    });
    it("never reads the master seed while a regular key is configured", () => {
      let masterRead = false;
      const env = new Proxy(regEnv({ [SEED_VAR]: SENDER.seed }), { get: (t, k) => ((masterRead = masterRead || k === SEED_VAR), Reflect.get(t, k)) });
      expect(() => sign(env)).not.toThrow();
      expect(masterRead).toBe(false);
    });
    it("works without any master seed in the environment", () => {
      expect(() => sign(regEnv({ [SEED_VAR]: undefined }))).not.toThrow();
    });
    it("refuses a 'regular key' that is actually the treasury master key", () => {
      expect(codeOf(() => sign(regEnv({ [REGULAR_VAR]: SENDER.seed })))).toBe("ACCOUNT_MISMATCH");
    });
    it("reports SEED_UNAVAILABLE for a malformed regular key seed, without echoing it", () => {
      expect(codeOf(() => sign(regEnv({ [REGULAR_VAR]: "not-a-seed" })))).toBe("SEED_UNAVAILABLE");
    });
    it.each<[string, (t: Payment) => void]>([
      ["wrong destination", (t) => void (t.Destination = Wallet.generate().address)],
      ["wrong amount", (t) => void (t.Amount = { currency: CURRENCY_HEX, issuer: ISSUER, value: "2" })],
      ["wrong type", (t) => void ((t as unknown as Record<string, unknown>).TransactionType = "AccountSet")],
      ["partial payment flag", (t) => void (t.Flags = 0x00020000)],
      ["Memos", (t) => void (t.Memos = [{ Memo: { MemoData: "AA" } }])],
      ["huge fee", (t) => void (t.Fee = "5000000")],
    ])("still enforces the typed Payment checks in regular-key mode: %s", (_n, mutate) => {
      const tx = baseTx();
      mutate(tx);
      expect(codeOf(() => sign(regEnv(), tx))).toBe("TX_REFUSED");
    });
    it("still honours the network and the kill switch before touching the seed", () => {
      let read = false;
      const env = new Proxy(regEnv({ PAYMENT_EXECUTION_ENABLED: "false" }), { get: (t, k) => ((read = read || k === REGULAR_VAR), Reflect.get(t, k)) });
      expect(codeOf(() => make({ isExecutionEnabled: () => true }, env).sign(baseTx()))).toBe("EXECUTION_DISABLED");
      expect(codeOf(() => make({ network: "xrpl-mainnet" }, regEnv()).sign(baseTx()))).toBe("NETWORK_REFUSED");
      expect(read).toBe(false);
    });
    it("exposes only the PUBLIC address of the regular key", () => {
      expect(regularKeyAddress(regEnv())).toBe(regular.address);
      expect(regularKeyAddress(envWith())).toBeNull();
      expect(regularKeyAddress(regEnv({ [REGULAR_VAR]: "bad" }))).toBeNull();
    });
    it("never exposes the regular key seed through errors, String, JSON or inspect", () => {
      const surfaces: string[] = [];
      for (const env of [regEnv({ PAYMENT_EXECUTION_ENABLED: "false" }), regEnv({ [REGULAR_VAR]: SENDER.seed })]) {
        try {
          make({}, env).sign(baseTx());
        } catch (e) {
          surfaces.push(String(e), JSON.stringify(e), inspect(e, { depth: 8 }), (e as Error).stack ?? "");
        }
      }
      for (const text of surfaces) {
        expect(text).not.toContain(regular.seed as string);
        expect(text).not.toContain(regular.privateKey);
        expect(text).not.toContain(SENDER.seed as string);
      }
    });
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
    // The regular key variable (M7) is held to the same rule: only the signer (and the redaction denylist) may name it.
    const regularHits: string[] = [];
    const walkRegular = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkRegular(full);
        else if (/\.(ts|tsx|js|mjs|json)$/.test(name) && readFileSync(full, "utf8").includes(REGULAR_VAR)) regularHits.push(relative(root, full).split(sep).join("/"));
      }
    };
    for (const group of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(root, group))) {
        try {
          const src = join(root, group, pkg, "src");
          if (statSync(src).isDirectory()) walkRegular(src);
        } catch {
          /* package without src */
        }
      }
    }
    expect(regularHits).toEqual(["apps/payment-guard/src/signer/signer.ts", "packages/contracts/src/redact.ts"]);
    const redactSrc = readFileSync(join(root, "packages/contracts/src/redact.ts"), "utf8");
    expect(redactSrc).not.toMatch(/process\.env|\benv\s*\[/);
  });
});
