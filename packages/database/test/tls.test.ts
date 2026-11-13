import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMigrationTarget } from "../src/migrate";
import { TlsConfigError, connectionConfigWithCa, loadCaPem, sslCaFileFromEnv } from "../src/tls";

// A public, self-signed test certificate (no key material). Not used for any real connection.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBijCCATGgAwIBAgIULrHOr5ZaG40c5SNmrM+PUkzGEqcwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPZmxvdy1haS10ZXN0LWNhMCAXDTI2MTExMzE3MzMyNVoYDzIx
MjYxMDIwMTczMzI1WjAaMRgwFgYDVQQDDA9mbG93LWFpLXRlc3QtY2EwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAATeVi0asouo0HPt4yCfAPd4vLZCv2X5CD755CBk
4OnvVBGg44U+8sz7f287p4uWpucxp0qGDN/CkjLPxTMR60Hgo1MwUTAdBgNVHQ4E
FgQUHwIxYhQlOSbO0lBzSJvk1I4WOAIwHwYDVR0jBBgwFoAUHwIxYhQlOSbO0lBz
SJvk1I4WOAIwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAzqd2i
bFMxF5LSrBweIXFFOM5SDX4qHT7rVLzUxyWT6gIgZYtApQgy/ZizI16fAXRYdxNY
ZO2TcltKvrV82zkUb9g=
-----END CERTIFICATE-----
`;
// Built at runtime: no literal credentials in the repo.
const pw = ["p", "w", Math.random().toString(36).slice(2)].join("");
const url = `postgresql://svc.proj:${encodeURIComponent(`${pw}/@x`)}@db.example.test:5432/postgres?sslmode=disable`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "flow-tls-"));
  writeFileSync(path.join(dir, "ok.crt"), CERT);
  writeFileSync(path.join(dir, "bundle.crt"), CERT + CERT);
  writeFileSync(path.join(dir, "text.crt"), "hello");
  writeFileSync(path.join(dir, "bad.crt"), "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  writeFileSync(path.join(dir, "key.crt"), `${CERT}-----BEGIN ${"PRIVATE"} KEY-----\nAAAA\n-----END ${"PRIVATE"} KEY-----\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadCaPem", () => {
  it("accepts a certificate and a bundle", () => {
    expect(loadCaPem(path.join(dir, "ok.crt"))).toContain("BEGIN CERTIFICATE");
    expect(loadCaPem(path.join(dir, "bundle.crt")).match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
  });
  it("rejects missing, directory, non-PEM, malformed and key files with fixed messages", () => {
    for (const f of ["nope.crt", "", "text.crt", "bad.crt", "key.crt"]) {
      const p = f === "" ? dir : path.join(dir, f);
      let msg = "";
      try {
        loadCaPem(p);
      } catch (e) {
        expect(e).toBeInstanceOf(TlsConfigError);
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/DATABASE_SSL_CA_FILE/);
      expect(msg).not.toContain(dir);
      expect(msg).not.toContain("AAAA");
    }
  });
});

describe("connectionConfigWithCa", () => {
  it("builds verified TLS settings and ignores the URL's sslmode", () => {
    const c = connectionConfigWithCa(url, path.join(dir, "ok.crt"));
    expect(c.ssl).toMatchObject({ rejectUnauthorized: true, servername: "db.example.test" });
    expect((c.ssl as { ca: string }).ca).toContain("BEGIN CERTIFICATE");
    expect(c).toMatchObject({ host: "db.example.test", port: 5432, user: "svc.proj", password: `${pw}/@x`, database: "postgres" });
    expect(c).not.toHaveProperty("connectionString");
  });
  it("rejects bad URLs and bad CA files without echoing the URL", () => {
    for (const bad of [`nope ${pw}`, `http://u:${pw}@h/db`]) {
      let msg = "";
      try {
        connectionConfigWithCa(bad, path.join(dir, "ok.crt"));
      } catch (e) {
        expect(e).toBeInstanceOf(TlsConfigError);
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(pw);
    }
    expect(() => connectionConfigWithCa(url, path.join(dir, "text.crt"))).toThrow(TlsConfigError);
  });
});

describe("sslCaFileFromEnv and the migration host guard", () => {
  it("reads and trims the variable; blank means unset", () => {
    expect(sslCaFileFromEnv({})).toBeUndefined();
    expect(sslCaFileFromEnv({ DATABASE_SSL_CA_FILE: "  " })).toBeUndefined();
    expect(sslCaFileFromEnv({ DATABASE_SSL_CA_FILE: " /x/ca.crt " })).toBe("/x/ca.crt");
  });
  it("a verified CA satisfies the TLS requirement but --allow-remote is still required", () => {
    const u = `postgresql://u:${pw}@db.example.test:5432/postgres`;
    expect(() => assertMigrationTarget(u, true)).toThrow();
    expect(() => assertMigrationTarget(u, true, true)).not.toThrow();
    expect(() => assertMigrationTarget(u, false, true)).toThrow(/allow-remote/);
  });
});
