import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GuardInvoiceView, GuardPaymentView, GuardSnapshotView } from "@flow-ai/contracts";

export const TOKEN = "t".repeat(40);
export const INVOICE_ID = "6f1c1d0e-8b7a-4c1e-9a52-3d2f5b1a7c10";
export const RUN_ID = "7b1c1d0e-8b7a-4c1e-9a52-3d2f5b1a7c55";
export const PAYMENT_ID = "9a1c1d0e-8b7a-4c1e-9a52-3d2f5b1a7c99";

export interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export const snapshotView: GuardSnapshotView = {
  as_of: "2030-01-01T00:00:00Z",
  rlusd_balance: "100",
  minimum_reserve: "5",
  daily_remaining: "50",
  automation: "enabled",
  network: "testnet",
  stale: false,
};

export function invoiceView(over: Partial<GuardInvoiceView> = {}): GuardInvoiceView {
  return {
    invoice_id: INVOICE_ID,
    invoice_number: "INV-1",
    due_date: "2030-02-01",
    amount: "1",
    currency: "RLUSD",
    status: "open",
    supplier: { name: "Acme Ltd", country_code: "ZA", approved: true },
    description: "Office supplies",
    eligibility: { eligible: true, failed_checks: [], as_of: "2030-01-01T00:00:00Z", preview: true },
    ...over,
  };
}

export const paymentView: GuardPaymentView = {
  payment_id: PAYMENT_ID,
  status: "validated",
  amount: "1",
  tx_hash: "A".repeat(64),
  explorer_url: `https://testnet.xrpl.org/transactions/${"A".repeat(64)}`,
  failure_code: null,
  message: null,
  policy_decision: { decision_code: "ALLOWED", policy_version: 3 },
};

export interface FakeGuard {
  url: string;
  requests: RecordedRequest[];
  invoices: GuardInvoiceView[];
  paymentResponse: { status: number; body: unknown };
  /** Run-record behaviour: HTTP status for create / event append, and what the guard stored. */
  /** Body returned by the payment status reads (defaults to the validated payment). */
  statusView: GuardPaymentView;
  createRunStatus: number;
  /** When not 200, every GET read answers this status (4xx/5xx simulation). */
  readStatus: number;
  eventStatus: number;
  events: unknown[];
  finishes: unknown[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

/** A node:http stand-in for the payment guard. Records every request; the tests assert on what reached the wire. */
export async function startFakeGuard(): Promise<FakeGuard> {
  const state: FakeGuard = { url: "", requests: [], invoices: [invoiceView()], paymentResponse: { status: 200, body: paymentView }, statusView: paymentView, createRunStatus: 201, readStatus: 200, eventStatus: 201, events: [], finishes: [], close: async () => undefined };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = req.method === "POST" ? await readBody(req) : undefined;
      state.requests.push({ method: req.method ?? "", path: url.pathname + url.search, auth: req.headers.authorization, body });
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
      if (req.method === "POST" && url.pathname === "/internal/agent-runs") {
        return state.createRunStatus === 201 ? send(201, { run_id: RUN_ID, started_at: "2030-01-01T00:00:00Z" }) : send(state.createRunStatus, { code: "RUN_IN_PROGRESS" });
      }
      if (req.method === "POST" && /^\/internal\/agent-runs\/[^/]+\/events$/.test(url.pathname)) {
        if (state.eventStatus !== 201) return send(state.eventStatus, { code: "ERR" });
        state.events.push(body);
        return send(201, { seq: state.events.length });
      }
      if (req.method === "POST" && /^\/internal\/agent-runs\/[^/]+\/finish$/.test(url.pathname)) {
        state.finishes.push(body);
        return send(200, { ok: true });
      }
      if (req.method === "GET" && state.readStatus !== 200) return send(state.readStatus, { error: "forced" });
      if (req.method === "GET" && url.pathname === "/internal/snapshot") return send(200, snapshotView);
      if (req.method === "GET" && url.pathname === "/internal/invoices") return send(200, { invoices: state.invoices });
      const inv = /^\/internal\/invoices\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && inv) {
        const found = state.invoices.find((i) => i.invoice_id === inv[1]);
        return found ? send(200, found) : send(404, { error: "not found" });
      }
      if (req.method === "POST" && url.pathname === "/internal/payment-requests") return send(state.paymentResponse.status, state.paymentResponse.body);
      if (req.method === "GET" && url.pathname === "/internal/payments") return send(200, { payments: [state.statusView] });
      if (req.method === "GET" && /^\/internal\/payments\/[^/]+$/.test(url.pathname)) return send(200, state.statusView);
      return send(404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
