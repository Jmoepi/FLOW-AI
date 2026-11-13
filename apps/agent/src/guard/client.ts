import { z } from "zod";
import {
  GuardInvoiceListSchema,
  GuardInvoiceViewSchema,
  GuardPaymentListSchema,
  GuardPaymentViewSchema,
  GuardSnapshotViewSchema,
  redactError,
  type AgentRunEvent,
  type AgentRunFinish,
  type AgentRunCreate,
  type GuardInvoiceList,
  type GuardInvoiceView,
  type GuardPaymentView,
  type GuardSnapshotView,
  type ToolErrorCode,
} from "@flow-ai/contracts";
import { createLogger, type Logger } from "../logger";

/** Largest guard response the agent will read (256 KB). */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/** Failure talking to the guard. `message` is safe to show: it never carries a body, token or URL. */
export class GuardError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly status: number | null = null,
    /** True for 401/403: the token or deployment is wrong, no retry can help. */
    readonly fatal = false,
  ) {
    super(message);
    this.name = "GuardError";
  }
}

/** http only for loopback; https anywhere else. No userinfo, no path. Returns the bare origin. */
export function validateGuardUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("guard URL is not a valid URL");
  }
  if (u.username !== "" || u.password !== "") throw new Error("guard URL must not contain credentials");
  if (u.search !== "" || u.hash !== "" || (u.pathname !== "/" && u.pathname !== "")) throw new Error("guard URL must be a bare origin");
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol === "http:" && loopback) return u.origin;
  if (u.protocol === "https:") return u.origin;
  throw new Error("guard URL must be http on loopback or https");
}

export interface GuardClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeouts?: { readMs?: number; paymentMs?: number; writeMs?: number };
  logger?: Logger;
}

export interface GuardClient {
  snapshot(signal?: AbortSignal): Promise<GuardSnapshotView>;
  listInvoices(limit: number, signal?: AbortSignal): Promise<GuardInvoiceList>;
  invoice(id: string, signal?: AbortSignal): Promise<GuardInvoiceView>;
  /** Builds the body from exactly three fields; nothing else can reach the guard. */
  requestPayment(req: { invoice_id: string; idempotency_key: string; agent_reason?: string | undefined }, signal?: AbortSignal): Promise<GuardPaymentView>;
  paymentById(id: string, signal?: AbortSignal): Promise<GuardPaymentView>;
  paymentsByInvoice(invoiceId: string, signal?: AbortSignal): Promise<GuardPaymentView[]>;
  createRun(body: AgentRunCreate, signal?: AbortSignal): Promise<{ run_id: string; started_at: string }>;
  appendEvent(runId: string, ev: AgentRunEvent, signal?: AbortSignal): Promise<{ seq: number }>;
  finishRun(runId: string, body: AgentRunFinish, signal?: AbortSignal): Promise<void>;
  /** Claims the owner's pending "Run treasury agent" request, if any. True means one run should start now. */
  claimRunRequest(signal?: AbortSignal): Promise<boolean>;
}

const RunCreatedSchema = z.object({ run_id: z.uuid(), started_at: z.string().max(40) });
const ClaimSchema = z.object({ request_id: z.uuid() });
const EventAppendedSchema = z.object({ seq: z.number().int().min(1).max(32) });

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs: number;
  /** Retry once, only when the connection itself failed (never after a response, never after a timeout). */
  retryOnNetworkError: boolean;
  /** Statuses (besides 2xx) whose body is returned instead of treated as an error. */
  acceptStatuses?: readonly number[];
  signal: AbortSignal | undefined;
}

async function readCapped(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new GuardError("GUARD_REJECTED", "Guard response too large.", res.status);
  if (!res.body) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early cancels the stream, so an oversize body is never buffered whole.
  for await (const value of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) throw new GuardError("GUARD_REJECTED", "Guard response too large.", res.status);
    chunks.push(value);
  }
  if (total === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GuardError("GUARD_REJECTED", "Guard returned a non-JSON response.", res.status);
  }
}

const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

export function createGuardClient(opts: GuardClientOptions): GuardClient {
  const origin = validateGuardUrl(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.logger ?? createLogger();
  const readMs = opts.timeouts?.readMs ?? 10_000;
  const writeMs = opts.timeouts?.writeMs ?? 10_000;
  const paymentMs = opts.timeouts?.paymentMs ?? 55_000;
  const authorization = `Bearer ${opts.token}`;

  async function attempt(spec: RequestSpec): Promise<{ status: number; json: unknown }> {
    const signals = [AbortSignal.timeout(spec.timeoutMs)];
    if (spec.signal) signals.push(spec.signal);
    const init: RequestInit = {
      method: spec.method,
      redirect: "error",
      signal: AbortSignal.any(signals),
      headers: {
        authorization,
        accept: "application/json",
        ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    };
    const res = await doFetch(`${origin}${spec.path}`, init);
    const json = await readCapped(res);
    return { status: res.status, json };
  }

  async function call(spec: RequestSpec): Promise<unknown> {
    let result: { status: number; json: unknown };
    try {
      try {
        result = await attempt(spec);
      } catch (err) {
        if (err instanceof GuardError) throw err;
        if (isAbort(err) || !spec.retryOnNetworkError) throw err;
        log.warn("guard.retry", { path: spec.path.split("?")[0] });
        result = await attempt(spec);
      }
    } catch (err) {
      if (err instanceof GuardError) throw err;
      if (isAbort(err)) throw new GuardError("GUARD_TIMEOUT", "The payment guard did not answer in time.");
      log.warn("guard.network_error", { error: redactError(err) });
      throw new GuardError("GUARD_UNAVAILABLE", "The payment guard is unreachable.");
    }
    const { status, json } = result;
    if (status >= 200 && status < 300) return json;
    if (spec.acceptStatuses?.includes(status)) return json;
    if (status === 401 || status === 403) throw new GuardError("GUARD_REJECTED", "The payment guard rejected the agent credentials.", status, true);
    if (status === 429) throw new GuardError("RATE_LIMITED", "The payment guard is rate limiting requests.", status);
    if (status >= 500) throw new GuardError("GUARD_UNAVAILABLE", "The payment guard reported an error.", status);
    throw new GuardError("GUARD_REJECTED", `The payment guard rejected the request (HTTP ${String(status)}).`, status);
  }

  function parse<T>(schema: z.ZodType<T>, json: unknown): T {
    const r = schema.safeParse(json);
    // Never echo the body or the zod issues: a hostile or buggy response must not reach logs or the model.
    if (!r.success) throw new GuardError("GUARD_REJECTED", "The payment guard returned an unexpected response.");
    return r.data;
  }

  const get = (path: string, signal?: AbortSignal): Promise<unknown> => call({ method: "GET", path, timeoutMs: readMs, retryOnNetworkError: true, signal });
  const post = (path: string, body: unknown, timeoutMs: number, signal?: AbortSignal, retry = false, acceptStatuses?: readonly number[]): Promise<unknown> =>
    call({ method: "POST", path, body, timeoutMs, retryOnNetworkError: retry, signal, ...(acceptStatuses ? { acceptStatuses } : {}) });

  return {
    async snapshot(signal) {
      return parse(GuardSnapshotViewSchema, await get("/internal/snapshot", signal));
    },
    async listInvoices(limit, signal) {
      return parse(GuardInvoiceListSchema, await get(`/internal/invoices?limit=${String(limit)}`, signal));
    },
    async invoice(id, signal) {
      return parse(GuardInvoiceViewSchema, await get(`/internal/invoices/${encodeURIComponent(id)}`, signal));
    },
    async requestPayment(req, signal) {
      const body: Record<string, string> = { invoice_id: req.invoice_id, idempotency_key: req.idempotency_key };
      if (req.agent_reason !== undefined) body.agent_reason = req.agent_reason;
      // The same idempotency key makes a connection-level retry safe. A 409 carries the stored decision.
      return parse(GuardPaymentViewSchema, await post("/internal/payment-requests", body, paymentMs, signal, true, [409]));
    },
    async paymentById(id, signal) {
      return parse(GuardPaymentViewSchema, await get(`/internal/payments/${encodeURIComponent(id)}`, signal));
    },
    async paymentsByInvoice(invoiceId, signal) {
      return parse(GuardPaymentListSchema, await get(`/internal/payments?invoice_id=${encodeURIComponent(invoiceId)}`, signal)).payments;
    },
    async createRun(body, signal) {
      return parse(RunCreatedSchema, await post("/internal/agent-runs", body, writeMs, signal));
    },
    async appendEvent(runId, ev, signal) {
      return parse(EventAppendedSchema, await post(`/internal/agent-runs/${encodeURIComponent(runId)}/events`, ev, writeMs, signal));
    },
    async claimRunRequest(signal) {
      // 200 {request_id} when claimed, 204 (no body) when nothing is open. The request id carries no instruction.
      const json = await post("/internal/run-requests/claim", undefined, writeMs, signal);
      return parse(ClaimSchema.nullable(), json) !== null;
    },
    async finishRun(runId, body, signal) {
      await post(`/internal/agent-runs/${encodeURIComponent(runId)}/finish`, body, writeMs, signal);
    },
  };
}
