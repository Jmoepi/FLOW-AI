import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type pg from "pg";

/** Configuration problem with the TLS CA file. Messages are fixed strings: no path content, no connection string. */
export class TlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsConfigError";
  }
}

const MAX_CA_BYTES = 256 * 1024;
const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Reads a PEM file of one or more CA certificates (public material). Rejects a missing or oversized file, a file that
 * holds anything other than parseable certificates (a private key is refused outright). The contents are never logged.
 */
export function loadCaPem(file: string): string {
  let text: string;
  try {
    if (!statSync(file).isFile()) throw new Error("not a file");
    if (statSync(file).size > MAX_CA_BYTES) throw new TlsConfigError("DATABASE_SSL_CA_FILE is too large to be a CA certificate file.");
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err instanceof TlsConfigError) throw err;
    throw new TlsConfigError("DATABASE_SSL_CA_FILE cannot be read (missing or not a file).");
  }
  if (/PRIVATE KEY-----/.test(text)) throw new TlsConfigError("DATABASE_SSL_CA_FILE must hold CA certificates only, not a key.");
  const blocks = text.match(CERT_BLOCK_RE);
  if (blocks === null || blocks.length === 0) throw new TlsConfigError("DATABASE_SSL_CA_FILE is not a PEM certificate.");
  try {
    for (const b of blocks) new X509Certificate(b);
  } catch {
    throw new TlsConfigError("DATABASE_SSL_CA_FILE does not contain a valid X.509 certificate.");
  }
  return `${blocks.join("\n")}\n`;
}

/** Trimmed DATABASE_SSL_CA_FILE from an environment, or undefined when unset or blank. */
export function sslCaFileFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.DATABASE_SSL_CA_FILE?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/**
 * Turns a postgres:// URL into explicit client settings with verified TLS against the given CA: certificate chain and
 * host name are checked (rejectUnauthorized true, servername = host). The URL's own sslmode parameters are dropped so
 * they cannot weaken this. Errors never echo the URL (it carries the password).
 */
export function connectionConfigWithCa(connectionString: string, caFile: string): pg.ClientConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new TlsConfigError("The database URL is not a valid URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new TlsConfigError("The database URL must use the postgres:// scheme.");
  const host = url.hostname;
  if (host === "") throw new TlsConfigError("The database URL has no host.");
  const ca = loadCaPem(caFile);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return {
    host,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ...(database === "" ? {} : { database }),
    ssl: { ca, rejectUnauthorized: true, servername: host },
  };
}
