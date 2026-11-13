import { createHash } from "node:crypto";
/**
 * sha256 of a fixed-order canonical form of the request facts that matter. Same key + same hash = replay;
 * same key + different hash = conflict (decision 6). Built field by field, never from the raw body.
 */
export function requestHash(input: { invoice_id: string; agent_reason?: string | undefined }): string {
  const canonical = JSON.stringify({ invoice_id: input.invoice_id.toLowerCase(), agent_reason: input.agent_reason ?? null });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
