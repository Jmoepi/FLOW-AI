import { Wallet, type SubmittableTransaction } from "xrpl";
import { describe, expect, it } from "vitest";
import { submitAccountTxAndWait, type AccountTxGateway, type TxLookup } from "../src/index";

const account = Wallet.generate();
const tx = (): SubmittableTransaction => ({ TransactionType: "SetRegularKey", Account: account.address, RegularKey: Wallet.generate().address });

class Gw implements AccountTxGateway {
  validated = 1000;
  networkId: number | undefined = 1;
  submits: string[] = [];
  ack = "tesSUCCESS";
  lookup: (n: number) => TxLookup = () => ({ status: "not_found" });
  private lookups = 0;
  async getNetworkInfo() {
    return { networkId: this.networkId, validatedLedgerIndex: this.validated };
  }
  async getValidatedLedgerIndex() {
    return this.validated;
  }
  async autofill(): Promise<never> {
    throw new Error("payments only");
  }
  async autofillTx(t: SubmittableTransaction): Promise<SubmittableTransaction> {
    return { ...t, Fee: "12", Sequence: 7, LastLedgerSequence: this.validated + 20 };
  }
  async submitBlob(blob: string) {
    this.submits.push(blob);
    return { engineResult: this.ack };
  }
  async lookupTx(): Promise<TxLookup> {
    return this.lookup(++this.lookups);
  }
}
const fast = () => {
  let t = 0;
  return { pollIntervalMs: 1000, timeoutMs: 5000, sleep: async (ms: number) => void (t += ms), now: () => t };
};
const found = (code: string, validated = true): TxLookup => ({ status: "found", validated, ledgerIndex: 1003, resultCode: code, feeDrops: "12" });

describe("submitAccountTxAndWait (validated-result semantics)", () => {
  it("validated tesSUCCESS -> validated_success", async () => {
    const gw = new Gw();
    gw.lookup = () => found("tesSUCCESS");
    expect(await submitAccountTxAndWait(gw, account, tx(), fast())).toMatchObject({ kind: "validated_success", ledgerIndex: 1003 });
    expect(gw.submits).toHaveLength(1);
  });
  it("a preliminary tesSUCCESS ack is never success until validated", async () => {
    const gw = new Gw();
    gw.lookup = () => found("tesSUCCESS", false);
    expect((await submitAccountTxAndWait(gw, account, tx(), fast())).kind).toBe("pending");
  });
  it("validated tec -> validated_failed", async () => {
    const gw = new Gw();
    gw.lookup = () => found("tecNO_PERMISSION");
    expect(await submitAccountTxAndWait(gw, account, tx(), fast())).toMatchObject({ kind: "validated_failed", resultCode: "tecNO_PERMISSION" });
  });
  it("tefBAD_AUTH at submit -> rejected, nothing polled", async () => {
    const gw = new Gw();
    gw.ack = "tefBAD_AUTH";
    gw.lookup = () => {
      throw new Error("must not poll");
    };
    expect(await submitAccountTxAndWait(gw, account, tx(), fast())).toMatchObject({ kind: "rejected", engineResult: "tefBAD_AUTH" });
  });
  it("expiry is only declared with proven history", async () => {
    const gw = new Gw();
    gw.lookup = () => {
      gw.validated = 2000;
      return { status: "not_found", searchedAll: false };
    };
    expect((await submitAccountTxAndWait(gw, account, tx(), fast())).kind).toBe("pending");
    const gw2 = new Gw();
    gw2.lookup = () => {
      gw2.validated = 2000;
      return { status: "not_found", searchedAll: true };
    };
    expect((await submitAccountTxAndWait(gw2, account, tx(), fast())).kind).toBe("failed_expired");
  });
  it("refuses a server that is not Testnet (network_id 1) before signing anything", async () => {
    const gw = new Gw();
    gw.networkId = 0;
    await expect(submitAccountTxAndWait(gw, account, tx(), fast())).rejects.toThrow(/network_id/);
    expect(gw.submits).toHaveLength(0);
  });
});
