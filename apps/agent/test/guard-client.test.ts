import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GuardError, MAX_RESPONSE_BYTES, createGuardClient, validateGuardUrl } from "../src/guard/client";
import { createLogger } from "../src/logger";
import { INVOICE_ID, TOKEN, paymentView, startFakeGuard, type FakeGuard } from "./helpers/fake-guard";

let fake: FakeGuard | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const lines: string[] = [];
const logger = createLogger((l) => lines.push(l));

describe("validateGuardUrl", () => {
  it("accepts loopback http and https, rejects the rest", () => {
    expect(validateGuardUrl("http://127.0.0.1:4010")).toBe("http://127.0.0.1:4010");
    expect(validateGuardUrl("http://localhost:4010/")).toBe("http://localhost:4010");
    expect(validateGuardUrl("http://[::1]:4010")).toBe("http://[::1]:4010");
    expect(validateGuardUrl("https://guard.example.com")).toBe("https://guard.example.com");
    for (const bad of ["http://evil.example.com", "http://user:pw@127.0.0.1:4010", "http://127.0.0.1:4010/x", "ftp://127.0.0.1", "not a url", "http://127.0.0.1:4010/?a=1"]) {
      expect(() => validateGuardUrl(bad)).toThrow();
    }
  });
});

describe("guard client", () => {
  it("sends the bearer token and parses contract-shaped views", async () => {
    fake = await startFakeGuard();
    const client = createGuardClient({ baseUrl: fake.url, token: TOKEN, logger });
    expect((await client.snapshot()).automation).toBe("enabled");
    expect((await client.listInvoices(5)).invoices).toHaveLength(1);
    expect((await client.invoice(INVOICE_ID)).invoice_id).toBe(INVOICE_ID);
    expect(fake.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(fake.requests[1]?.path).toBe("/internal/invoices?limit=5");
  });

  it("builds the payment body from exactly three fields", async () => {
    fake = await startFakeGuard();
    const client = createGuardClient({ baseUrl: fake.url, token: TOKEN, logger });
    const extra = { invoice_id: INVOICE_ID, idempotency_key: "agent-abcdefgh", agent_reason: "why", amount: "9999", destination: "rX" };
    await client.requestPayment(extra);
    expect(fake.requests[0]?.body).toEqual({ invoice_id: INVOICE_ID, idempotency_key: "agent-abcdefgh", agent_reason: "why" });
  });

  it("returns a stored decision on 409 and fails on other 4xx without retrying", async () => {
    fake = await startFakeGuard();
    const client = createGuardClient({ baseUrl: fake.url, token: TOKEN, logger });
    fake.paymentResponse = { status: 409, body: { ...paymentView, status: "blocked", failure_code: "DUPLICATE_REQUEST" } };
    expect((await client.requestPayment({ invoice_id: INVOICE_ID, idempotency_key: "agent-abcdefgh" })).failure_code).toBe("DUPLICATE_REQUEST");
    fake.requests.length = 0;
    fake.paymentResponse = { status: 400, body: { error: "bad" } };
    await expect(client.requestPayment({ invoice_id: INVOICE_ID, idempotency_key: "agent-abcdefgh" })).rejects.toMatchObject({ code: "GUARD_REJECTED", status: 400 });
    expect(fake.requests).toHaveLength(1);
  });

  it("maps 401 to a fatal error, 429 to RATE_LIMITED, 5xx to GUARD_UNAVAILABLE; none retried", async () => {
    fake = await startFakeGuard();
    const bad = createGuardClient({ baseUrl: fake.url, token: "x".repeat(40), logger });
    await expect(bad.snapshot()).rejects.toMatchObject({ code: "GUARD_REJECTED", fatal: true });
    expect(fake.requests).toHaveLength(1);
    for (const [status, code] of [[429, "RATE_LIMITED"], [503, "GUARD_UNAVAILABLE"]] as const) {
      fake.requests.length = 0;
      fake.paymentResponse = { status, body: {} };
      const client = createGuardClient({ baseUrl: fake.url, token: TOKEN, logger });
      await expect(client.requestPayment({ invoice_id: INVOICE_ID, idempotency_key: "agent-abcdefgh" })).rejects.toMatchObject({ code });
      expect(fake.requests).toHaveLength(1);
    }
  });

  it("rejects an unexpected response shape without echoing the body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ as_of: "SECRET-LOOKING-VALUE", extra: 1 }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const err = await createGuardClient({ baseUrl: url, token: TOKEN, logger }).snapshot().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GuardError);
      expect((err as GuardError).message).not.toContain("SECRET-LOOKING-VALUE");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("honours the timeout", async () => {
    const server = createServer(() => undefined); // never answers
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const client = createGuardClient({ baseUrl: url, token: TOKEN, timeouts: { readMs: 150 }, logger });
      await expect(client.snapshot()).rejects.toMatchObject({ code: "GUARD_TIMEOUT" });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("rejects an oversize body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pad: "x".repeat(MAX_RESPONSE_BYTES + 10) }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      await expect(createGuardClient({ baseUrl: url, token: TOKEN, logger }).snapshot()).rejects.toMatchObject({ code: "GUARD_REJECTED" });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("refuses redirects", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      if (req.url === "/internal/snapshot") {
        res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
        res.end();
      } else res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      await expect(createGuardClient({ baseUrl: url, token: TOKEN, logger }).snapshot()).rejects.toBeInstanceOf(GuardError);
      expect(hits).toBeLessThanOrEqual(2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("retries once on a connection reset (GET) and gives up after the second", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      if (hits === 1) req.socket.destroy();
      else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ invoices: [] }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const client = createGuardClient({ baseUrl: url, token: TOKEN, logger });
      expect((await client.listInvoices(3)).invoices).toEqual([]);
      expect(hits).toBe(2);
      hits = -100; // always reset
      server.removeAllListeners("request");
      let resets = 0;
      server.on("request", (req) => {
        resets += 1;
        req.socket.destroy();
      });
      await expect(client.snapshot()).rejects.toMatchObject({ code: "GUARD_UNAVAILABLE" });
      expect(resets).toBe(2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("never logs the token", async () => {
    fake = await startFakeGuard();
    const bad = createGuardClient({ baseUrl: fake.url, token: "Z".repeat(40), logger });
    await bad.snapshot().catch(() => undefined);
    await createGuardClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, logger }).snapshot().catch(() => undefined);
    expect(lines.join("\n")).not.toContain("Z".repeat(40));
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
