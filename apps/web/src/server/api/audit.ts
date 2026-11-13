import { AuditQuerySchema, redactValue } from "@flow-ai/contracts";
import { listAuditForBusiness, withWebTx } from "@flow-ai/database";
import { jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
const PAGE = 50;
/** Read-only, newest first. Hashes and chain internals are not sent to the browser; metadata is re-redacted on the way out. */
export const auditListRoute = defineRoute({
  method: "GET",
  path: "/api/audit-events",
  role: "owner",
  query: AuditQuerySchema,
  handler: async ({ deps, session, query }) => {
    const limit = query.limit ?? PAGE;
    const rows = await withWebTx(deps.pool, session.businessId, (c) =>
      listAuditForBusiness(c, session.businessId, { limit, ...(query.before_seq === undefined ? {} : { beforeSeq: query.before_seq }) }),
    );
    const events = rows.map((r) => ({
      seq: r.seq,
      created_at: r.created_at,
      event_type: r.event_type,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      // The actor is shown as a label; a human actor id is a user id and is not exposed.
      actor: r.actor_type === "human" ? (r.actor_id === session.userId ? "you" : "another_user") : r.actor_type,
      request_id: r.request_id,
      metadata: redactValue(r.metadata),
    }));
    const last = rows[rows.length - 1];
    return jsonResponse(200, { events, next_before_seq: rows.length === limit && last !== undefined ? last.seq : null });
  },
});
