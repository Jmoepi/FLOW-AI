import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { GuardPaymentRequestSchema, PaymentStatusSchema } from "@flow-ai/contracts";
import { pingDatabase } from "@flow-ai/database";
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
    const up = db && ledger;
    const status = !up ? "unavailable" : audit.blocked ? "degraded" : "ok";
    return reply.code(up && !audit.blocked ? 200 : 503).send({ status, db, ledger, audit_chain: audit.state, audit_verified_at: audit.last_checked_at });
  });
}
/** Every route here sits behind the bearer-token hook installed by the caller (AZ-1). */
export function registerInternalRoutes(app: FastifyInstance, deps: ServiceDeps): void {
  app.post("/internal/payment-requests", { bodyLimit: 4096 }, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = GuardPaymentRequestSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400);
    const result = await executeAndRespond(deps, await requestPayment(deps, parsed.data, req.id));
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
  app.get("/internal/status", async () => getStatus(deps));
  // Counts only: no payment data, hashes or blobs in the response.
  app.post("/internal/reconcile", async (_req, reply) => {
    if (!deps.reconciler) return reply.code(503).send({ status: "unavailable" });
    return reply.code(200).send(await deps.reconciler.runOnce());
  });
}
