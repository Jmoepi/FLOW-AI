import "server-only";
import { getCurrentRoleFlags, createPool, sslCaFileFromEnv, type Pool } from "@flow-ai/database";
import { redactError } from "@flow-ai/contracts";
import { assertLeastPrivilegeRole, loadWebConfig, type WebConfig } from "./config";
import { createLogger, type Logger } from "./logger";
import { createLocalPasswordProvider } from "./auth/local-password-provider";
import type { WebDeps } from "./deps";
/**
 * Lazily built process singleton. The database role is verified once before the first request is served; if the role
 * is a superuser or has BYPASSRLS the app refuses to serve (fail closed).
 */
let pending: Promise<WebDeps> | undefined;
function build(): Promise<WebDeps> {
  const logger: Logger = createLogger();
  const config: WebConfig = loadWebConfig(process.env);
  const caFile = sslCaFileFromEnv(process.env);
  const caOption = caFile === undefined ? {} : { sslCaFile: caFile };
  const pool: Pool = createPool({
    connectionString: config.databaseUrl,
    ...caOption,
    applicationName: "flow-ai-web",
    max: 10,
    onError: (m) => logger.error("db.pool_error", { message: m }),
  });
  const now = (): Date => new Date();
  return getCurrentRoleFlags(pool).then(
    (flags) => {
      assertLeastPrivilegeRole(flags);
      return { pool, config, logger, now, provider: createLocalPasswordProvider({ pool, now }) };
    },
    (err: unknown) => {
      logger.error("startup.role_check_failed", { message: redactError(err) });
      void pool.end();
      throw new Error("Refusing to start: database role check failed.");
    },
  );
}
export function getDeps(): Promise<WebDeps> {
  pending ??= build().catch((err: unknown) => {
    pending = undefined; // allow a retry after a transient failure; never serve without the check
    throw err;
  });
  return pending;
}
