/** Pure display helpers. Money is a decimal string end to end: never parsed into a JS number. */
// eslint-disable-next-line security/detect-unsafe-regex -- fully bounded and anchored; same pattern as the contracts money type
const MONEY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
export const MICRO = 1_000_000n;
/** Exact scaled integer of a canonical money string, or null when the text is not canonical. */
export function microOf(value: string): bigint | null {
  if (!MONEY.test(value)) return null;
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * MICRO + BigInt(frac.padEnd(6, "0"));
}
export function isMoney(value: string): boolean {
  return MONEY.test(value);
}
/** "1234567.5" becomes "1,234,567.5" by string grouping. Non-canonical input is returned unchanged. */
export function groupMoney(value: string): string {
  if (!MONEY.test(value)) return value;
  const [whole = "0", frac] = value.split(".");
  let grouped = "";
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) grouped += ",";
    grouped += whole.charAt(i);
  }
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}
export const rlusd = (value: string): string => `${groupMoney(value)} RLUSD`;
/** Fixed time zone so server and client render the same text (no hydration drift). Falls back to UTC. */
export function formatInstant(iso: string | null, timeZone: string | null): string {
  if (iso === null) return "Not set";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Unknown";
  const zone = (tz: string): string => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(t));
  try {
    return `${zone(timeZone ?? "UTC")} (${timeZone ?? "UTC"})`;
  } catch {
    return `${zone("UTC")} (UTC)`;
  }
}
export function shortAddress(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 7)}…${address.slice(-6)}`;
}
/** ISO instant to the value format of an <input type="datetime-local"> in UTC. */
export function toUtcInput(iso: string | null): string {
  if (iso === null) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 16);
}
const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** datetime-local text (read as UTC) to an ISO instant, or null when it is not a real date. */
export function fromUtcInput(value: string): string | null {
  if (!LOCAL_INPUT.test(value)) return null;
  const t = Date.parse(`${value}:00Z`);
  if (Number.isNaN(t)) return null;
  const iso = new Date(t).toISOString();
  return iso.startsWith(value) ? `${value}:00.000Z` : null;
}
/** A balance snapshot older than this is shown as stale (named constant, no env var). */
export const BALANCE_STALE_SECONDS = 300;
