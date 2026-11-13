/**
 * Turns audit metadata into display rows from a WHITELIST of known keys. Anything else is dropped, values are reduced to
 * short plain strings, and the result is rendered as React text only: raw JSON never reaches the page (WB-1).
 */
export interface ChangeRow {
  field: string;
  before: string;
  after: string;
}
const FIELD_LABEL: Record<string, string> = {
  enabled: "Automation",
  max_payment_amount: "Largest single payment",
  daily_spend_limit: "Daily limit",
  minimum_reserve: "Minimum reserve",
  allowed_assets: "Allowed assets",
  valid_until: "Policy expiry",
  is_approved: "Approved",
  is_active: "Active",
};
const MAX = 120;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function show(field: string, v: unknown): string {
  if (v === null || v === undefined) return field === "valid_until" ? "no expiry" : "none";
  if (typeof v === "boolean") return field === "enabled" ? (v ? "on" : "paused") : v ? "yes" : "no";
  if (typeof v === "string") return v.length > MAX ? `${v.slice(0, MAX)}…` : v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "unknown";
  if (Array.isArray(v) && field === "allowed_assets") {
    const names = v.flatMap((a) => (isRecord(a) && typeof a.currency === "string" ? [a.currency.startsWith("524C5553") ? "RLUSD" : a.currency.slice(0, 12)] : []));
    return names.length === 0 ? "none" : names.join(", ");
  }
  return "(not shown)";
}
export function describeMetadata(eventType: string, metadata: unknown): ChangeRow[] {
  if (!isRecord(metadata)) return [];
  if (eventType === "policy.updated" && Array.isArray(metadata.changed) && isRecord(metadata.before) && isRecord(metadata.after)) {
    const before = metadata.before;
    const after = metadata.after;
    return metadata.changed
      .filter((f): f is string => typeof f === "string" && Object.hasOwn(FIELD_LABEL, f))
      .map((f) => ({ field: FIELD_LABEL[f] ?? f, before: show(f, before[f]), after: show(f, after[f]) }));
  }
  if (eventType.startsWith("supplier.") && typeof metadata.field === "string" && Object.hasOwn(FIELD_LABEL, metadata.field)) {
    return [{ field: FIELD_LABEL[metadata.field] ?? metadata.field, before: show(metadata.field, metadata.before), after: show(metadata.field, metadata.after) }];
  }
  return [];
}
