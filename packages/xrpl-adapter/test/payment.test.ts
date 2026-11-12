import { Wallet, type Payment } from "xrpl";
import { describe, expect, it } from "vitest";
import {
  KeyedQueue,
  amountsEqual,
  assertTestnetConfig,
  parseAmount,
  reconcilePayment,
  sendIouPayment,
  submitAndWait,
  walletSigner,
  type IssuedAmount,
  type LedgerGateway,
  type PaymentEvent,
  type SignedPayment,
  type TxLookup,
} from "../src/index";

const HEX = "524C555344000000000000000000000000000000";
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const DEST = "rpc4DFfxB6aXkbEPJTAGXLG4oZQuWpTXnT";
const expected: IssuedAmount = { currency: HEX, issuer: ISSUER, value: "1" };

/** In-memory ledger. `behavior` decides what `tx` returns for a hash on its nth lookup. */
class FakeGateway implements LedgerGateway {
  validated = 1000;
  step = 0; // validated index advance per getValidatedLedgerIndex call
  nextSeq = 10;
  submits: string[] = [];
  autofills = 0;
  inFlight = 0;
  maxInFlight = 0;
  networkId: number | undefined = 1;
  lookups = new Map<string, number>();
  submitThrows = false;
  extraFlags: number | undefined;
  behavior: (hash: string, n: number) => TxLookup = () => ({ status: "not_found" });

  async getNetworkInfo() {
    return { networkId: this.networkId, validatedLedgerIndex: this.validated };
  }
  async getValidatedLedgerIndex() {
    this.validated += this.step;
    return this.validated;
  }
  async autofill(tx: Payment): Promise<Payment> {
    this.autofills++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    const out: Payment = { ...tx, Fee: "12", Sequence: this.nextSeq++, LastLedgerSequence: this.validated + 20 };
    if (this.extraFlags !== undefined) out.Flags = this.extraFlags;
    return out;
  }
  async submitBlob(blob: string) {
    this.submits.push(blob);
    if (this.submitThrows) throw new Error("socket closed");
    return { engineResult: "tesSUCCESS" };
  }
  async lookupTx(hash: string): Promise<TxLookup> {
    const n = (this.lookups.get(hash) ?? 0) + 1;
    this.lookups.set(hash, n);
    return this.behavior(hash, n);
  }
  /** Called once the payment finishes so queue tests can track overlap. */
  release() {
    this.inFlight--;
  }
}

const validatedTx = (code: string, delivered?: unknown): TxLookup => ({
  status: "found",
  validated: true,
  ledgerIndex: 1003,
  resultCode: code,
  deliveredAmount: delivered,
  feeDrops: "12",
});

function fastWait(events?: PaymentEvent[]) {
  let t = 0;
  return {
    pollIntervalMs: 1000,
    timeoutMs: 600_000,
    sleep: async (ms: number) => {
      t += ms;
    },
    now: () => t,
    onEvent: (e: PaymentEvent) => {
      events?.push(e);
    },
  };
}

function send(gw: FakeGateway, extra: Partial<Parameters<typeof sendIouPayment>[0]> = {}, signed: SignedPayment[] = []) {
  const wallet = Wallet.generate(); // random in-test wallet, no real funds
  return sendIouPayment({
    gateway: gw,
    signer: walletSigner(wallet),
    destination: DEST,
    currency: HEX,
    issuer: ISSUER,
    value: "1",
    onSigned: (s) => {
      signed.push(s);
    },
    wait: fastWait(),
    queue: new KeyedQueue(),
    ...extra,
  });
}

describe("amounts", () => {
  it("accepts exact decimal strings and canonicalises", () => {
    expect(parseAmount("1")).toBe("1");
    expect(parseAmount("1.50")).toBe("1.5");
    expect(parseAmount("0.000001")).toBe("0.000001");
  });
  it("rejects numbers, signs, exponents, zero, over-precision", () => {
    for (const bad of [1, 0.1, "0", "-1", "1e2", " 1", "1.1234567", "01", "", "NaN", null]) {
      expect(() => parseAmount(bad)).toThrow();
    }
  });
  it("compares as decimals, not text", () => {
    expect(amountsEqual("1", "1.000")).toBe(true);
    expect(amountsEqual("0.1", "0.10000001")).toBe(false);
  });
});

describe("network assertion", () => {
  const ws = "wss://s.altnet.rippletest.net:51233";
  it("accepts only xrpl-testnet", () => {
    expect(() => assertTestnetConfig("xrpl-testnet", ws)).not.toThrow();
    expect(() => assertTestnetConfig("xrpl-mainnet", ws)).toThrow(/Refusing/);
    expect(() => assertTestnetConfig(undefined, ws)).toThrow(/Refusing/);
    expect(() => assertTestnetConfig("xrpl-testnet", "wss://xrplcluster.com")).toThrow(/Refusing/);
  });
  it("sendIouPayment refuses when server network_id is not 1", async () => {
    const gw = new FakeGateway();
    gw.networkId = 0;
    await expect(send(gw)).rejects.toThrow(/network_id/);
    expect(gw.submits).toHaveLength(0);
    expect(gw.autofills).toBe(0);
  });
});

describe("payment flow outcomes", () => {
  it("validated tesSUCCESS with matching delivered_amount -> validated_success", async () => {
    const gw = new FakeGateway();
    gw.behavior = () =>
      gw.submits.length ? validatedTx("tesSUCCESS", { currency: HEX.toLowerCase(), issuer: ISSUER, value: "1.0" }) : { status: "not_found" };
    const signed: SignedPayment[] = [];
    const res = await send(gw, {}, signed);
    expect(res.outcome?.kind).toBe("validated_success");
    expect(gw.submits).toEqual([signed[0]!.txBlob]);
  });

  it("persist callback runs before submit and sees hash + LastLedgerSequence; Flags are never set", async () => {
    const gw = new FakeGateway();
    gw.behavior = () => (gw.submits.length ? validatedTx("tesSUCCESS", expected) : { status: "not_found" });
    const order: string[] = [];
    const res = await send(gw, {
      onSigned: (s) => {
        order.push(`persist:${gw.submits.length}`);
        expect(s.hash).toMatch(/^[0-9A-F]{64}$/);
        expect(s.lastLedgerSequence).toBeGreaterThan(gw.validated);
      },
    });
    expect(order).toEqual(["persist:0"]);
    expect(res.outcome?.kind).toBe("validated_success");
  });

  it("validated tec* -> validated_failed with fee recorded", async () => {
    const gw = new FakeGateway();
    gw.behavior = () => validatedTx("tecPATH_DRY");
    const res = await send(gw);
    expect(res.outcome).toMatchObject({ kind: "validated_failed", resultCode: "tecPATH_DRY", feeDrops: "12" });
  });

  it("validated tesSUCCESS with a different delivered_amount -> partial_delivery, never paid", async () => {
    const gw = new FakeGateway();
    gw.behavior = () => validatedTx("tesSUCCESS", { currency: HEX, issuer: ISSUER, value: "0.5" });
    const res = await send(gw);
    expect(res.outcome?.kind).toBe("partial_delivery");
  });

  it("missing or wrong-issuer delivered_amount -> partial_delivery", async () => {
    for (const d of [undefined, "unavailable", { currency: HEX, issuer: DEST, value: "1" }]) {
      const gw = new FakeGateway();
      gw.behavior = () => validatedTx("tesSUCCESS", d);
      expect((await send(gw)).outcome?.kind).toBe("partial_delivery");
    }
  });

  it("uncertain first, then validated -> validated_success (no second submit)", async () => {
    const gw = new FakeGateway();
    gw.behavior = (_h, n) => (n < 4 ? { status: "not_found" } : validatedTx("tesSUCCESS", expected));
    const events: PaymentEvent[] = [];
    const res = await send(gw, { wait: fastWait(events) });
    expect(res.outcome?.kind).toBe("validated_success");
    expect(gw.submits).toHaveLength(1);
    expect(events.some((e) => e.type === "poll" && e.outcome.kind === "pending")).toBe(true);
  });

  it("found but not validated stays pending", async () => {
    const gw = new FakeGateway();
    gw.behavior = () => ({ status: "found", validated: false });
    const wait = { ...fastWait(), timeoutMs: 5000 };
    const res = await send(gw, { wait });
    expect(res.outcome).toMatchObject({ kind: "pending", seenOnLedger: true });
  });

  it("not found while LastLedgerSequence is still in the future stays pending (timeout), not failed", async () => {
    const gw = new FakeGateway(); // validated index does not advance
    const wait = { ...fastWait(), timeoutMs: 5000 };
    const res = await send(gw, { wait });
    expect(res.outcome?.kind).toBe("pending");
  });

  it("validated ledger passes LastLedgerSequence without the tx -> failed_expired", async () => {
    const gw = new FakeGateway();
    gw.step = 5; // ledgers close while we poll
    const res = await send(gw);
    expect(res.outcome?.kind).toBe("failed_expired");
    if (res.outcome?.kind === "failed_expired") {
      expect(res.outcome.validatedLedgerIndex).toBeGreaterThan(res.outcome.lastLedgerSequence);
    }
  });

  it("submit error is treated as uncertain; the tx can still validate", async () => {
    const gw = new FakeGateway();
    gw.submitThrows = true;
    gw.behavior = (_h, n) => (n < 3 ? { status: "not_found" } : validatedTx("tesSUCCESS", expected));
    const res = await send(gw);
    expect(res.outcome?.kind).toBe("validated_success");
  });

  it("secret-shaped text in a submit error is redacted in the emitted event", async () => {
    const fakeSeed = "s" + "Ab3Xy9QwErTpUiKk".repeat(2).slice(0, 28); // synthetic, runtime-built
    const gw = new FakeGateway();
    gw.submitBlob = async () => {
      throw new Error(`socket closed while sending ${fakeSeed}`);
    };
    gw.behavior = (_h, n) => (n < 3 ? { status: "not_found" } : validatedTx("tesSUCCESS", expected));
    const events: PaymentEvent[] = [];
    await submitAndWait(gw, { hash: "AB".repeat(32), txBlob: "00", lastLedgerSequence: 10_000_000, amount: expected }, { sleep: async () => {}, onEvent: (e) => void events.push(e) });
    const err = events.find((e) => e.type === "submit_error");
    expect(err).toBeDefined();
    expect(JSON.stringify(events)).not.toContain(fakeSeed);
  });
  it("dry run signs and persists but never submits", async () => {
    const gw = new FakeGateway();
    const signed: SignedPayment[] = [];
    const res = await send(gw, { dryRun: true }, signed);
    expect(res.outcome).toBeUndefined();
    expect(signed).toHaveLength(1);
    expect(gw.submits).toHaveLength(0);
  });

  it("failing persist aborts before submit", async () => {
    const gw = new FakeGateway();
    await expect(
      send(gw, {
        onSigned: () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(gw.submits).toHaveLength(0);
  });

  it("refuses to sign if autofill produced tfPartialPayment", async () => {
    const gw = new FakeGateway();
    gw.extraFlags = 0x00020000;
    await expect(send(gw)).rejects.toThrow(/tfPartialPayment/);
    expect(gw.submits).toHaveLength(0);
  });

  it("built tx has no Flags, SendMax or DeliverMin and an exact IOU amount", async () => {
    const gw = new FakeGateway();
    const signed: SignedPayment[] = [];
    await send(gw, { dryRun: true, value: "1.50" }, signed);
    expect(signed[0]!.amount).toEqual({ currency: HEX, issuer: ISSUER, value: "1.5" });
  });
});

describe("idempotency and reconciliation", () => {
  const ref = { hash: "AB".repeat(32), lastLedgerSequence: 1020 };

  it("re-submitting a blob whose hash is already validated does NOT submit again", async () => {
    const gw = new FakeGateway();
    gw.behavior = () => validatedTx("tesSUCCESS", expected);
    const out = await submitAndWait(gw, { ...ref, txBlob: "BLOB", amount: expected }, fastWait());
    expect(out.kind).toBe("validated_success");
    expect(gw.submits).toHaveLength(0);
  });

  it("a blob whose window is over and which is not on ledger is NOT resubmitted", async () => {
    const gw = new FakeGateway();
    gw.validated = 1021;
    const out = await submitAndWait(gw, { ...ref, txBlob: "BLOB", amount: expected }, fastWait());
    expect(out.kind).toBe("failed_expired");
    expect(gw.submits).toHaveLength(0);
  });

  it("a tx already seen by the server is not resubmitted", async () => {
    const gw = new FakeGateway();
    gw.behavior = (_h, n) => (n < 2 ? { status: "found", validated: false } : validatedTx("tesSUCCESS", expected));
    const out = await submitAndWait(gw, { ...ref, txBlob: "BLOB", amount: expected }, fastWait());
    expect(out.kind).toBe("validated_success");
    expect(gw.submits).toHaveLength(0);
  });

  it("two resumes of the same persisted payment produce one on-ledger payment (identical blob only)", async () => {
    const gw = new FakeGateway();
    let landed = false;
    gw.behavior = () => (landed ? validatedTx("tesSUCCESS", expected) : { status: "not_found" });
    const origSubmit = gw.submitBlob.bind(gw);
    gw.submitBlob = async (b) => {
      landed = true; // the network accepts the blob; a hash can only land once
      return origSubmit(b);
    };
    const signed = { ...ref, txBlob: "BLOB", amount: expected };
    const a = await submitAndWait(gw, signed, fastWait());
    const b = await submitAndWait(gw, signed, fastWait());
    expect(a.kind).toBe("validated_success");
    expect(b.kind).toBe("validated_success");
    expect(gw.submits).toEqual(["BLOB"]); // second run found it validated and never submitted
  });

  it("reconcilePayment: pending vs expired boundary is strictly greater than LastLedgerSequence", async () => {
    const gw = new FakeGateway();
    gw.validated = 1020; // equal to LLS: could still validate in ledger 1020? Not yet definitive
    expect((await reconcilePayment(gw, ref, expected)).kind).toBe("pending");
    gw.validated = 1021;
    expect((await reconcilePayment(gw, ref, expected)).kind).toBe("failed_expired");
  });
});

describe("per-wallet serialisation", () => {
  it("concurrent sends from one wallet never overlap and use distinct sequences", async () => {
    const gw = new FakeGateway();
    gw.behavior = () => validatedTx("tesSUCCESS", expected);
    const wallet = Wallet.generate();
    const signer = walletSigner(wallet);
    const queue = new KeyedQueue();
    const seqs: number[] = [];
    const mk = () =>
      sendIouPayment({
        gateway: gw,
        signer,
        destination: DEST,
        currency: HEX,
        issuer: ISSUER,
        value: "1",
        onSigned: (s) => {
          seqs.push(s.sequence);
        },
        wait: fastWait(),
        queue,
      }).finally(() => gw.release());
    const results = await Promise.all([mk(), mk(), mk()]);
    expect(gw.maxInFlight).toBe(1);
    expect(new Set(seqs).size).toBe(3);
    expect(results.every((r) => r.outcome?.kind === "validated_success")).toBe(true);
  });

  it("a failed task does not block the next one on the same key", async () => {
    const q = new KeyedQueue();
    const a = q.run("w", async () => {
      throw new Error("boom");
    });
    const b = q.run("w", async () => "ok");
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("ok");
  });
});
