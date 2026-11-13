import { bumpAttempt } from "@flow-ai/database";
import type { WebDeps } from "../deps";
import { sha256Hex } from "./sessions";
export const LOGIN_WINDOW_SECONDS = 900;
/** Attempts allowed per window. Per-email is tight; per-IP is looser because many people can share one address. */
export const LOGIN_LIMITS = { perEmail: 10, perIp: 60 } as const;
export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}
/** Client IP: only X-Forwarded-For when explicitly configured to trust the proxy, else one shared bucket. */
export function clientIp(request: Request, trustProxy: boolean): string {
  if (!trustProxy) return "direct";
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return /^[0-9a-fA-F:.]{3,45}$/.test(first) ? first : "direct";
}
/** Counts this login attempt against the email and IP buckets (fixed windows, stored as hashes in Postgres). */
export async function checkLoginRate(deps: WebDeps, ip: string, email: string): Promise<RateDecision> {
  const now = deps.now().getTime();
  const windowMs = LOGIN_WINDOW_SECONDS * 1000;
  const start = Math.floor(now / windowMs) * windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((start + windowMs - now) / 1000));
  const startDate = new Date(start);
  const [byEmail, byIp] = await Promise.all([
    bumpAttempt(deps.pool, sha256Hex(`email:${email.trim().toLowerCase()}`), startDate),
    bumpAttempt(deps.pool, sha256Hex(`ip:${ip}`), startDate),
  ]);
  return { allowed: byEmail <= LOGIN_LIMITS.perEmail && byIp <= LOGIN_LIMITS.perIp, retryAfterSeconds };
}
