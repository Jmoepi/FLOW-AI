import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { SessionContext } from "./auth/provider";
import { getSessionContext } from "./auth/session";
import { getDeps } from "./db";
import type { WebDeps } from "./deps";
import type { Route } from "./http/route";
export interface OwnerPage {
  deps: WebDeps;
  session: SessionContext;
  /** Runs one of the registered GET routes with the caller's own cookie, so pages and API share one authorization path. */
  load: <T>(route: Route, pathAndQuery: string) => Promise<T>;
}
/**
 * Server-side gate for every owner page (AZ-1). No valid owner session means a redirect to /login; there is no
 * client-side-only check. Data is read through the same route handlers the API exposes.
 */
export async function requireOwner(): Promise<OwnerPage> {
  const deps = await getDeps();
  const cookie = (await headers()).get("cookie");
  const base = deps.config.appOrigin;
  const make = (path: string): Request => new Request(`${base}${path}`, { method: "GET", headers: cookie === null ? {} : { cookie } });
  const session = await getSessionContext(deps, make("/api/session"));
  if (session?.role !== "owner") redirect("/login");
  const load = async <T,>(route: Route, pathAndQuery: string): Promise<T> => {
    const res = await route.run(deps, make(pathAndQuery));
    if (res.status === 401 || res.status === 403) redirect("/login");
    if (!res.ok) throw new Error(`Could not load ${route.path}`);
    return (await res.json()) as T;
  };
  return { deps, session, load };
}
