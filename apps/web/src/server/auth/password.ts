import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
/**
 * Password hashing with node:crypto scrypt (no native dependency; see docs/m4-notes.md for why not argon2).
 * Stored form: scrypt$N$r$p$<salt b64>$<hash b64>. Parameters are stored with the hash so they can be raised later.
 * This file has no `server-only` import so the demo-owner seed script can use it.
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}
/** OWASP-class cost: 128 MiB of memory per hash. */
export const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const KEY_LEN = 64;
const SALT_LEN = 16;
/** Upper bounds on parameters read back from storage, so a tampered row cannot make a login allocate gigabytes. */
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 4;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;
function maxmem(params: ScryptParams): number {
  return 128 * params.N * params.r + 128 * params.r * params.p + 64 * 1024 * 1024;
}
function derive(password: string, salt: Buffer, params: ScryptParams, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLen, { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params) }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}
export function isAcceptablePassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD;
}
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  if (!isAcceptablePassword(password)) throw new RangeError("password length out of range");
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, params, KEY_LEN);
  return `scrypt$${String(params.N)}$${String(params.r)}$${String(params.p)}$${salt.toString("base64")}$${key.toString("base64")}`;
}
interface Parsed {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}
function parse(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, salt, key] = parts as [string, string, string, string, string, string];
  if (![n, r, p].every((x) => /^[1-9][0-9]{0,8}$/.test(x))) return null;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (params.N < 2 || params.N > MAX_N || (params.N & (params.N - 1)) !== 0 || params.r > MAX_R || params.p > MAX_P) return null;
  const saltBuf = Buffer.from(salt, "base64");
  const keyBuf = Buffer.from(key, "base64");
  if (saltBuf.length < 8 || saltBuf.length > 64 || keyBuf.length < 16 || keyBuf.length > 128) return null;
  return { params, salt: saltBuf, key: keyBuf };
}
/** Constant-time compare of the derived key. A malformed stored hash verifies as false (after doing no work). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (parsed === null || typeof password !== "string" || password.length > MAX_PASSWORD) return false;
  const key = await derive(password, parsed.salt, parsed.params, parsed.key.length);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}
/** True when the stored hash uses weaker parameters than the current default (re-hash after a successful login). */
export function needsRehash(stored: string, target: ScryptParams = DEFAULT_PARAMS): boolean {
  const parsed = parse(stored);
  if (parsed === null) return true;
  return parsed.params.N < target.N || parsed.params.r < target.r || parsed.params.p < target.p;
}
let dummy: Promise<string> | undefined;
/**
 * A real hash of a random password with the current parameters. Used to spend the same time for an unknown email as
 * for a known one, so response time does not reveal which emails exist.
 */
export function dummyHash(params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  if (params === DEFAULT_PARAMS) {
    dummy ??= hashPassword(randomBytes(24).toString("base64"), params);
    return dummy;
  }
  return hashPassword(randomBytes(24).toString("base64"), params);
}
