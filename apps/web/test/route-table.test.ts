import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { routeList, routes } from "../src/server/api/routes";
import { defineRoute } from "../src/server/http/route";
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "api");
function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? routeFiles(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
}
describe("route table (AZ-1)", () => {
  it("every registered route declares a role, and write routes declare CSRF", () => {
    expect(routeList.length).toBeGreaterThanOrEqual(9);
    for (const r of routeList) {
      expect(["owner", "member", "public"], `${r.method} ${r.path}`).toContain(r.role);
      if (r.method !== "GET") expect(r.csrf, `${r.method} ${r.path}`).not.toBe("none");
      if (r.method !== "GET" && r.role !== "public") expect(r.csrf).toBe("token");
    }
  });
  it("only login and the two health probes are public, and every dashboard route is owner-only", () => {
    expect(routeList.filter((r) => r.role === "public").map((r) => r.path).sort()).toEqual(["/api/auth/login", "/api/healthz", "/api/readyz"]);
    for (const r of [routes.healthz, routes.readyz]) expect(r.method).toBe("GET");
    expect(routes.healthz.liveness).toBe(true);
    expect(routes.readyz.liveness).toBe(false);
    for (const r of [routes.invoicesList, routes.invoiceGet, routes.paymentsList, routes.paymentGet]) {
      expect(r.role).toBe("owner");
      expect(r.method).toBe("GET");
    }
    expect(routes.agentRunRequest.role).toBe("owner");
    expect(routes.agentRunRequest.csrf).toBe("token");
    for (const r of [routes.policyGet, routes.policyPut, routes.suppliersList, routes.supplierPatch, routes.auditList, routes.agentRunsList, routes.overview]) expect(r.role).toBe("owner");
    expect(routes.session.role).toBe("member");
    expect(routes.logout.role).toBe("member");
  });
  it("there is no CSV export route and no finance-operator role (cut for the MVP, spec 3.4 and 4.2)", () => {
    expect(routeList.some((r) => /export|csv|operator/i.test(r.path))).toBe(false);
    const roles = new Set(routeList.map((r) => r.role));
    expect([...roles].sort()).toEqual(["member", "owner", "public"]);
  });
  it("a liveness probe can only be a public GET", () => {
    const handler = () => Promise.resolve(new Response());
    expect(() => defineRoute({ method: "GET", path: "/api/x", role: "owner", liveness: true, handler })).toThrow(/liveness/);
  });
  it("no two routes share a method and path", () => {
    const keys = routeList.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("cannot define a route without a role, with an unknown role, outside /api, or a write without CSRF", () => {
    const handler = () => Promise.resolve(new Response());
    expect(() => defineRoute({ method: "GET", path: "/api/x", handler } as never)).toThrow(/role must be declared/);
    expect(() => defineRoute({ method: "GET", path: "/api/x", role: "admin", handler } as never)).toThrow(/role must be declared/);
    expect(() => defineRoute({ method: "GET", path: "/x", role: "owner", handler })).toThrow(/under \/api/);
    expect(() => defineRoute({ method: "POST", path: "/api/x", role: "owner", csrf: "none", handler })).toThrow(/CSRF/);
    expect(() => defineRoute({ method: "POST", path: "/api/x", role: "owner", csrf: "origin", handler })).toThrow(/CSRF token/);
  });
  it("the Next route files export exactly the registered methods and nothing else (no unlisted endpoint)", () => {
    const registered = new Set(routeList.map((r) => `${r.method} ${r.path}`));
    const found = new Set<string>();
    for (const file of routeFiles(API_DIR)) {
      const rel = path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
      const urlPath = `/api/${rel}`.replace(/\[(\w+)\]/g, ":$1");
      const src = readFileSync(file, "utf8");
      const methods = [...src.matchAll(/export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1] as string);
      expect(methods.length, file).toBeGreaterThan(0);
      for (const m of methods) {
        found.add(`${m} ${urlPath}`);
        expect(src, `${file} must delegate to the route table`).toContain(`export const ${m} = handle(routes.`);
      }
    }
    expect([...found].sort()).toEqual([...registered].sort());
  });
  it("route files contain no logic besides the adapter (no db, no session, no request parsing)", () => {
    for (const file of routeFiles(API_DIR)) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/@flow-ai\/database|request\.|cookies\(|headers\(\)|JSON\.parse|\.json\(\)/);
    }
  });
});
