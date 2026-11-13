import { redactError } from "@flow-ai/contracts";
import { Client, isValidClassicAddress, type Payment } from "xrpl";

export const TESTNET_NETWORK = "xrpl-testnet";
export const TESTNET_NETWORK_ID = 1;

/** The only WebSocket endpoints that may be used. Exact string match: no other host, port, path, query or userinfo. */
export const ALLOWED_TESTNET_WS_URLS: readonly string[] = ["wss://s.altnet.rippletest.net:51233"];

/** Mainnet RLUSD issuer (docs/m0-notes.md). It must never be configured here. */
export const MAINNET_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

/** Spec 10.1: refuse unless the network name is exactly "xrpl-testnet" and the URL is on the Testnet allowlist. Fail closed. */
export function assertTestnetConfig(network: string | undefined, wsUrl: string | undefined): void {
  if (network !== TESTNET_NETWORK) {
    throw new Error(`Refusing to operate: XRPL_NETWORK must be exactly "${TESTNET_NETWORK}" (got ${JSON.stringify(network ?? null)}).`);
  }
  assertAllowedTestnetUrl(wsUrl);
}

/** The URL value is deliberately not echoed: it may carry credentials. */
export function assertAllowedTestnetUrl(wsUrl: string | undefined): void {
  const allowed = typeof wsUrl === "string" && ALLOWED_TESTNET_WS_URLS.includes(wsUrl);
  let clean = false;
  if (allowed) {
    try {
      const u = new URL(wsUrl);
      clean = u.protocol === "wss:" && u.username === "" && u.password === "" && u.search === "" && u.hash === "";
    } catch {
      clean = false;
    }
  }
  if (!allowed || !clean) {
    throw new Error(`Refusing to operate: XRPL_WS_URL is not on the Testnet allowlist (${ALLOWED_TESTNET_WS_URLS.join(", ")}).`);
  }
}

/** Rejects an RLUSD asset pair that is malformed or uses the Mainnet issuer. */
export function assertTestnetAsset(issuer: string | undefined, currencyHex: string | undefined): void {
  if (typeof issuer !== "string" || !isValidClassicAddress(issuer)) {
    throw new Error("Refusing to operate: RLUSD issuer is missing or not a valid classic address.");
  }
  if (issuer === MAINNET_RLUSD_ISSUER) {
    throw new Error("Refusing to operate: the configured RLUSD issuer is the Mainnet issuer. Testnet only.");
  }
  if (typeof currencyHex !== "string" || !/^[0-9A-F]{40}$/.test(currencyHex)) {
    throw new Error("Refusing to operate: RLUSD currency must be a 40-character uppercase hex code.");
  }
}

/** Connects a raw xrpl Client and verifies server network_id === 1; disconnects and throws otherwise. */
export async function connectTestnetClient(network: string | undefined, wsUrl: string | undefined): Promise<Client> {
  assertTestnetConfig(network, wsUrl);
  const client = new Client(wsUrl as string, { timeout: 20_000, connectionTimeout: 10_000 });
  await client.connect();
  try {
    const id = (await client.request({ command: "server_info" })).result.info.network_id;
    if (id !== TESTNET_NETWORK_ID) throw new Error(`Refusing to operate: server network_id is ${String(id)}, expected ${TESTNET_NETWORK_ID} (Testnet).`);
  } catch (err) {
    await client.disconnect();
    throw err;
  }
  return client;
}

export interface NetworkInfo {
  networkId: number | undefined;
  validatedLedgerIndex: number;
}

export interface LedgerRange {
  minLedger: number;
  maxLedger: number;
}

export type TxLookup =
  | {
      status: "not_found";
      /** True only when the server confirmed it searched every ledger in the requested range (rippled `searched_all`). */
      searchedAll?: boolean | undefined;
    }
  | {
      status: "found";
      validated: boolean;
      ledgerIndex?: number | undefined;
      resultCode?: string | undefined;
      /** meta.delivered_amount (or DeliveredAmount) exactly as the server returned it. */
      deliveredAmount?: unknown;
      feeDrops?: string | undefined;
    };

export interface SubmitAck {
  engineResult: string;
  engineResultMessage?: string;
  accepted?: boolean;
}

/** Everything the payment flow needs from the ledger. Tests mock this; production uses XrplGateway. */
export interface LedgerGateway {
  getNetworkInfo(): Promise<NetworkInfo>;
  getValidatedLedgerIndex(): Promise<number>;
  autofill(tx: Payment): Promise<Payment>;
  submitBlob(txBlob: string): Promise<SubmitAck>;
  lookupTx(hash: string, range?: LedgerRange): Promise<TxLookup>;
}

export interface AccountSnapshot {
  /** XRP balance in drops, as a decimal string. */
  xrpDrops: string;
  ownerCount: number;
  /** RLUSD balance on the trust line to the issuer, or null when there is none. */
  rlusdBalance: string | null;
  /** Validated ledger the snapshot was read from. */
  ledgerIndex: number;
}

export interface Reserves {
  baseReserveDrops: string;
  ownerReserveDrops: string;
}

export type TrustLineState = "present" | "absent" | "unknown";

/** Inclusive ledger ranges the server holds, from server_info.complete_ledgers. */
export type CompleteLedgers = LedgerRange[];

/** Extra reads the payment guard needs. Kept separate so existing LedgerGateway mocks keep compiling. */
export interface GuardLedgerGateway extends LedgerGateway {
  getAccountSnapshot(account: string, issuer: string, currencyHex: string): Promise<AccountSnapshot>;
  getReserves(): Promise<Reserves>;
  getDestinationTrustLine(destination: string, issuer: string, currencyHex: string): Promise<TrustLineState>;
  getCompleteLedgers(): Promise<CompleteLedgers>;
}

export function isGuardLedgerGateway(gw: LedgerGateway): gw is GuardLedgerGateway {
  return typeof (gw as Partial<GuardLedgerGateway>).getCompleteLedgers === "function";
}

/** Parses "100-200,205,300-400" (or "empty") into ranges. Malformed input yields no ranges (fail closed). */
export function parseCompleteLedgers(value: string | undefined): CompleteLedgers {
  if (typeof value !== "string") return [];
  const out: CompleteLedgers = [];
  for (const part of value.split(",")) {
    const text = part.trim();
    if (text === "empty") continue;
    const bounds = text.split("-");
    if (bounds.length > 2 || !bounds.every((b) => /^\d{1,15}$/.test(b))) return [];
    const lo = Number(bounds[0]);
    const hi = Number(bounds[bounds.length - 1]);
    if (hi < lo) return [];
    out.push({ minLedger: lo, maxLedger: hi });
  }
  return out;
}

/** True when ONE contiguous range covers every ledger in [minLedger, maxLedger]. */
export function rangesCover(ranges: CompleteLedgers, minLedger: number, maxLedger: number): boolean {
  return ranges.some((r) => r.minLedger <= minLedger && r.maxLedger >= maxLedger);
}

export interface GatewayOptions {
  wsUrl: string;
  /** Request timeout (ms). */
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  connectAttempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } }).data?.error;
}

/** Thin wrapper over xrpl.js Client with timeouts, connect retries and reconnect-on-use. */
export class XrplGateway implements GuardLedgerGateway {
  private constructor(
    private readonly client: Client,
    private readonly opts: Required<GatewayOptions>,
  ) {}

  /** Connects and asserts the server really is Testnet (network_id 1). */
  static async connect(network: string | undefined, options: GatewayOptions): Promise<XrplGateway> {
    assertTestnetConfig(network, options.wsUrl);
    const opts: Required<GatewayOptions> = {
      timeoutMs: 20_000,
      connectionTimeoutMs: 10_000,
      connectAttempts: 3,
      ...options,
    };
    const client = new Client(opts.wsUrl, { timeout: opts.timeoutMs, connectionTimeout: opts.connectionTimeoutMs });
    const gw = new XrplGateway(client, opts);
    await gw.ensureConnected();
    const info = await gw.getNetworkInfo();
    if (info.networkId !== TESTNET_NETWORK_ID) {
      await gw.disconnect();
      throw new Error(`Refusing to operate: server network_id is ${String(info.networkId)}, expected ${TESTNET_NETWORK_ID} (Testnet).`);
    }
    return gw;
  }

  async disconnect(): Promise<void> {
    if (this.client.isConnected()) await this.client.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isConnected()) return;
    let last: unknown;
    for (let attempt = 1; attempt <= this.opts.connectAttempts; attempt++) {
      try {
        await this.client.connect();
        return;
      } catch (err) {
        last = err;
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
    throw new Error(`Could not connect to ${this.opts.wsUrl} after ${this.opts.connectAttempts} attempts: ${redactError(last)}`);
  }

  async getNetworkInfo(): Promise<NetworkInfo> {
    await this.ensureConnected();
    const info = (await this.client.request({ command: "server_info" })).result.info;
    return { networkId: info.network_id, validatedLedgerIndex: info.validated_ledger?.seq ?? 0 };
  }

  async getValidatedLedgerIndex(): Promise<number> {
    await this.ensureConnected();
    const res = await this.client.request({ command: "ledger", ledger_index: "validated" });
    return Number(res.result.ledger_index);
  }

  async autofill(tx: Payment): Promise<Payment> {
    await this.ensureConnected();
    return this.client.autofill(tx);
  }

  async submitBlob(txBlob: string): Promise<SubmitAck> {
    await this.ensureConnected();
    const r = (await this.client.request({ command: "submit", tx_blob: txBlob })).result;
    return { engineResult: r.engine_result, engineResultMessage: r.engine_result_message, accepted: r.accepted };
  }

  async lookupTx(hash: string, range?: LedgerRange): Promise<TxLookup> {
    await this.ensureConnected();
    try {
      const req = range
        ? { command: "tx" as const, transaction: hash, min_ledger: range.minLedger, max_ledger: range.maxLedger }
        : { command: "tx" as const, transaction: hash };
      const r = (await this.client.request(req)).result as unknown as {
        validated?: boolean;
        ledger_index?: number;
        meta?: { TransactionResult?: string; delivered_amount?: unknown; DeliveredAmount?: unknown } | string;
        tx_json?: { Fee?: string };
        Fee?: string;
      };
      const meta = typeof r.meta === "object" && r.meta !== null ? r.meta : undefined;
      return {
        status: "found",
        validated: r.validated === true,
        ledgerIndex: r.ledger_index,
        resultCode: meta?.TransactionResult,
        deliveredAmount: meta?.delivered_amount ?? meta?.DeliveredAmount,
        feeDrops: r.tx_json?.Fee ?? r.Fee,
      };
    } catch (err) {
      if (errorCode(err) === "txnNotFound") {
        const searched = (err as { data?: { searched_all?: unknown } }).data?.searched_all;
        return { status: "not_found", searchedAll: range !== undefined && searched === true };
      }
      throw err;
    }
  }

  async getAccountSnapshot(account: string, issuer: string, currencyHex: string): Promise<AccountSnapshot> {
    await this.ensureConnected();
    const info = (await this.client.request({ command: "account_info", account, ledger_index: "validated" })).result;
    const data = info.account_data;
    const rlusdBalance = await this.getIssuedBalance(account, issuer, currencyHex);
    return {
      xrpDrops: String(data.Balance),
      ownerCount: Number(data.OwnerCount),
      rlusdBalance,
      ledgerIndex: Number(info.ledger_index),
    };
  }

  async getReserves(): Promise<Reserves> {
    await this.ensureConnected();
    const state = (await this.client.request({ command: "server_state" })).result.state as unknown as {
      validated_ledger?: { reserve_base?: number; reserve_inc?: number };
    };
    const base = state.validated_ledger?.reserve_base;
    const inc = state.validated_ledger?.reserve_inc;
    if (!Number.isSafeInteger(base) || !Number.isSafeInteger(inc)) throw new Error("server_state did not report reserves");
    return { baseReserveDrops: String(base), ownerReserveDrops: String(inc) };
  }

  async getDestinationTrustLine(destination: string, issuer: string, currencyHex: string): Promise<TrustLineState> {
    try {
      return (await this.getIssuedBalance(destination, issuer, currencyHex)) === null ? "absent" : "present";
    } catch (err) {
      return errorCode(err) === "actNotFound" ? "absent" : "unknown";
    }
  }

  async getCompleteLedgers(): Promise<CompleteLedgers> {
    await this.ensureConnected();
    const info = (await this.client.request({ command: "server_info" })).result.info;
    return parseCompleteLedgers(info.complete_ledgers);
  }

  /**
   * RLUSD balance of `account` on its trust line to `issuer`, as an exact decimal string,
   * or null when no such trust line exists. Read from the validated ledger.
   */
  async getIssuedBalance(account: string, issuer: string, currencyHex: string): Promise<string | null> {
    await this.ensureConnected();
    const lines = (await this.client.request({ command: "account_lines", account, peer: issuer, ledger_index: "validated" })).result.lines;
    const line = lines.find((l) => l.account === issuer && l.currency.toUpperCase() === currencyHex.toUpperCase());
    if (!line) return null;
    // Balance is from the queried account's perspective (positive for a holder).
    return line.balance;
  }
}
