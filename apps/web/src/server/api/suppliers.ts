import { IdParamsSchema, SupplierPatchSchema } from "@flow-ai/contracts";
import { appendAudit, listSuppliersForBusiness, lockSupplierForWeb, setSupplierFlags, withWebTx } from "@flow-ai/database";
import { isFresh } from "../auth/session";
import { HttpError, jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
export const suppliersListRoute = defineRoute({
  method: "GET",
  path: "/api/suppliers",
  role: "owner",
  handler: async ({ deps, session }) => {
    const rows = await withWebTx(deps.pool, session.businessId, (c) => listSuppliersForBusiness(c, session.businessId));
    return jsonResponse(200, { suppliers: rows });
  },
});
/**
 * PATCH /api/suppliers/:id. Only is_approved and is_active can change (the database role cannot touch the name or the
 * XRPL address). The supplier id is looked up inside the caller's business, so another tenant's id is a plain 404.
 */
export const supplierPatchRoute = defineRoute({
  method: "PATCH",
  path: "/api/suppliers/:id",
  role: "owner",
  csrf: "token",
  body: SupplierPatchSchema,
  params: IdParamsSchema,
  handler: async ({ deps, requestId, session, body, params }) => {
    const result = await withWebTx(deps.pool, session.businessId, async (c) => {
      const current = await lockSupplierForWeb(c, session.businessId, params.id);
      if (current === null) throw new HttpError(404, "NOT_FOUND", "Not found.");
      const approvalChanged = body.is_approved !== undefined && body.is_approved !== current.is_approved;
      const activeChanged = body.is_active !== undefined && body.is_active !== current.is_active;
      if (!approvalChanged && !activeChanged) return { row: current, changed: [] as string[] };
      // Approving or re-activating loosens protection and needs a recent login; removing approval is always allowed.
      const loosens = (approvalChanged && body.is_approved === true) || (activeChanged && body.is_active === true);
      if (loosens && !isFresh(deps, session)) throw new HttpError(401, "REAUTH_REQUIRED", "Sign in again to approve a supplier.");
      const row = await setSupplierFlags(c, session.businessId, current.id, { is_approved: approvalChanged ? body.is_approved : undefined, is_active: activeChanged ? body.is_active : undefined }, deps.now());
      if (row === null) throw new HttpError(404, "NOT_FOUND", "Not found.");
      const changed: string[] = [];
      const audit = async (event: string, field: "is_approved" | "is_active"): Promise<void> => {
        changed.push(field);
        await appendAudit(c, {
          business_id: session.businessId,
          actor_type: "human",
          actor_id: session.userId,
          event_type: event,
          entity_type: "supplier",
          entity_id: current.id,
          metadata: { field, before: current[field], after: row[field] },
          request_id: requestId,
        });
      };
      if (approvalChanged) await audit("supplier.approval_changed", "is_approved");
      if (activeChanged) await audit("supplier.active_changed", "is_active");
      return { row, changed };
    });
    deps.logger.info("supplier.updated", { request_id: requestId, changed: result.changed });
    return jsonResponse(200, { supplier: result.row, changed: result.changed });
  },
});
