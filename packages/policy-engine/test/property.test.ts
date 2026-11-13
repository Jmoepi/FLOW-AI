import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src";
import { make } from "./helpers";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Determinism and speed: every random draw comes from the seeded PRNG above (no Math.random, no clock), the iteration
 * count is fixed, and per-iteration verdicts are checked with plain comparisons whose first failing cases are reported
 * once (tens of thousands of vitest expect() calls were part of what made this test slow in a parallel full run). The
 * explicit timeout is generous so CPU contention in `pnpm test` cannot turn a slow machine into a false failure; it
 * does not change what is proven.
 */
const ITERATIONS = 3000;
const TIMEOUT_MS = 120_000;
const UNIT = 1_000_000n; // micro-units: 6 decimals
const toStr = (u: bigint): string => {
  const whole = u / UNIT;
  const frac = (u % UNIT).toString().padStart(6, "0");
  return `${whole}.${frac}`;
};

describe("property: the engine never allows a breach (seeded)", () => {
  for (const seed of [1, 42, 2026, 90210]) {
    it(`seed ${seed}`, () => {
      const next = rng(seed);
      const pick = (max: bigint): bigint => BigInt(Math.floor(next() * Number(max)));
      // Mix wide random values with values hugging the boundaries.
      const near = (center: bigint): bigint => {
        const delta = BigInt(Math.floor(next() * 5) - 2);
        const v = center + delta;
        return v < 0n ? 0n : v;
      };
      let allowedCount = 0;
      let blockedCount = 0;
      const violations: string[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const cap = pick(500n * UNIT);
        const daily = pick(1000n * UNIT);
        const reserve = pick(600n * UNIT);
        const balance = pick(2000n * UNIT);
        const nRes = Number(pick(4n));
        const rows = Array.from({ length: nRes }, () => ({
          amount: pick(400n * UNIT),
          status: (["reserved", "committed", "released"] as const)[Number(pick(3n))]!,
          today: next() < 0.8,
        }));
        const spent = rows.filter((r) => r.today && r.status !== "released").reduce((s, r) => s + r.amount, 0n);
        const mode = Number(pick(4n));
        const amount =
          mode === 0 ? near(cap) : mode === 1 ? near(daily - spent) : mode === 2 ? near(balance - reserve) : pick(700n * UNIT);

        const d = evaluatePolicy(
          make((r) => {
            r.policy.max_payment_amount = toStr(cap);
            r.policy.daily_spend_limit = toStr(daily);
            r.policy.minimum_reserve = toStr(reserve);
            r.balances.rlusd_balance = toStr(balance);
            r.invoice.amount = toStr(amount);
            r.reservations = rows.map((x, k) => ({
              payment_id: `p${k}`,
              business_date: x.today ? "2026-03-10" : "2026-03-09",
              amount: toStr(x.amount),
              status: x.status,
            }));
          }),
        );

        // Independent bigint oracle.
        const ok = amount > 0n && amount <= cap && spent + amount <= daily && amount <= balance && balance - amount >= reserve;
        if (d.allowed) {
          allowedCount++;
          // Safety: an allowed decision never breaches any limit.
          if (!(amount > 0n && amount <= cap && spent + amount <= daily && balance - amount >= reserve)) violations.push(`breach at i=${String(i)}`);
        } else {
          blockedCount++;
        }
        // Completeness on the same facts: the engine agrees with the oracle exactly.
        if (d.allowed !== ok) violations.push(`oracle mismatch at i=${String(i)} (engine ${String(d.allowed)}, oracle ${String(ok)})`);
      }
      expect(violations.slice(0, 5)).toEqual([]);
      expect(allowedCount).toBeGreaterThan(100);
      expect(blockedCount).toBeGreaterThan(100);
    }, TIMEOUT_MS);
  }

  it("never allows when any non-money gate is closed, whatever the amounts", () => {
    const next = rng(7);
    const gates: Array<(r: ReturnType<typeof make>) => void> = [
      (r) => { r.policy.enabled = false; },
      (r) => { r.kill_switch_value = "TRUE"; },
      (r) => { r.policy.valid_until = "2026-03-10T08:00:00Z"; },
      (r) => { r.supplier.is_approved = false; },
      (r) => { r.destination_trustline = "unknown"; },
      (r) => { r.config.network = "xrpl-mainnet"; },
    ];
    for (let i = 0; i < 500; i++) {
      const gate = gates[Math.floor(next() * gates.length)]!;
      const d = evaluatePolicy(make((r) => { r.invoice.amount = toStr(BigInt(1 + Math.floor(next() * 100)) * UNIT); gate(r); }));
      expect(d.allowed).toBe(false);
    }
  }, TIMEOUT_MS);
});
