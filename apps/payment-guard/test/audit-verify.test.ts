import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACK_ENV, createAuditIntegrity } from "../src/jobs/audit-verify";
import { killSwitchValue } from "../src/services/payments";
import { createLogger } from "../src/logger";
import { loadConfig } from "../src/config";
import { validEnv } from "./helpers";

const db = vi.hoisted(() => ({ ids: [] as string[], broken: new Set<string>(), fail: false }));
vi.mock("@flow-ai/database", () => ({
  listBusinessIds: () => (db.fail ? Promise.reject(new Error("db down postgres://u:secretpw@h/d")) : Promise.resolve(db.ids)),
  verifyAuditChain: (_q: unknown, id: string) => Promise.resolve(!db.broken.has(id)),
}));

const A = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
const B = "4a2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6c";
let lines: string[];
let env: NodeJS.ProcessEnv;
const make = (over: Record<string, string | undefined> = {}) =>
  createAuditIntegrity({ pool: {} as never, config: loadConfig(validEnv(over)), env: () => env, logger: createLogger((l) => lines.push(l)) });

beforeEach(() => {
  db.ids = [A, B];
  db.broken = new Set();
  db.fail = false;
  lines = [];
  env = { PAYMENT_EXECUTION_ENABLED: "true" };
});

describe("audit chain verify job (AL-3)", () => {
  it("starts unverified and not blocked, then reports ok", async () => {
    const m = make();
    expect(m.status(env)).toEqual({ state: "unverified", last_checked_at: null, blocked: false });
    const s = await m.runOnce();
    expect(s.state).toBe("ok");
    expect(s.blocked).toBe(false);
    expect(s.last_checked_at).not.toBeNull();
  });
  it("a break sets broken, logs audit.chain_broken with counts only, and blocks execution", async () => {
    const m = make();
    db.broken.add(B);
    const s = await m.runOnce();
    expect(s).toMatchObject({ state: "broken", blocked: true });
    const log = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === "audit.chain_broken");
    expect(log).toMatchObject({ level: "error", businesses_checked: 2, businesses_broken: 1 });
    expect(lines.join("\n")).not.toContain(A);
    expect(lines.join("\n")).not.toContain(B);
    expect(killSwitchValue({ env: () => env, integrity: m })).not.toBe("true");
  });
  it("stays blocked on later passing-looking ticks until acknowledged, and the break id is stable", async () => {
    const m = make();
    db.broken.add(A);
    await m.runOnce();
    const id = m.breakId();
    await m.runOnce();
    expect(m.breakId()).toBe(id);
    expect(m.blocked(env)).toBe(true);
    env = { ...env, [ACK_ENV]: "brk-wrong" };
    expect(m.blocked(env)).toBe(true);
  });
  it("only the exact break id acknowledges; execution is then allowed but the state stays broken", async () => {
    const m = make();
    db.broken.add(A);
    await m.runOnce();
    env = { ...env, [ACK_ENV]: m.breakId() ?? "x" };
    const s = await m.runOnce();
    expect(s).toMatchObject({ state: "broken", blocked: false });
    expect(killSwitchValue({ env: () => env, integrity: m })).toBe("true");
    expect(lines.some((l) => l.includes("audit.chain_break_acknowledged"))).toBe(true);
  });
  it("an old acknowledgement does not cover a new break", async () => {
    const m = make();
    db.broken.add(A);
    await m.runOnce();
    const first = m.breakId() ?? "";
    env = { ...env, [ACK_ENV]: first };
    db.broken.clear();
    expect((await m.runOnce()).state).toBe("ok");
    db.broken.add(A);
    expect((await m.runOnce()).blocked).toBe(true);
    expect(m.breakId()).not.toBe(first);
  });
  it("a verification error is not a break, is logged redacted, and does not clear an existing break", async () => {
    const m = make();
    db.fail = true;
    expect((await m.runOnce())).toMatchObject({ state: "error", blocked: false });
    expect(lines.join("\n")).not.toContain("secretpw");
    db.fail = false;
    db.broken.add(A);
    await m.runOnce();
    db.fail = true;
    expect((await m.runOnce())).toMatchObject({ state: "broken", blocked: true });
  });
  it("verifies only the pinned business when GUARD_BUSINESS_ID is set", async () => {
    const m = make({ GUARD_BUSINESS_ID: A });
    db.broken.add(B);
    expect((await m.runOnce()).state).toBe("ok");
  });
  it("the kill switch value passes through when nothing is broken", async () => {
    const m = make();
    await m.runOnce();
    expect(killSwitchValue({ env: () => env, integrity: m })).toBe("true");
    expect(killSwitchValue({ env: () => ({}), integrity: m })).toBeUndefined();
  });
});
