import { getCurrentRoleFlags, pingDatabase } from "@flow-ai/database";
import { jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
/** Liveness: the process is up. Answered by the adapter without touching the database. Carries no business data. */
export const healthzRoute = defineRoute({
  method: "GET",
  path: "/api/healthz",
  role: "public",
  liveness: true,
  handler: () => Promise.resolve(jsonResponse(200, { status: "ok" })),
});
/** Readiness: the database answers and the role is still least-privilege. Flags only, never a message or a value. */
export const readyzRoute = defineRoute({
  method: "GET",
  path: "/api/readyz",
  role: "public",
  handler: async ({ deps }) => {
    const db = await pingDatabase(deps.pool).then(() => true, () => false);
    const role = db ? await getCurrentRoleFlags(deps.pool).then((f) => !f.rolsuper && !f.rolbypassrls, () => false) : false;
    const ok = db && role;
    return jsonResponse(ok ? 200 : 503, { status: ok ? "ok" : "unavailable", db, role_ok: role });
  },
});
