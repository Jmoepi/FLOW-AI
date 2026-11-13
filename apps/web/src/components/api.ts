/** Browser-side calls to the same-origin owner API. The CSRF token is fetched per write and never stored (WB-3). */
export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}
async function call(url: string, init: RequestInit): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch {
    return { status: 0, body: { code: "NETWORK" } };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON error page: leave the body empty; the status code still drives the message.
  }
  return { status: res.status, body };
}
export const getJson = (url: string): Promise<ApiResult> => call(url, { method: "GET" });
export async function writeJson(method: "PUT" | "PATCH" | "POST", url: string, payload: unknown, extra: Record<string, string> = {}): Promise<ApiResult> {
  const session = await getJson("/api/session");
  const token = session.body.csrf_token;
  if (session.status !== 200 || typeof token !== "string") return session;
  return call(url, {
    method,
    headers: { "content-type": "application/json", "x-csrf-token": token, ...extra },
    body: JSON.stringify(payload),
  });
}
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
