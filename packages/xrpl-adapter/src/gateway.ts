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

export type TxLookup =
  | { status: "not_found" }
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
  lookupTx(hash: string): Promise<TxLookup>;
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
export class XrplGateway implements LedgerGateway {
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

  async lookupTx(hash: string): Promise<TxLookup> {
    await this.ensureConnected();
    try {
      const r = (await this.client.request({ command: "tx", transaction: hash })).result as unknown as {
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
      if (errorCode(err) === "txnNotFound") return { status: "not_found" };
      throw err;
    }
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
