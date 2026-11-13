import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing";
import {
  DbError, getPayment, getPaymentByIdempotencyKey, insertPayment, insertReservation, listPayments, lockPaymentsAwaitingOutcome,
  lockPolicyForUpdate, lockStaleUnsignedPayments, settleReservation, sumInFlightReserved, transitionPayment, uuid, withTransaction,
} from "../src";
import { CURRENCY_HEX, ISSUER, TX_HASH, addr, makeBusiness, makeInvoice, makePayment, paymentAt, reserve, sqlState, type Fixture, type PaymentState } from "./helpers";

let db: TestDatabase;
let fx: Fixture;

beforeAll(async () => {
  db = await createTestDatabase();
  fx = await makeBusiness(db.adminPool, "3");
});
afterAll(async () => {
  await db.drop();
});

const STATES: PaymentState[] = ["requested", "blocked", "reserved", "submitted", "pending_confirmation", "validated", "failed", "cancelled"];
const LEGAL = new Set([
  "requested>blocked", "requested>reserved", "requested>cancelled", "reserved>submitted", "reserved>cancelled",
  "submitted>validated", "submitted>failed", "submitted>pending_confirmation", "pending_confirmation>validated", "pending_confirmation>failed",
]);
const TERMINAL = new Set(["blocked", "validated", "failed", "cancelled"]);

describe("payment state machine in the database (PG-3)", () => {
  it("full transition matrix: legal pairs pass, every other pair is rejected (guard role)", async () => {
    const results: string[] = [];
    for (const from of STATES) {
      for (const to of STATES) {
        if (from === to) continue;
        const p = await paymentAt(db.adminPool, fx, from);
        const outcome = await sqlState(
          db.guardPool.query(
            "UPDATE payments SET status = $2, tx_hash = COALESCE(tx_hash, $3), last_ledger_sequence = COALESCE(last_ledger_sequence, 100), failure_code = COALESCE(failure_code, 'TEST_CODE') WHERE id = $1",
            [p.id, to, TX_HASH],
          ),
        );
        const legal = LEGAL.has(`${from}>${to}`);
        if (legal) expect(outcome, `${from}>${to}`).toBe("ok");
        else expect(outcome, `${from}>${to}`).toBe("55000");
        results.push(`${from}>${to}:${outcome}`);
      }
    }
    expect(results.length).toBe(56);
  });

  it("terminal rows are immutable for every column the guard may update", async () => {
    for (const s of ["blocked", "validated", "failed", "cancelled"] as const) {
      const p = await paymentAt(db.adminPool, fx, s);
      expect(TERMINAL.has(s)).toBe(true);
      expect(await sqlState(db.guardPool.query("UPDATE payments SET result_code = 'tesSUCCESS' WHERE id = $1", [p.id])), s).toBe("55000");
      expect(await sqlState(db.guardPool.query("UPDATE payments SET updated_at = now() WHERE id = $1", [p.id])), s).toBe("55000");
    }
  });

  it("tx_hash and last_ledger_sequence are write-once", async () => {
    const p = await paymentAt(db.adminPool, fx, "submitted");
    expect(await sqlState(db.guardPool.query("UPDATE payments SET tx_hash = $2 WHERE id = $1", [p.id, "B".repeat(64)]))).toBe("55000");
    expect(await sqlState(db.guardPool.query("UPDATE payments SET tx_hash = NULL WHERE id = $1", [p.id]))).toBe("55000");
    expect(await sqlState(db.guardPool.query("UPDATE payments SET last_ledger_sequence = 101 WHERE id = $1", [p.id]))).toBe("55000");
    // Re-writing the same value is harmless.
    expect(await sqlState(db.guardPool.query("UPDATE payments SET tx_hash = $2 WHERE id = $1", [p.id, TX_HASH]))).toBe("ok");
  });

  it("immutable payment columns cannot change even for the owner", async () => {
    const p = await paymentAt(db.adminPool, fx, "reserved");
    for (const col of ["amount = 5", "destination_address = 'r11111111111111111111111111'", "idempotency_key = 'changed-key-0001'", "invoice_id = gen_random_uuid()", "business_date = current_date + 1"]) {
      const code = await sqlState(db.adminPool.query(`UPDATE payments SET ${col} WHERE id = $1`, [p.id]));
      expect(["55000", "23503"], col).toContain(code);
    }
  });

  it("a payment can only be created as requested or blocked, without signing data", async () => {
    const inv = await makeInvoice(db.adminPool, fx);
    const base = `INSERT INTO payments (business_id, invoice_id, supplier_id, wallet_id, network, asset_currency, asset_issuer, amount, destination_address, status, policy_version, idempotency_key, request_hash, business_date`;
    const vals = [fx.businessId, inv, fx.supplierId, fx.walletId, CURRENCY_HEX, ISSUER, addr(2)];
    for (const st of ["reserved", "submitted", "validated", "failed", "cancelled", "pending_confirmation"]) {
      const code = await sqlState(
        db.adminPool.query(`${base}) VALUES ($1,$2,$3,$4,'xrpl-testnet',$5,$6,1,$7,'${st}',1,'key-${st}-0001','${"c".repeat(64)}',current_date)`, vals),
      );
      expect(code, st).toBe("55000");
    }
  });

  it("reservations only move reserved -> committed|released, then are frozen", async () => {
    const p = await paymentAt(db.adminPool, fx, "reserved", { amount: "0.5" });
    await reserve(db.adminPool, fx, p.id, "0.5");
    expect(await sqlState(db.guardPool.query("UPDATE daily_spend_reservations SET status = 'committed' WHERE payment_id = $1", [p.id]))).toBe("ok");
    for (const to of ["released", "reserved"]) {
      expect(await sqlState(db.guardPool.query("UPDATE daily_spend_reservations SET status = $2 WHERE payment_id = $1", [p.id, to])), to).toBe("55000");
    }
    const q = await paymentAt(db.adminPool, fx, "reserved", { amount: "0.5" });
    await reserve(db.adminPool, fx, q.id, "0.5");
    expect(await sqlState(db.guardPool.query("UPDATE daily_spend_reservations SET status = 'released' WHERE payment_id = $1", [q.id]))).toBe("ok");
    expect(await sqlState(db.guardPool.query("UPDATE daily_spend_reservations SET status = 'committed' WHERE payment_id = $1", [q.id]))).toBe("55000");
  });
});

describe("daily cap enforced by trigger, not by the app (PG-2)", () => {
  it("rejects overspend and stays within the cap under concurrency", async () => {
    const cap = await makeBusiness(db.adminPool, "3");
    const payments = [];
    for (let i = 0; i < 8; i++) payments.push(await paymentAt(db.adminPool, cap, "reserved"));
    const results = await Promise.all(
      payments.map((p) =>
        sqlState(db.guardPool.query("INSERT INTO daily_spend_reservations (business_id, business_date, payment_id, amount, status) VALUES ($1, current_date, $2, 1, 'reserved')", [cap.businessId, p.id])),
      ),
    );
    expect(results.filter((r) => r === "ok").length).toBe(3);
    expect(results.filter((r) => r === "23514").length).toBe(5);
    const sum = await db.adminPool.query<{ s: string }>("SELECT sum(amount)::text AS s FROM daily_spend_reservations WHERE business_id = $1 AND status IN ('reserved','committed')", [cap.businessId]);
    expect(Number(sum.rows[0]?.s)).toBeLessThanOrEqual(3);
  });
  it("released holds free capacity; committed holds do not", async () => {
    const cap = await makeBusiness(db.adminPool, "2");
    const a = await paymentAt(db.adminPool, cap, "reserved");
    const b = await paymentAt(db.adminPool, cap, "reserved");
    const c = await paymentAt(db.adminPool, cap, "reserved");
    await reserve(db.adminPool, cap, a.id, "1");
    await reserve(db.adminPool, cap, b.id, "1");
    expect(await sqlState(reserve(db.adminPool, cap, c.id, "1"))).toBe("23514");
    await db.adminPool.query("UPDATE daily_spend_reservations SET status = 'released' WHERE payment_id = $1", [a.id]);
    expect(await sqlState(reserve(db.adminPool, cap, c.id, "1"))).toBe("ok");
    await db.adminPool.query("UPDATE daily_spend_reservations SET status = 'committed' WHERE payment_id = $1", [b.id]);
    const d = await paymentAt(db.adminPool, cap, "reserved", { amount: "0.000001" });
    expect(await sqlState(reserve(db.adminPool, cap, d.id, "0.000001"))).toBe("23514");
  });
  it("requires a matching reserved payment and a policy", async () => {
    const p = await paymentAt(db.adminPool, fx, "requested");
    expect(await sqlState(reserve(db.adminPool, fx, p.id, "1"))).toBe("55000");
    const q = await paymentAt(db.adminPool, fx, "reserved", { amount: "1" });
    expect(await sqlState(reserve(db.adminPool, fx, q.id, "0.5"))).toBe("55000");
  });
});

describe("CHECK constraints on money and shapes (G-4)", () => {
  it("reject negative, over-precise, NaN, oversize, zero payment amounts and bad hashes", async () => {
    for (const bad of ["-1", "1.0000001", "NaN", "1e-7", "1000000000000", "0"]) {
      expect(await sqlState(db.adminPool.query("INSERT INTO invoices (business_id, supplier_id, invoice_number, amount, issue_date, due_date) VALUES ($1,$2,$3,$4,current_date,current_date)", [fx.businessId, fx.supplierId, `X-${bad}`, bad])), `invoice ${bad}`).toBe("23514");
    }
    for (const bad of ["-1", "1.0000001", "NaN"]) {
      expect(await sqlState(db.adminPool.query("UPDATE treasury_policies SET daily_spend_limit = $2 WHERE business_id = $1", [fx.businessId, bad])), `policy ${bad}`).toBe("23514");
      expect(await sqlState(db.adminPool.query("INSERT INTO balance_snapshots (wallet_id, rlusd_balance, xrp_balance) VALUES ($1,$2,1)", [fx.walletId, bad])), `snapshot ${bad}`).toBe("23514");
    }
    const p = await paymentAt(db.adminPool, fx, "reserved");
    expect(await sqlState(db.adminPool.query("UPDATE payments SET status='submitted', tx_hash = 'abc', last_ledger_sequence = 1 WHERE id = $1", [p.id]))).toBe("23514");
    expect(await sqlState(db.adminPool.query("UPDATE payments SET status='submitted', tx_hash = $2 WHERE id = $1", [p.id, TX_HASH]))).toBe("23514"); // hash without LastLedgerSequence
  });
  it("enforce testnet-only network, 280-char reason, and blob lifecycle", async () => {
    const inv = await makeInvoice(db.adminPool, fx);
    const ins = (network: string, reason: string) =>
      db.adminPool.query(
        `INSERT INTO payments (business_id, invoice_id, supplier_id, wallet_id, network, asset_currency, asset_issuer, amount, destination_address, status, policy_version, idempotency_key, request_hash, agent_reason, business_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,'requested',1,$9,$10,$11,current_date)`,
        [fx.businessId, inv, fx.supplierId, fx.walletId, network, CURRENCY_HEX, ISSUER, addr(2), `k-${network}-${String(reason.length)}`, "d".repeat(64), reason],
      );
    expect(await sqlState(ins("xrpl-mainnet", "ok"))).toBe("23514");
    expect(await sqlState(ins("xrpl-testnet", "x".repeat(281)))).toBe("23514");
    expect(await sqlState(ins("xrpl-testnet", "x".repeat(280)))).toBe("ok");
    expect(await sqlState(db.adminPool.query("UPDATE treasury_wallets SET network = 'xrpl-mainnet'"))).toBe("23514");
  });
  it("the repo layer rejects what the database would silently accept (1e5 is a valid numeric to Postgres)", async () => {
    const inv = await makeInvoice(db.adminPool, fx);
    const base = { business_id: fx.businessId, invoice_id: inv, supplier_id: fx.supplierId, wallet_id: fx.walletId, network: "xrpl-testnet", asset_currency: CURRENCY_HEX, asset_issuer: ISSUER, destination_address: addr(2), status: "requested" as const, policy_version: 1, request_hash: "e".repeat(64), business_date: "2026-01-01" };
    for (const amount of ["1e5", "-1", "1.0000001", "NaN", ""]) {
      await expect(insertPayment(db.guardPool, { ...base, idempotency_key: "key-money-0001", amount })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });
});

describe("uniqueness (PG-3)", () => {
  it("idempotency key is unique within a business, not across businesses", async () => {
    const other = await makeBusiness(db.adminPool);
    await makePayment(db.adminPool, fx, { key: "idem-key-shared-1" });
    expect(await sqlState(makePayment(db.adminPool, fx, { key: "idem-key-shared-1" }))).toBe("23505");
    expect(await sqlState(makePayment(db.adminPool, other, { key: "idem-key-shared-1" }))).toBe("ok");
  });
  it("only one active payment per invoice; failed/cancelled/blocked do not hold the slot", async () => {
    const inv = await makeInvoice(db.adminPool, fx);
    const first = await makePayment(db.adminPool, fx, { invoiceId: inv });
    expect(await sqlState(makePayment(db.adminPool, fx, { invoiceId: inv }))).toBe("23505");
    await db.adminPool.query("UPDATE payments SET status = 'cancelled' WHERE id = $1", [first.id]);
    expect(await sqlState(makePayment(db.adminPool, fx, { invoiceId: inv }))).toBe("ok");
    const blocked = await makeInvoice(db.adminPool, fx);
    await makePayment(db.adminPool, fx, { invoiceId: blocked, status: "blocked" });
    expect(await sqlState(makePayment(db.adminPool, fx, { invoiceId: blocked }))).toBe("ok");
  });
  it("20 concurrent requests for the same invoice create exactly one payment", async () => {
    const inv = await makeInvoice(db.adminPool, fx);
    const out = await Promise.all(Array.from({ length: 20 }, () => sqlState(makePayment(db.adminPool, fx, { invoiceId: inv }))));
    expect(out.filter((r) => r === "ok").length).toBe(1);
    expect(out.filter((r) => r === "23505").length).toBe(19);
  });
  it("a payment cannot reference another business's invoice, supplier or wallet", async () => {
    const other = await makeBusiness(db.adminPool);
    const inv = await makeInvoice(db.adminPool, other);
    expect(await sqlState(makePayment(db.adminPool, fx, { invoiceId: inv }))).toBe("23503");
  });
});

describe("repository layer (IN-1, IN-2)", () => {
  it("rejects injection strings used as ids before any query runs", async () => {
    for (const bad of ["x'; DROP TABLE payments; --", "1 OR 1=1", "' OR ''='"]) {
      await expect(getPayment(db.guardPool, bad)).rejects.toBeInstanceOf(DbError);
      await expect(listPayments(db.guardPool, { invoiceId: bad })).rejects.toMatchObject({ code: "INVALID_ID" });
      expect(() => uuid(bad)).toThrow(DbError);
    }
    const count = await db.adminPool.query("SELECT count(*)::int AS n FROM payments");
    expect(count.rows[0].n).toBeGreaterThan(0);
  });
  it("treats injection strings in text parameters as literal data", async () => {
    const evil = "'; DROP TABLE payments; --";
    expect(await getPaymentByIdempotencyKey(db.guardPool, fx.businessId, evil)).toBeNull();
    const inv = await makeInvoice(db.adminPool, fx);
    await expect(insertPayment(db.guardPool, { business_id: fx.businessId, invoice_id: inv, supplier_id: fx.supplierId, wallet_id: fx.walletId, network: "xrpl-testnet", asset_currency: CURRENCY_HEX, asset_issuer: ISSUER, destination_address: addr(2), status: "requested", policy_version: 1, idempotency_key: evil, request_hash: "f".repeat(64), amount: "1", business_date: "2026-01-01" })).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
    const ok = await insertPayment(db.guardPool, { business_id: fx.businessId, invoice_id: inv, supplier_id: fx.supplierId, wallet_id: fx.walletId, network: "xrpl-testnet", asset_currency: CURRENCY_HEX, asset_issuer: ISSUER, destination_address: addr(2), status: "requested", policy_version: 1, idempotency_key: "key-inject-0001", request_hash: "f".repeat(64), amount: "1", business_date: "2026-01-01", agent_reason: evil });
    expect((await getPayment(db.guardPool, ok.id))?.agent_reason).toBe(evil);
  });
  it("maps errors to stable codes with no SQL text", async () => {
    const p = await paymentAt(db.adminPool, fx, "requested");
    const err = await transitionPayment(db.guardPool, p.id, "requested", "validated").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("STATE_VIOLATION");
    expect((err as DbError).message).not.toMatch(/UPDATE|payments|SELECT/);
  });
  it("runs the happy path with money as strings, blob cleared on the final outcome", async () => {
    const f = await makeBusiness(db.adminPool, "4");
    const inv = await makeInvoice(db.adminPool, f, "1.2");
    const p = await insertPayment(db.guardPool, { business_id: f.businessId, invoice_id: inv, supplier_id: f.supplierId, wallet_id: f.walletId, network: "xrpl-testnet", asset_currency: CURRENCY_HEX, asset_issuer: ISSUER, destination_address: addr(2), status: "requested", policy_version: 1, idempotency_key: "key-happy-0001", request_hash: "a".repeat(64), amount: "1.2", business_date: "2026-01-01" });
    expect(p.amount).toBe("1.2");
    expect(p.status).toBe("requested");
    await transitionPayment(db.guardPool, p.id, "requested", "reserved");
    const r = await insertReservation(db.guardPool, { business_id: f.businessId, business_date: "2026-01-01", payment_id: p.id, amount: "1.2" });
    expect(r.status).toBe("reserved");
    expect(await sumInFlightReserved(db.guardPool, f.businessId)).toBe("1.2");
    const sub = await transitionPayment(db.guardPool, p.id, "reserved", "submitted", { tx_hash: TX_HASH, last_ledger_sequence: 120, first_ledger_sequence: 100, signed_blob: "DEADBEEF", submitted_at: true });
    expect(sub?.signed_blob).toBe("DEADBEEF");
    expect(sub?.submitted_at).not.toBeNull();
    // Reconciler sees it; stale sweeper does not (it has a hash).
    expect((await withTransaction(db.guardPool, (c) => lockPaymentsAwaitingOutcome(c, 50))).some((x) => x.id === p.id)).toBe(true);
    expect((await withTransaction(db.guardPool, (c) => lockStaleUnsignedPayments(c, 1, 50))).some((x) => x.id === p.id)).toBe(false);
    const done = await transitionPayment(db.guardPool, p.id, "submitted", "validated", { ledger_index: 110, result_code: "tesSUCCESS", delivered_amount: "1.2", fee_drops: "12", validated_at: true });
    expect(done?.status).toBe("validated");
    expect(done?.signed_blob).toBeNull();
    expect(done?.delivered_amount).toBe("1.2");
    expect(done?.fee_drops).toBe("12");
    expect(await transitionPayment(db.guardPool, p.id, "submitted", "failed")).toBeNull(); // lost the race: no overwrite
    expect((await settleReservation(db.guardPool, p.id, "committed"))?.status).toBe("committed");
    expect(await settleReservation(db.guardPool, p.id, "released")).toBeNull();
    expect(await sumInFlightReserved(db.guardPool, f.businessId)).toBe("0");
  });
  it("sweeper selection returns only hashless unsigned payments past the timeout", async () => {
    const f = await makeBusiness(db.adminPool);
    const stale = await paymentAt(db.adminPool, f, "reserved");
    const signed = await paymentAt(db.adminPool, f, "submitted");
    await db.adminPool.query("ALTER TABLE payments DISABLE TRIGGER payments_guard_transition");
    await db.adminPool.query("UPDATE payments SET updated_at = now() - interval '1 hour' WHERE id = ANY($1)", [[stale.id, signed.id]]);
    await db.adminPool.query("ALTER TABLE payments ENABLE TRIGGER payments_guard_transition");
    const rows = await withTransaction(db.guardPool, (c) => lockStaleUnsignedPayments(c, 300, 100));
    expect(rows.map((r) => r.id)).toContain(stale.id);
    expect(rows.map((r) => r.id)).not.toContain(signed.id);
  });
  it("lockPolicyForUpdate serialises concurrent decision transactions per business", async () => {
    const f = await makeBusiness(db.adminPool);
    const order: string[] = [];
    const a = withTransaction(db.guardPool, async (c) => {
      await lockPolicyForUpdate(c, f.businessId);
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 400));
      order.push("a-end");
    });
    await new Promise((r) => setTimeout(r, 100));
    const b = withTransaction(db.guardPool, async (c) => {
      await lockPolicyForUpdate(c, f.businessId);
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});
