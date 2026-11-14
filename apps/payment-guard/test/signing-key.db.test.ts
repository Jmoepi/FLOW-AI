import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decode } from "xrpl";
import { verifyAuditChain } from "@flow-ai/database";
import { attemptWalletColumnUpdate, auditEventTypes, latestRegularKeyState, maxLastLedgerSequence, paymentSummaries, setWalletSigningKeyModeAs, walletSigningKeyMode } from "@flow-ai/database/testing";
import { pollBalances } from "../src/jobs/balance-poller";
import { requestPayment } from "../src/services/payments";
import { createSigningKeyHealth } from "../src/state/signing-key";
import { assertNoLeaks, createHarness, key, type Harness } from "./db-harness";

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ regularKey: true });
});
afterEach(async () => {
  await h.close();
});

const readyz = async () => {
  const res = await h.guard.app.inject({ method: "GET", url: "/readyz" });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
};
const walletMode = (id: string): Promise<string> => walletSigningKeyMode(h.db.adminPool, id);
const walletEvents = async (id: string): Promise<string[]> => auditEventTypes(h.db.adminPool, id);

describe("regular key signing through the guard (M7, 10.8)", () => {
  it("signs with the regular key, never the master: SigningPubKey is the regular key and the env holds no master seed", async () => {
    expect(h.env.XRPL_DEMO_SIGNER_SEED).toBeUndefined();
    const s = await h.scenario({ dailyLimit: "10" });
    const invoice = await h.invoice(s, { amount: "1" });
    const res = await h.post(invoice, key("rk"));
    expect(res.body).toMatchObject({ status: "validated" });
    expect(h.ledger.submits).toHaveLength(1);
    const decoded = decode(h.ledger.submits[0]?.blob as string) as unknown as { Account: string; SigningPubKey: string };
    expect(decoded.Account).toBe(h.wallet.address);
    expect(decoded.SigningPubKey).toBe(h.regularWallet?.publicKey);
    expect(decoded.SigningPubKey).not.toBe(h.wallet.publicKey);
    expect(await assertNoLeaks(h)).toEqual([]);
  });
});

describe("revoked regular key: fail closed (M7, 10.6, 19.2 tefBAD_AUTH)", () => {
  it("FAILED with SIGNING_KEY_REVOKED, hold released, invoice open, wallet revoked, audit event, readiness degraded, chain intact", async () => {
    h.ledger.mode = "reject_auth";
    const s = await h.scenario({ dailyLimit: "10" });
    const invoice = await h.invoice(s, { amount: "1" });
    const res = await h.post(invoice, key("rev"));
    expect(res.body).toMatchObject({ status: "failed", failure_code: "SIGNING_KEY_REVOKED" });
    const [row] = await paymentSummaries(h.db.adminPool, s.businessId);
    expect(row).toMatchObject({ status: "failed", reservation: "released", invoice_status: "open", result_code: "tefBAD_AUTH", signed_blob_present: false });
    expect(await walletMode(s.walletId)).toBe("revoked");
    expect(await auditEventTypes(h.db.adminPool, row?.id as string)).toEqual(expect.arrayContaining(["payment.signed", "payment.submit_ack", "payment.signing_key_revoked"]));
    expect(await walletEvents(s.walletId)).toEqual(["signing_key.revoked"]);
    expect(await verifyAuditChain(h.db.guardPool, s.businessId)).toBe(true);
    const ready = await readyz();
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: "degraded", signing_key: "revoked" });
    const status = await h.get("/internal/status");
    expect(status.body).toMatchObject({ signing_key: "revoked", kill_switch: "disabled" });
    expect(await assertNoLeaks(h)).toEqual([]);
  });

  it("the next request is blocked and nothing is signed or submitted", async () => {
    h.ledger.mode = "reject_auth";
    const s = await h.scenario({ dailyLimit: "10" });
    const first = await h.invoice(s, { amount: "1" });
    await h.post(first, key("rev1"));
    const submitsAfterFirst = h.ledger.submits.length;
    expect(submitsAfterFirst).toBe(1);
    h.ledger.mode = "validate"; // even if the ledger would now accept: the guard must not try
    const second = await h.invoice(s, { amount: "1" });
    const res = await h.post(second, key("rev2"));
    expect(res.body).toMatchObject({ status: "blocked", failure_code: "EXECUTION_DISABLED", tx_hash: null });
    expect(h.ledger.submits).toHaveLength(submitsAfterFirst);
  });

  it("a reserved but unsigned payment is cancelled with SIGNING_KEY_REVOKED and never signed", async () => {
    const s = await h.scenario({ dailyLimit: "10" });
    const invoice = await h.invoice(s, { amount: "1" });
    const reserved = await requestPayment(h.reserveOnlyDeps, { invoice_id: invoice, idempotency_key: key("pre") }, randomUUID());
    expect(reserved.body.status).toBe("reserved");
    await h.signingKey.markRevoked({ id: s.walletId, business_id: s.businessId }, { paymentId: reserved.body.payment_id as string, engineResult: "tefBAD_AUTH" });
    const out = await h.executor.execute(reserved.body.payment_id as string);
    expect(out).toMatchObject({ status: "cancelled", failure_code: "SIGNING_KEY_REVOKED" });
    expect(h.ledger.submits).toHaveLength(0);
  });

  it("the revoked state survives a restart (hydrated from the database)", async () => {
    h.ledger.mode = "reject_auth";
    const s = await h.scenario({ dailyLimit: "10" });
    await h.post(await h.invoice(s, { amount: "1" }), key("rev"));
    const restarted = createSigningKeyHealth({ pool: h.db.guardPool, config: h.config, env: () => h.env, logger: h.deps.logger });
    expect(restarted.status(h.env).blocked).toBe(false); // before hydrate
    await restarted.hydrate();
    expect(restarted.status(h.env)).toEqual({ mode: "revoked", blocked: true });
    expect(restarted.blocked({ PAYMENT_EXECUTION_ENABLED: "true" })).toBe(true); // fail closed even if the regular key variable is removed
  });

  it("a pending payment whose resubmit is refused (reconciler) fails and flips the guard to revoked", async () => {
    h.ledger.mode = "throw"; // the first submit never reached the network
    const s = await h.scenario({ dailyLimit: "10" });
    await h.post(await h.invoice(s, { amount: "1" }), key("rec"));
    h.ledger.known.clear();
    h.ledger.mode = "reject_auth"; // the owner revoked the key meanwhile
    await h.reconciler.runOnce();
    const [row] = await paymentSummaries(h.db.adminPool, s.businessId);
    expect(row).toMatchObject({ status: "failed", reservation: "released", invoice_status: "open" });
    expect(await walletMode(s.walletId)).toBe("revoked");
    expect(await walletEvents(s.walletId)).toEqual(["signing_key.revoked"]);
    expect((await readyz()).status).toBe(503);
    expect(await verifyAuditChain(h.db.guardPool, s.businessId)).toBe(true);
  });
  it("records exactly one revoked audit event per episode", async () => {
    const s = await h.scenario({ dailyLimit: "10" });
    const w = { id: s.walletId, business_id: s.businessId };
    await h.signingKey.markRevoked(w, { paymentId: randomUUID(), engineResult: "tefBAD_AUTH" });
    await h.signingKey.markRevoked(w, { paymentId: randomUUID(), engineResult: "tefBAD_AUTH" });
    expect(await walletEvents(s.walletId)).toEqual(["signing_key.revoked"]);
  });

  it("the database refuses jumps outside master_env -> regular_key -> revoked -> regular_key", async () => {
    const s = await h.scenario({});
    const set = (mode: string) => setWalletSigningKeyModeAs(h.db.guardPool, s.walletId, mode);
    await expect(set("revoked")).rejects.toThrow(/not allowed/);
    await set("regular_key");
    await set("revoked");
    await expect(set("master_env")).rejects.toThrow(/not allowed/);
    await set("regular_key");
    expect(await walletMode(s.walletId)).toBe("regular_key");
  });

  it("the guard role cannot change any other wallet column", async () => {
    const s = await h.scenario({});
    await expect(attemptWalletColumnUpdate(h.db.guardPool, s.walletId, "address")).rejects.toThrow(/permission denied/);
    await expect(attemptWalletColumnUpdate(h.db.guardPool, s.walletId, "is_active")).rejects.toThrow(/permission denied/);
  });
});

describe("balance poller observes the RegularKey and restores (M7)", () => {
  const latest = (walletId: string) => latestRegularKeyState(h.db.adminPool, walletId);

  it("writes active / not_set / other from the ledger and moves master_env to regular_key when the key is registered", async () => {
    const s = await h.scenario({});
    await pollBalances(h.deps);
    expect(await latest(s.walletId)).toBe("not_set");
    h.ledger.regularKey = h.regularWallet?.address ?? null;
    await pollBalances(h.deps);
    expect(await latest(s.walletId)).toBe("active");
    expect(await walletMode(s.walletId)).toBe("regular_key");
    h.ledger.regularKey = h.wallet.address; // some other address
    await pollBalances(h.deps);
    expect(await latest(s.walletId)).toBe("other");
  });

  it("writes not_configured when the guard has no regular key (dev/master mode)", async () => {
    const master = await createHarness();
    try {
      const s = await master.scenario({});
      master.ledger.regularKey = h.wallet.address;
      await pollBalances(master.deps);
      expect(await latestRegularKeyState(master.db.adminPool, s.walletId)).toBe("not_configured");
    } finally {
      await master.close();
    }
  });

  it("never flips to revoked from a missing RegularKey alone (only a ledger rejection does)", async () => {
    const s = await h.scenario({});
    h.ledger.regularKey = null;
    await pollBalances(h.deps);
    expect(await walletMode(s.walletId)).toBe("master_env");
    expect(h.signingKey.status(h.env).blocked).toBe(false);
  });

  it("restores only when the configured key is registered AND the rejected blob can no longer validate", async () => {
    h.ledger.mode = "reject_auth";
    const s = await h.scenario({ dailyLimit: "10" });
    await h.post(await h.invoice(s, { amount: "1" }), key("rev"));
    expect(await walletMode(s.walletId)).toBe("revoked");
    const lls = await maxLastLedgerSequence(h.db.adminPool, s.walletId);

    // Ledger still shows no key: no restore.
    await pollBalances(h.deps);
    expect(await walletMode(s.walletId)).toBe("revoked");
    // A different key registered: no restore.
    h.ledger.regularKey = h.wallet.address;
    h.ledger.ledgerIndexOverride = lls + 5;
    await pollBalances(h.deps);
    expect(await walletMode(s.walletId)).toBe("revoked");
    // The configured key is registered but the rejected blob could still validate: no restore.
    h.ledger.regularKey = h.regularWallet?.address ?? null;
    h.ledger.ledgerIndexOverride = lls;
    await pollBalances(h.deps);
    expect(await walletMode(s.walletId)).toBe("revoked");
    expect((await readyz()).status).toBe(503);
    // Registered and the blob has expired: restored, audited, ready again.
    h.ledger.ledgerIndexOverride = lls + 1;
    await pollBalances(h.deps);
    expect(await walletMode(s.walletId)).toBe("regular_key");
    expect(await walletEvents(s.walletId)).toEqual(["signing_key.revoked", "signing_key.restored"]);
    expect(await readyz()).toMatchObject({ status: 200, body: { status: "ok", signing_key: "regular_key" } });
    expect(await verifyAuditChain(h.db.guardPool, s.businessId)).toBe(true);
  });

  it("skips a failing poll and logs it without secrets", async () => {
    await h.scenario({});
    h.deps.gateway.getAccountSnapshot = () => Promise.reject(new Error(`boom ${h.regularWallet?.seed as string}`));
    expect(await pollBalances(h.deps)).toBe(0);
    expect(h.logs.join("\n")).not.toContain(h.regularWallet?.seed as string);
  });
});
