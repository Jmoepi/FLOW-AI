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
const IP_TEXT = /^[0-9a-fA-F:.]{3,45}$/;
/**
 * Client IP behind `hops` trusted proxies: each proxy appends the address it saw, so the real client is the entry `hops`
 * places from the RIGHT. Entries to its left are client-controlled and are ignored (a spoofed leftmost value cannot choose
 * the bucket). No trusted proxy, a missing or short header, or a malformed entry all fall back to one shared bucket.
 */
export function clientIp(request: Request, hops: number): string {
  if (!Number.isInteger(hops) || hops < 1) return "direct";
  const parts = (request.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim());
  const entry = parts.length >= hops ? parts[parts.length - hops] : undefined;
  return entry !== undefined && IP_TEXT.test(entry) ? entry : "direct";
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
