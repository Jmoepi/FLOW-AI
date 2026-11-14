import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import {
  assertSetRegularKeyOnly, buildSetRegularKeyTx, formatRegularKeyEnv, parseOwnerKeyArgs, parseRegularKeyAddress, parseRegularKeySeed, regularKeyState,
} from "../../../scripts/lib/owner-key";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const treasury = Wallet.generate();
const guardKey = Wallet.generate();

describe("owner key scripts: transaction builder (M7, 10.6: master key is never disabled)", () => {
  it("builds exactly SetRegularKey with only the allowed keys", () => {
    expect(buildSetRegularKeyTx(treasury.address, guardKey.address)).toEqual({ TransactionType: "SetRegularKey", Account: treasury.address, RegularKey: guardKey.address });
    // Revoke: no RegularKey field at all.
    const revoke = buildSetRegularKeyTx(treasury.address);
    expect(revoke).toEqual({ TransactionType: "SetRegularKey", Account: treasury.address });
    expect(Object.keys(revoke)).not.toContain("RegularKey");
  });
  it("accepts the autofilled builder output", () => {
    const tx = { ...buildSetRegularKeyTx(treasury.address, guardKey.address), Fee: "12", Sequence: 3, LastLedgerSequence: 99 };
    expect(() => assertSetRegularKeyOnly(tx, treasury.address)).not.toThrow();
  });
  it.each<[string, Record<string, unknown>]>([
    ["AccountSet (the type that could disable the master key)", { TransactionType: "AccountSet", Account: treasury.address }],
    ["a SetFlag field", { TransactionType: "SetRegularKey", Account: treasury.address, SetFlag: 4 }],
    ["a ClearFlag field", { TransactionType: "SetRegularKey", Account: treasury.address, ClearFlag: 4 }],
    ["Flags", { TransactionType: "SetRegularKey", Account: treasury.address, Flags: 1 }],
    ["Signers", { TransactionType: "SetRegularKey", Account: treasury.address, Signers: [] }],
    ["an unknown field", { TransactionType: "SetRegularKey", Account: treasury.address, Evil: "x" }],
    ["a Payment", { TransactionType: "Payment", Account: treasury.address }],
    ["another account", { TransactionType: "SetRegularKey", Account: guardKey.address }],
    ["the master as its own regular key", { TransactionType: "SetRegularKey", Account: treasury.address, RegularKey: treasury.address }],
  ])("refuses to sign %s", (_name, tx) => {
    expect(() => assertSetRegularKeyOnly(tx, treasury.address)).toThrow(/Refusing to sign/);
  });
  it("no source file under scripts/, apps/*/src or packages/*/src can set asfDisableMaster or build an account-settings transaction", () => {
    const hits: string[] = [];
    const pattern = /asfDisableMaster|["'`]AccountSet["'`]|\bSetFlag\b|\bClearFlag\b|\bAccountSetAsfFlags\b/;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name === ".next" || name.startsWith(".")) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(name) && pattern.test(readFileSync(full, "utf8"))) hits.push(relative(ROOT, full).split(sep).join("/"));
      }
    };
    walk(join(ROOT, "scripts"));
    for (const group of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(ROOT, group))) {
        try {
          const src = join(ROOT, group, pkg, "src");
          if (statSync(src).isDirectory()) walk(src);
        } catch {
          /* package without src */
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("owner key scripts: arguments and state", () => {
  it("requires an explicit subcommand and refuses unknown flags", () => {
    expect(() => parseOwnerKeyArgs([])).toThrow(/Usage/);
    expect(() => parseOwnerKeyArgs(["--confirm"])).toThrow(/Usage/);
    expect(() => parseOwnerKeyArgs(["set", "--force"])).toThrow(/Usage/);
    expect(() => parseOwnerKeyArgs(["revoke", "--rotate"])).toThrow(/Usage/);
    expect(() => parseOwnerKeyArgs(["status", "--confirm"])).toThrow(/read-only/);
  });
  it("is a dry run unless --confirm is given", () => {
    expect(parseOwnerKeyArgs(["--", "set"])).toEqual({ command: "set", confirm: false, rotate: false });
    expect(parseOwnerKeyArgs(["revoke", "--confirm"])).toEqual({ command: "revoke", confirm: true, rotate: false });
    expect(parseOwnerKeyArgs(["set", "--confirm", "--rotate"])).toEqual({ command: "set", confirm: true, rotate: true });
  });
  it("classifies the observed ledger RegularKey against the configured guard key address", () => {
    expect(regularKeyState(null, guardKey.address)).toBe("not_set");
    expect(regularKeyState(guardKey.address, guardKey.address)).toBe("active");
    expect(regularKeyState(Wallet.generate().address, guardKey.address)).toBe("other");
    expect(regularKeyState(guardKey.address, null)).toBe("other");
  });
  it("key file helpers: the address parser never touches the seed line, the seed parser only the seed", () => {
    const text = formatRegularKeyEnv(guardKey.seed as string, guardKey.address);
    expect(parseRegularKeyAddress(text)).toBe(guardKey.address);
    expect(parseRegularKeySeed(text)).toBe(guardKey.seed);
    expect(String(parseRegularKeyAddress(text))).not.toContain(guardKey.seed as string);
    expect(parseRegularKeyAddress("XRPL_REGULAR_KEY_SEED=abc")).toBeNull();
    expect(parseRegularKeySeed("garbage")).toBeNull();
  });
});

describe("owner key script process", () => {
  it("refuses a non-Testnet network before reading any seed and never prints the seed", () => {
    const sentinel = Wallet.generate().seed as string;
    const run = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "owner-key.ts"), "set", "--confirm"], {
      cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH ?? "", Path: process.env.Path ?? "", SystemRoot: process.env.SystemRoot ?? "", XRPL_NETWORK: "xrpl-mainnet", OWNER_TREASURY_MASTER_SEED: sentinel },
    });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toMatch(/Refusing to operate/);
    expect(`${run.stdout}${run.stderr}`).not.toContain(sentinel);
  }, 90_000);
  it("refuses to run without a subcommand", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "owner-key.ts")], {
      cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH ?? "", Path: process.env.Path ?? "", SystemRoot: process.env.SystemRoot ?? "" },
    });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toMatch(/Usage/);
  }, 90_000);
});
