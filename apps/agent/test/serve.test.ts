import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfigError } from "../src/config";
import { findForbiddenEnv } from "../src/env-guard";
import { parseCliArgs } from "../src/cli";
import { createGuardClient } from "../src/guard/client";
import { createHealthServer, createServeLoop, loadServeSettings } from "../src/serve";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
describe("serve settings", () => {
  it("defaults to a 5 second poll on loopback port 4003", () => {
    expect(loadServeSettings({})).toEqual({ pollSeconds: 5, healthHost: "127.0.0.1", healthPort: 4003 });
  });
  it("accepts valid overrides and rejects out of range or malformed values, naming only the variable", () => {
    expect(loadServeSettings({ AGENT_POLL_SECONDS: "30", AGENT_HEALTH_HOST: "0.0.0.0", AGENT_HEALTH_PORT: "8080" })).toEqual({ pollSeconds: 30, healthHost: "0.0.0.0", healthPort: 8080 });
    for (const env of [{ AGENT_POLL_SECONDS: "1" }, { AGENT_POLL_SECONDS: "61" }, { AGENT_POLL_SECONDS: "x" }, { AGENT_HEALTH_PORT: "0" }, { AGENT_HEALTH_PORT: "70000" }, { AGENT_HEALTH_HOST: "evil.example.com/x" }]) {
      expect(() => loadServeSettings(env)).toThrow(AgentConfigError);
    }
    try {
      loadServeSettings({ AGENT_POLL_SECONDS: "999" });
    } catch (e) {
      expect((e as Error).message).toContain("AGENT_POLL_SECONDS");
      expect((e as Error).message).not.toContain("999");
    }
  });
  it("the new names are on the agent allowlist and look secret-free", () => {
    expect(findForbiddenEnv({ AGENT_POLL_SECONDS: "5", AGENT_HEALTH_HOST: "127.0.0.1", AGENT_HEALTH_PORT: "4003" })).toEqual([]);
  });
  it("--serve is a known flag and defaults off", () => {
    expect(parseCliArgs(["--serve"]).serve).toBe(true);
    expect(parseCliArgs([]).serve).not.toBe(true);
  });
});
describe("serve loop", () => {
  it("a claimed request triggers exactly one manual run, and the next poll waits for that run to end", async () => {
    const events: string[] = [];
    let claims = 0;
    const loop = createServeLoop({
      pollMs: 5,
      claim: () => {
        events.push("claim");
        return Promise.resolve(++claims === 2);
      },
      runOnce: async (trigger) => {
        events.push(`run-start:${trigger}`);
        await sleep(60);
        events.push("run-end");
      },
      onError: () => undefined,
    });
    const done = loop.start();
    for (let i = 0; i < 300 && !(events.includes("run-end") && events.lastIndexOf("claim") > events.indexOf("run-end")); i++) await sleep(10);
    loop.stop();
    await done;
    expect(events.filter((e) => e.startsWith("run-start"))).toEqual(["run-start:manual"]);
    const start = events.indexOf("run-start:manual");
    const end = events.indexOf("run-end");
    expect(events.slice(start + 1, end)).toEqual([]); // no claim happened while the run was active
    expect(events[end + 1]).toBe("claim");
  });
  it("an error in a poll or a run is reported and does not stop the loop", async () => {
    const errors: unknown[] = [];
    let n = 0;
    const loop = createServeLoop({
      pollMs: 5,
      claim: () => {
        n++;
        if (n === 1) return Promise.reject(new Error("guard unreachable"));
        return Promise.resolve(n === 2);
      },
      runOnce: () => Promise.reject(new Error("run blew up")),
      onError: (e) => errors.push(e),
    });
    const done = loop.start();
    // Wait for the behaviour (not a fixed time) so a loaded machine cannot make this flaky.
    for (let i = 0; i < 200 && n <= 3; i++) await sleep(10);
    loop.stop();
    await done;
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(n).toBeGreaterThan(3);
  });
  it("the interval trigger is skipped while a run is active and runs otherwise", async () => {
    let release: () => void = () => undefined;
    const runs: string[] = [];
    const loop = createServeLoop({
      pollMs: 5,
      claim: () => Promise.resolve(runs.length === 0),
      runOnce: (t) =>
        new Promise<void>((resolve) => {
          runs.push(t);
          release = resolve;
        }),
      onError: () => undefined,
    });
    const done = loop.start();
    await sleep(30);
    expect(loop.isBusy()).toBe(true);
    expect(await loop.runInterval()).toBe(false);
    release();
    await sleep(20);
    const interval = loop.runInterval();
    await sleep(5);
    release();
    expect(await interval).toBe(true);
    expect(runs).toEqual(["manual", "interval"]);
    loop.stop();
    await done;
  });
  it("stop resolves promptly even while sleeping between polls", async () => {
    const loop = createServeLoop({ pollMs: 60_000, claim: () => Promise.resolve(false), runOnce: () => Promise.resolve(), onError: () => undefined });
    const done = loop.start();
    await sleep(20);
    const t0 = Date.now();
    loop.stop();
    await done;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(loop.lastPollAt()).not.toBeNull();
  });
});
describe("health listener", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  async function start(): Promise<number> {
    const s = createHealthServer(() => ({ last_poll_at: "2026-01-01T00:00:00.000Z", busy: false }));
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as AddressInfo).port;
  }
  it("answers GET /healthz with a status and the last poll time and nothing else", async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", last_poll_at: "2026-01-01T00:00:00.000Z", busy: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("has no other route and only accepts GET", async () => {
    const port = await start();
    for (const path of ["/", "/metrics", "/healthz/x", "/internal/status", "/.env"]) expect((await fetch(`http://127.0.0.1:${String(port)}${path}`)).status, path).toBe(404);
    const post = await fetch(`http://127.0.0.1:${String(port)}/healthz`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });
});
describe("guard client claim", () => {
  const client = (fetchImpl: typeof fetch) => createGuardClient({ baseUrl: "http://127.0.0.1:4002", token: "t".repeat(40), fetchImpl });
  it("true on 200 with a request id, false on 204, and it sends the bearer token with no body", async () => {
    const calls: RequestInit[] = [];
    const ok = client(vi.fn((_u: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response(JSON.stringify({ request_id: "11111111-1111-4111-8111-111111111111" }), { status: 200 }));
    }) as unknown as typeof fetch);
    expect(await ok.claimRunRequest()).toBe(true);
    expect(calls[0]?.body).toBeUndefined();
    expect((calls[0]?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
    const none = client(() => Promise.resolve(new Response(null, { status: 204 })));
    expect(await none.claimRunRequest()).toBe(false);
  });
  it("rejects a malformed 200 body and does not echo it", async () => {
    const bad = client(() => Promise.resolve(new Response(JSON.stringify({ request_id: "<script>" }), { status: 200 })));
    await expect(bad.claimRunRequest()).rejects.toThrow(/unexpected response/);
  });
});
