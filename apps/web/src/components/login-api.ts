/** Login is the one write without a session, so it has no CSRF token: the server checks the Origin header instead. */
export interface LoginResult {
  status: number;
  retryAfter?: number;
}
export async function writeJsonPublic(url: string, payload: unknown): Promise<LoginResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const retry = Number(res.headers.get("retry-after"));
    return Number.isFinite(retry) && retry > 0 ? { status: res.status, retryAfter: Math.ceil(retry) } : { status: res.status };
  } catch {
    return { status: 0 };
  }
}
