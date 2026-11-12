// eslint-disable-next-line security/detect-unsafe-regex -- fully bounded and anchored; no ambiguous nested repetition
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Parse an ISO 8601 instant (with Z or offset) to epoch milliseconds, or null. Pure: no clock access. */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_INSTANT.exec(value);
  if (!m) return null;
  // Date.parse silently rolls impossible dates over (Feb 30 -> Mar 2), so validate the components.
  const [y, mo, d, h, mi, sec, oh, om] = [m[1], m[2], m[3], m[4], m[5], m[6], m[7] ?? "0", m[8] ?? "0"].map(Number) as [number, number, number, number, number, number, number, number];
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || sec > 59 || oh > 23 || om > 59) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The business date (YYYY-MM-DD) of an instant in an IANA timezone (businesses.timezone, 6.1/6.4).
 * Throws RangeError for an unknown timezone; the engine converts that into a blocked decision.
 * Africa/Johannesburg is UTC+2 year-round (no DST), so the day boundary is 22:00 UTC.
 */
export function businessDate(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): string => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new RangeError(`missing date part ${type}`);
    return p.value;
  };
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}
