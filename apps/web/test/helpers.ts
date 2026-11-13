import { randomBytes, randomUUID } from "node:crypto";
import { addBusinessMember, createCredential, type Pool } from "@flow-ai/database";
import { createTestDatabase, seedScenario, type Scenario, type ScenarioOptions, type TestDatabase } from "@flow-ai/database/testing";
import { routes } from "../src/server/api/routes";
import { createLocalPasswordProvider } from "../src/server/auth/local-password-provider";
import { hashPassword, type ScryptParams } from "../src/server/auth/password";
import { loadWebConfig, type WebConfig } from "../src/server/config";
import type { WebDeps } from "../src/server/deps";
import { createLogger } from "../src/server/logger";
import type { Route } from "../src/server/http/route";
export const CURRENCY_HEX = "524C555344000000000000000000000000000000";
export const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
export const ORIGIN = "http://127.0.0.1:3000";
/** Cheap parameters so tests do not spend 128 MiB per hash. The default cost is covered by one dedicated test. */
export const FAST: ScryptParams = { N: 2 ** 10, r: 8, p: 1 };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Syntactically valid classic address (not a real account). */
export const fakeAddress = (): string => "r" + Array.from(randomBytes(28), (b) => B58[b % B58.length]).join("");
/** Test passwords are generated at runtime: no credential-shaped literal in source. */
export const newPassword = (): string => `Pw-${randomBytes(12).toString("hex")}`;
export function validEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    WEB_DATABASE_URL: "postgres://flow_web:placeholder@127.0.0.1:54329/flow",
    APP_BASE_URL: ORIGIN,
    RLUSD_ISSUER: ISSUER,
    RLUSD_CURRENCY_HEX: CURRENCY_HEX,
    ...over,
  };
}
export interface Clock {
  ms: number;
  now: () => Date;
  advance: (seconds: number) => void;
}
export function makeClock(start = Date.now()): Clock {
  const clock: Clock = { ms: start, now: () => new Date(clock.ms), advance: (s) => void (clock.ms += s * 1000) };
  return clock;
}
export interface TestUser {
  userId: string;
  email: string;
  password: string;
}
export interface CallOptions {
  method?: string;
  query?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string | undefined;
  csrf?: string | undefined;
  origin?: string | null;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  contentType?: string | null;
}
export interface Session {
  cookie: string;
  csrf: string;
}
/** Parsed JSON of a response: shape is asserted by the tests, not typed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;
export interface CallResult {
  status: number;
  body: Json;
  raw: string;
  headers: Headers;
}
export interface WebHarness {
  db: TestDatabase;
  deps: WebDeps;
  config: WebConfig;
  clock: Clock;
  logs: string[];
  pool: Pool;
  scenario: Scenario;
  owner: TestUser;
  viewer: TestUser;
  addUser: (businessId: string, role: "owner" | "viewer") => Promise<TestUser>;
  call: (route: Route, options?: CallOptions) => Promise<CallResult>;
  login: (user: TestUser, extra?: CallOptions) => Promise<Session & CallResult>;
  authed: (route: Route, session: Session, options?: CallOptions) => Promise<CallResult>;
  close: () => Promise<void>;
}
export interface HarnessOptions {
  /** Reuse an existing throwaway database and tenant (the guard harness); it is NOT dropped on close. */
  existing?: { db: TestDatabase; scenario: Scenario };
  scenario?: Partial<ScenarioOptions>;
  env?: Record<string, string | undefined>;
}
export async function createWebHarness(options: HarnessOptions = {}): Promise<WebHarness> {
  const db = options.existing?.db ?? (await createTestDatabase());
  const clock = makeClock();
  const logs: string[] = [];
  const config = loadWebConfig(validEnv(options.env));
  const provider = createLocalPasswordProvider({ pool: db.webPool, now: clock.now, params: FAST });
  const deps: WebDeps = { pool: db.webPool, config, logger: createLogger((l) => logs.push(l)), now: clock.now, provider };
  const scenario = options.existing?.scenario ?? (await seedScenario(db.adminPool, { walletAddress: fakeAddress(), supplierAddress: fakeAddress(), issuer: ISSUER, currencyHex: CURRENCY_HEX, ...options.scenario }));
  const addUser = async (businessId: string, role: "owner" | "viewer"): Promise<TestUser> => {
    const password = newPassword();
    const email = `${role}-${randomUUID()}@example.test`;
    const cred = await createCredential(db.adminPool, { email, password_hash: await hashPassword(password, FAST) });
    await addBusinessMember(db.adminPool, { business_id: businessId, user_id: cred.user_id, role });
    return { userId: cred.user_id, email, password };
  };
  const owner = await addUser(scenario.businessId, "owner");
  const viewer = await addUser(scenario.businessId, "viewer");
  const call = async (route: Route, o: CallOptions = {}): Promise<CallResult> => {
    const method = o.method ?? route.method;
    const headers = new Headers(o.headers);
    const hasBody = o.body !== undefined || o.rawBody !== undefined;
    if (hasBody && o.contentType !== null) headers.set("content-type", o.contentType ?? "application/json");
    if (o.cookie !== undefined) headers.set("cookie", o.cookie);
    if (o.csrf !== undefined) headers.set("x-csrf-token", o.csrf);
    if (method !== "GET") {
      const origin = o.origin === undefined ? ORIGIN : o.origin;
      if (origin !== null) headers.set("origin", origin);
    }
    const init: RequestInit = { method, headers };
    if (hasBody) init.body = o.rawBody ?? JSON.stringify(o.body);
    const request = new Request(`${ORIGIN}${route.path.replace(":id", o.params?.id ?? "x")}${o.query ?? ""}`, init);
    const res = await route.run(deps, request, o.params);
    const raw = await res.text();
    const body = ((): Json => {
      try {
        return raw === "" ? {} : (JSON.parse(raw) as Json);
      } catch {
        return {};
      }
    })();
    return { status: res.status, body, raw, headers: res.headers };
  };
  const login = async (user: TestUser, extra: CallOptions = {}): Promise<Session & CallResult> => {
    const res = await call(routes.login, { body: { email: user.email, password: user.password }, ...extra });
    if (res.status !== 200) throw new Error(`login failed with ${String(res.status)}`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    return { ...res, cookie, csrf: res.body.csrf_token as string };
  };
  const authed = (route: Route, s: Session, o: CallOptions = {}): Promise<CallResult> => call(route, { cookie: s.cookie, csrf: s.csrf, ...o });
  return {
    db, deps, config, clock, logs, pool: db.webPool, scenario, owner, viewer, addUser, call, login, authed,
    close: () => (options.existing ? Promise.resolve() : db.drop()),
  };
}
