import { randomUUID } from "node:crypto";
import type { PaymentRow } from "@flow-ai/database";
import type { GuardLedgerGateway, LedgerRange, SubmitAck, TxLookup } from "@flow-ai/xrpl-adapter";
import { Wallet } from "xrpl";

export const CURRENCY_HEX = "524C555344000000000000000000000000000000";
export const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
/** Fake secrets and addresses are generated at runtime (G-8). */
export const SENDER = Wallet.generate();
export const DESTINATION = Wallet.generate().address;
export const TX_HASH = "A".repeat(64);
export const BLOB = "DEADBEEF".repeat(8);

export function paymentRow(over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: randomUUID(), business_id: randomUUID(), invoice_id: randomUUID(), supplier_id: randomUUID(), wallet_id: randomUUID(), network: "xrpl-testnet",
    asset_currency: CURRENCY_HEX, asset_issuer: ISSUER, amount: "1", destination_address: DESTINATION, status: "reserved", policy_version: 1,
    idempotency_key: "key-0000001", request_hash: "0".repeat(64), tx_hash: null, last_ledger_sequence: null, first_ledger_sequence: null,
    ledger_index: null, result_code: null, delivered_amount: null, fee_drops: null, failure_code: null, failure_message: null, agent_reason: null,
    signed_blob: null, previous_payment_id: null, business_date: "2026-01-01", requested_at: new Date(0).toISOString(), submitted_at: null,
    validated_at: null, updated_at: new Date(0).toISOString(), ...over,
  };
}

export const submittedRow = (over: Partial<PaymentRow> = {}): PaymentRow =>
  paymentRow({ status: "submitted", tx_hash: TX_HASH, last_ledger_sequence: 120, first_ledger_sequence: 100, signed_blob: BLOB, ...over });

export interface FakeLedger {
  validated: number;
  lookup: (hash: string, range?: LedgerRange) => TxLookup;
  complete: LedgerRange[];
  submits: string[];
}
/** Scriptable gateway. Only the methods the reconciler touches are real. */
export function fakeGateway(f: FakeLedger): GuardLedgerGateway {
  return {
    getNetworkInfo: () => Promise.resolve({ networkId: 1, validatedLedgerIndex: f.validated }),
    getValidatedLedgerIndex: () => Promise.resolve(f.validated),
    lookupTx: (hash: string, range?: LedgerRange) => Promise.resolve(f.lookup(hash, range)),
    getCompleteLedgers: () => Promise.resolve(f.complete),
    submitBlob: (blob: string): Promise<SubmitAck> => {
      f.submits.push(blob);
      return Promise.resolve({ engineResult: "tesSUCCESS" });
    },
  } as unknown as GuardLedgerGateway;
}

export const validatedTx = (code: string, delivered: unknown): TxLookup => ({ status: "found", validated: true, ledgerIndex: 110, resultCode: code, deliveredAmount: delivered, feeDrops: "12" });
export const notFound = (searchedAll?: boolean): TxLookup => ({ status: "not_found", ...(searchedAll === undefined ? {} : { searchedAll }) });
