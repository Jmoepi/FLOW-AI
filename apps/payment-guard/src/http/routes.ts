import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentRunCreateSchema, AgentRunEventSchema, AgentRunFinishSchema, GuardPaymentRequestSchema, PaymentStatusSchema } from "@flow-ai/contracts";
import { pingDatabase } from "@flow-ai/database";
import { getAgentInvoice, getAgentSnapshot, listAgentInvoices, resolveAgentBusinessId } from "../services/agent-views";
import { appendRunEvent, claimRunRequest, finishRun, recordRunPaymentRequest, startAgentRun, type RunOutcome } from "../services/agent-runs";
import { executeAndRespond } from "../services/execute";
import { getPaymentById, getStatus, listPaymentsView, previewEligibility, requestPayment, type ServiceDeps } from "../services/payments";
import { sendError } from "./errors";
const IdParams = z.strictObject({ id: z.uuid() });
const ListQuery = z.strictObject({
  invoice_id: z.uuid().optional(),
  status: PaymentStatusSchema.optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional(),
});
const InvoiceListQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(20))
    .optional(),
});
/** Maps a run-record outcome to a stable, generic response. Free text from the request is never echoed. */
function sendRunOutcome<T>(reply: FastifyReply, out: RunOutcome<T>, okStatus: 200 | 201): FastifyReply {
  switch (out.kind) {
    case "ok":
      return reply.code(okStatus).send(out.value);
    case "not_found":
      return sendError(reply, 404);
    case "invalid":
      return sendError(reply, 400);
    case "conflict":
      return reply.code(409).type("application/json; charset=utf-8").send({ error: out.code });
  }
}
const unavailable = (reply: FastifyReply): FastifyReply => reply.code(503).type("application/json; charset=utf-8").send({ error: "unavailable" });
/** Unauthenticated, minimal probes. */
export function registerPublicRoutes(app: FastifyInstance, deps: ServiceDeps): void {
  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    const [db, ledger] = await Promise.all([
      pingDatabase(deps.pool).then(() => true, () => false),
      deps.gateway.getNetworkInfo().then(() => true, () => false),
    ]);
    // Flags only (L-2): the kill switch variable is no longer reported. The audit chain result is a state word and a
    // timestamp, never a business id, row or hash.
    const audit = deps.integrity?.status(deps.env()) ?? { state: "unverified" as const, last_checked_at: null, blocked: false };
    const signing = deps.signingKey?.status(deps.env()) ?? { mode: "master_env" as const, blocked: false };
    const up = db && ledger;
    const degraded = audit.blocked || signing.blocked; // a rejected signing key blocks execution (fail closed, M7)
    const status = !up ? "unavailable" : degraded ? "degraded" : "ok";
    return reply.code(up && !degraded ? 200 : 503).send({ status, db, ledger, audit_chain: audit.state, audit_verified_at: audit.last_checked_at, signing_key: signing.mode });
  });
}
/** Every route here sits behind the bearer-token hook installed by the caller (AZ-1). */
export function registerInternalRoutes(app: FastifyInstance, deps: ServiceDeps): void {
  app.post("/internal/payment-requests", { bodyLimit: 4096 }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = GuardPaymentRequestSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400);
    const requested = await requestPayment(deps, parsed.data, req.id);
    // Record what the guard decided BEFORE execution so the run outcome can be derived from the guard's own records.
    await recordRunPaymentRequest(deps, parsed.data, requested);
    const result = await executeAndRespond(deps, requested);
    return reply.code(result.httpStatus).send(result.body);
  });
  app.get("/internal/payments/:id", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400);
    const payment = await getPaymentById(deps, params.data.id);
    return payment ?? sendError(reply, 404);
  });
  app.get("/internal/payments", async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400);
    return { payments: await listPaymentsView(deps, { invoiceId: q.data.invoice_id, status: q.data.status, limit: q.data.limit }) };
  });
  app.get("/internal/invoices/:id/eligibility", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400);
    const view = await previewEligibility(deps, params.data.id);
    return view ?? sendError(reply, 404);
  });
  // Agent read views (7.2.D). The business is resolved by the guard (pin or sole business); the agent never names one.
  app.get("/internal/snapshot", async (_req, reply) => {
    const businessId = await resolveAgentBusinessId(deps);
    if (businessId === null) return unavailable(reply);
    return (await getAgentSnapshot(deps, businessId)) ?? unavailable(reply);
  });
  app.get("/internal/invoices", async (req, reply) => {
    const q = InvoiceListQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400);
    const businessId = await resolveAgentBusinessId(deps);
    if (businessId === null) return unavailable(reply);
    return listAgentInvoices(deps, businessId, q.data.limit ?? 10);
  });
  app.get("/internal/invoices/:id", async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400);
    const businessId = await resolveAgentBusinessId(deps);
    if (businessId === null) return unavailable(reply);
    return (await getAgentInvoice(deps, businessId, params.data.id)) ?? sendError(reply, 404);
  });
  // Agent run records: create / append / finish only. No read, update or delete is exposed on this surface.
  app.post("/internal/agent-runs", { bodyLimit: 1024 }, async (req, reply) => {
    const body = AgentRunCreateSchema.safeParse(req.body);
    if (!body.success) return sendError(reply, 400);
    const businessId = await resolveAgentBusinessId(deps);
    if (businessId === null) return unavailable(reply);
    return sendRunOutcome(reply, await startAgentRun(deps, businessId, body.data, req.id), 201);
  });
  app.post("/internal/agent-runs/:id/events", { bodyLimit: 8192 }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = AgentRunEventSchema.safeParse(req.body);
    if (!params.success || !body.success) return sendError(reply, 400);
    const businessId = await resolveAgentBusinessId(deps);
    if (businessId === null) return unavailable(reply);
    return sendRunOutcome(reply, await appendRunEvent(deps, businessId, params.data.id, body.data), 201);
  });
  app.post("/internal/agent-runs/:id/finish", { bodyLimit: 4096 }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = AgentRunFinishSchema.safeParse(req.body);
    if (!params.success || !body.success) return sendError(reply, 400);
    const businessId = await resolveAgentBusinessId(deps);
    if (businessId === null) return unavailable(reply);
    return sendRunOutcome(reply, await finishRun(deps, businessId, params.data.id, body.data, req.id), 200);
  });
  // The owner's "Run treasury agent" request, handed to the agent. No body in, only a request id out (or 204).
  app.post("/internal/run-requests/claim", { bodyLimit: 1024 }, async (req, reply) => {
    const businessId = await resolveAgentBusinessId(deps);
    if (businessId === null) return unavailable(reply);
    const id = await claimRunRequest(deps, businessId, req.id);
    return id === null ? reply.code(204).send() : reply.code(200).type("application/json; charset=utf-8").send({ request_id: id });
  });
  app.get("/internal/status", async () => getStatus(deps));
  // Counts only: no payment data, hashes or blobs in the response.
  app.post("/internal/reconcile", async (_req, reply) => {
    if (!deps.reconciler) return reply.code(503).send({ status: "unavailable" });
    return reply.code(200).send(await deps.reconciler.runOnce());
  });
}
