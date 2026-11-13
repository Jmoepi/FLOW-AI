import { PolicyUpdateSchema, diffPolicy, redactValue, type PolicyFields } from "@flow-ai/contracts";
import { appendAudit, getBusinessForWeb, getPolicyForWeb, lockPolicyForWeb, updatePolicyVersioned, withWebTx, type WebPolicyRow } from "@flow-ai/database";
import { isFresh } from "../auth/session";
import type { SessionContext } from "../auth/provider";
import { HttpError, jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
import type { WebDeps } from "../deps";
const etag = (version: number): string => `"${String(version)}"`;
/** Browser-facing shape. `updated_by` is a relative label, never a user id. */
function present(p: WebPolicyRow, session: SessionContext): Record<string, unknown> {
  return {
    enabled: p.enabled,
    max_payment_amount: p.max_payment_amount,
    daily_spend_limit: p.daily_spend_limit,
    minimum_reserve: p.minimum_reserve,
    allowed_assets: p.allowed_assets,
    valid_until: p.valid_until,
    version: p.version,
    updated_at: p.updated_at,
    updated_by: p.updated_by === null ? null : p.updated_by === session.userId ? "you" : "another_user",
  };
}
const fields = (p: WebPolicyRow): PolicyFields => ({
  enabled: p.enabled,
  max_payment_amount: p.max_payment_amount,
  daily_spend_limit: p.daily_spend_limit,
  minimum_reserve: p.minimum_reserve,
  allowed_assets: p.allowed_assets,
  valid_until: p.valid_until,
});
export const policyGetRoute = defineRoute({
  method: "GET",
  path: "/api/policy",
  role: "owner",
  handler: async ({ deps, session }) => {
    const { policy, timezone } = await withWebTx(deps.pool, session.businessId, async (c) => {
      const p = await getPolicyForWeb(c, session.businessId);
      const b = await getBusinessForWeb(c, session.businessId);
      return { policy: p, timezone: b?.timezone ?? null };
    });
    if (policy === null) throw new HttpError(404, "NOT_FOUND", "Not found.");
    return jsonResponse(200, { policy: present(policy, session), timezone, network: "XRPL Testnet", display_unit: "RLUSD" }, { etag: etag(policy.version) });
  },
});
const IF_MATCH = /^"(0|[1-9][0-9]{0,8})"$/;
function parseIfMatch(header: string | null): number {
  if (header === null) throw new HttpError(428, "PRECONDITION_REQUIRED", "Reload the policy and try again (If-Match is required).");
  const m = IF_MATCH.exec(header.trim());
  if (!m?.[1]) throw new HttpError(400, "VALIDATION_FAILED", "The request was not valid.", { extra: { fields: ["if-match"] } });
  return Number(m[1]);
}
function assetsAllowed(deps: WebDeps, assets: readonly { currency: string; issuer: string }[]): boolean {
  return assets.every((a) => a.currency === deps.config.rlusd.currencyHex && a.issuer === deps.config.rlusd.issuer);
}
export const policyPutRoute = defineRoute({
  method: "PUT",
  path: "/api/policy",
  role: "owner",
  csrf: "token",
  body: PolicyUpdateSchema,
  handler: async ({ deps, request, requestId, session, body }) => {
    const expected = parseIfMatch(request.headers.get("if-match"));
    if (!assetsAllowed(deps, body.allowed_assets)) throw new HttpError(400, "VALIDATION_FAILED", "The request was not valid.", { extra: { fields: ["allowed_assets"] } });
    const next: PolicyFields = {
      enabled: body.enabled,
      max_payment_amount: body.max_payment_amount,
      daily_spend_limit: body.daily_spend_limit,
      minimum_reserve: body.minimum_reserve,
      allowed_assets: body.allowed_assets,
      valid_until: body.valid_until === null ? null : new Date(body.valid_until).toISOString(),
    };
    const result = await withWebTx(deps.pool, session.businessId, async (c) => {
      const current = await lockPolicyForWeb(c, session.businessId);
      if (current === null) throw new HttpError(404, "NOT_FOUND", "Not found.");
      if (current.version !== expected) {
        throw new HttpError(412, "VERSION_CONFLICT", "The policy changed since you loaded it. Reload and review the latest values.", { headers: { etag: etag(current.version) } });
      }
      const diff = diffPolicy(fields(current), next);
      // No-op: nothing is written and no version or audit event is created.
      if (diff.changed.length === 0) return { row: current, changed: [] as string[] };
      // Pausing is the fail-safe direction: always allowed, never needs confirmation or a fresh login.
      const pauseOnly = diff.changed.length === 1 && diff.changed[0] === "enabled" && !next.enabled;
      if (!pauseOnly && !isFresh(deps, session)) {
        throw new HttpError(401, "REAUTH_REQUIRED", "Sign in again to change payment rules.");
      }
      if (diff.risky && body.confirm_risky !== true) {
        throw new HttpError(422, "CONFIRMATION_REQUIRED", "This change loosens a protection. Review it and confirm.", { extra: { risky_fields: diff.riskyFields } });
      }
      const row = await updatePolicyVersioned(c, session.businessId, expected, next, session.userId, deps.now());
      if (row === null) throw new HttpError(412, "VERSION_CONFLICT", "The policy changed since you loaded it. Reload and review the latest values.");
      await appendAudit(c, {
        business_id: session.businessId,
        actor_type: "human",
        actor_id: session.userId,
        event_type: "policy.updated",
        entity_type: "treasury_policy",
        entity_id: row.id,
        metadata: redactValue({ changed: diff.changed, before: diff.before, after: diff.after, risky: diff.risky, confirmed: diff.risky, previous_version: current.version, new_version: row.version }) as Record<string, unknown>,
        request_id: requestId,
      });
      return { row, changed: diff.changed };
    });
    deps.logger.info("policy.updated", { request_id: requestId, changed: result.changed });
    return jsonResponse(200, { policy: present(result.row, session), changed: result.changed }, { etag: etag(result.row.version) });
  },
});
