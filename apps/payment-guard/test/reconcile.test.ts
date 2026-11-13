import { describe, expect, it } from "vitest";
import { reconcileOne } from "../src/jobs/reconcile";
import { BLOB, CURRENCY_HEX, ISSUER, TX_HASH, fakeGateway, notFound, paymentRow, submittedRow, validatedTx, type FakeLedger } from "./payment-fixtures";

const delivered = (value = "1") => ({ currency: CURRENCY_HEX, issuer: ISSUER, value });
// Fake clock so the resubmit wait loop runs instantly.
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), timeoutMs: 3000, pollIntervalMs: 1000 };
};
const ledger = (over: Partial<FakeLedger> = {}): FakeLedger => ({ validated: 105, lookup: () => notFound(), complete: [], submits: [], ...over });
const run = (l: FakeLedger, p = submittedRow()) => reconcileOne({ gateway: fakeGateway(l) }, p, clock());

describe("reconciler decision table (10.3, F-19, PG-4)", () => {
  it("found + validated tesSUCCESS -> validated_success, nothing submitted", async () => {
    const l = ledger({ lookup: () => validatedTx("tesSUCCESS", delivered()) });
    expect((await run(l))?.outcome.kind).toBe("validated_success");
    expect(l.submits).toEqual([]);
  });

  it("found + validated tec -> validated_failed", async () => {
    const l = ledger({ lookup: () => validatedTx("tecPATH_DRY", undefined) });
    expect((await run(l))?.outcome.kind).toBe("validated_failed");
  });

  it("validated tesSUCCESS with a different delivered amount -> partial_delivery, never validated", async () => {
    const l = ledger({ lookup: () => validatedTx("tesSUCCESS", delivered("0.5")) });
    expect((await run(l))?.outcome.kind).toBe("partial_delivery");
  });

  it("seen on the ledger but not validated yet -> pending, no resubmit", async () => {
    const l = ledger({ lookup: () => ({ status: "found", validated: false }) });
    const r = await run(l);
    expect(r?.outcome.kind).toBe("pending");
    expect(r?.resubmitted).toBe(false);
    expect(l.submits).toEqual([]);
  });

  it("not found while LastLedgerSequence is in the future -> resubmits ONLY the stored identical blob", async () => {
    const l = ledger({ validated: 110 });
    const r = await run(l);
    expect(r?.resubmitted).toBe(true);
    expect(r?.outcome.kind).toBe("pending");
    expect(l.submits.length).toBeGreaterThan(0);
    expect(new Set(l.submits)).toEqual(new Set([BLOB]));
  });

  it("crash recovery: persisted blob is resubmitted, then the validated result is picked up (same hash)", async () => {
    let lookups = 0;
    const l = ledger({ validated: 110, lookup: () => (++lookups > 2 ? validatedTx("tesSUCCESS", delivered()) : notFound()) });
    const r = await run(l);
    expect(l.submits[0]).toBe(BLOB);
    expect(r?.outcome).toMatchObject({ kind: "validated_success", hash: TX_HASH });
  });

  it("never resubmits once LastLedgerSequence has passed", async () => {
    for (const validated of [120, 121, 500]) {
      const l = ledger({ validated, lookup: () => notFound(false) });
      const r = await run(l);
      expect(r?.resubmitted, `validated ${validated}`).toBe(false);
      expect(l.submits).toEqual([]);
    }
  });

  it("expired + history NOT proven complete (searchedAll false, gap) -> stays pending (the M1 caveat)", async () => {
    const l = ledger({ validated: 130, lookup: () => notFound(false), complete: [{ minLedger: 105, maxLedger: 200 }] });
    const r = await run(l);
    expect(r?.outcome.kind).toBe("pending");
    expect(r?.outcome).toMatchObject({ reason: expect.stringContaining("history incomplete") });
  });

  it("expired + searchedAll unknown and no coverage info -> pending (fail closed)", async () => {
    const l = ledger({ validated: 130, lookup: () => notFound() });
    expect((await run(l))?.outcome.kind).toBe("pending");
  });

  it("expired + server confirmed it searched every ledger -> failed_expired", async () => {
    const l = ledger({ validated: 130, lookup: () => notFound(true) });
    expect((await run(l))?.outcome.kind).toBe("failed_expired");
    expect(l.submits).toEqual([]);
  });

  it("expired + complete_ledgers covers [first, LLS + 1] -> failed_expired", async () => {
    const l = ledger({ validated: 130, lookup: () => notFound(), complete: [{ minLedger: 1, maxLedger: 500 }] });
    expect((await run(l))?.outcome.kind).toBe("failed_expired");
  });

  it("the lookup is bounded by [first_ledger_sequence, validated]", async () => {
    const ranges: unknown[] = [];
    const l = ledger({ validated: 130, lookup: (_h, range) => (ranges.push(range), notFound(true)) });
    await run(l);
    expect(ranges[0]).toEqual({ minLedger: 100, maxLedger: 130 });
  });

  it("skips a payment with no persisted hash", async () => {
    expect(await run(ledger(), paymentRow({ status: "reserved" }))).toBeNull();
  });

  it("does not resubmit when the blob is gone", async () => {
    const l = ledger({ validated: 110 });
    const r = await run(l, submittedRow({ signed_blob: null }));
    expect(r?.resubmitted).toBe(false);
    expect(l.submits).toEqual([]);
  });
});
