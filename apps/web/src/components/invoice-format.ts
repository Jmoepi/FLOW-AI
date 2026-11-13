/** Pure display helpers for invoices and payments. Everything returned is plain text. */
const DAY = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function dayNumber(date: string): number | null {
  const m = DATE.exec(date);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.floor(t / DAY);
}
/** Due text relative to the business's own calendar day. `urgent` is also shown as words, never colour alone. */
export function dueInfo(due: string, today: string): { text: string; urgent: boolean } {
  const d = dayNumber(due);
  const t = dayNumber(today);
  if (d === null || t === null) return { text: due, urgent: false };
  const diff = d - t;
  if (diff < 0) return { text: `${due} (overdue by ${String(-diff)} day${diff === -1 ? "" : "s"})`, urgent: true };
  if (diff === 0) return { text: `${due} (due today)`, urgent: true };
  if (diff <= 3) return { text: `${due} (due in ${String(diff)} day${diff === 1 ? "" : "s"})`, urgent: true };
  return { text: due, urgent: false };
}
/** Short instant for list rows: the date in the business time zone. */
export function shortDate(iso: string | null, timeZone: string): string {
  if (iso === null) return "Not set";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Unknown";
  try {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone }).format(new Date(t));
  } catch {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(t));
  }
}
/** Text for the transaction hash area of a payment. A hash that is not validated is never described as paid. */
export function hashNote(status: string, hasHash: boolean, hasLink: boolean): string {
  if (hasLink) return "Confirmed on the XRPL Testnet ledger.";
  if (hasHash) return "Not yet confirmed on the ledger. This is not counted as paid.";
  return status === "blocked" || status === "cancelled" || status === "requested" ? "No transaction was sent." : "No transaction hash yet.";
}
