import { redactError } from "@flow-ai/contracts";
import { createPool, getCurrentRoleFlags } from "@flow-ai/database";
import { XrplGateway } from "@flow-ai/xrpl-adapter";
import { buildApp } from "./app";
import { assertLeastPrivilegeRole, ConfigError, loadConfig } from "./config";
import { createBalancePoller } from "./jobs/balance-poller";
import { createReconciler } from "./jobs/reconcile";
import { createSweeper } from "./jobs/sweeper";
import { createLogger } from "./logger";
import { createExecutor } from "./services/execute";
import type { ServiceDeps } from "./services/payments";
const logger = createLogger();
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool({ connectionString: config.databaseUrl, applicationName: "flow-ai-payment-guard", onError: (m) => logger.error("db.pool_error", { error: m }) });
  assertLeastPrivilegeRole(await getCurrentRoleFlags(pool));
  const gateway = await XrplGateway.connect(config.network, { wsUrl: config.wsUrl });
  const base: ServiceDeps = { pool, gateway, config, env: () => process.env, logger };
  const executor = createExecutor(base);
  const deps: ServiceDeps = { ...base, executor };
  const reconciler = createReconciler(deps);
  const { app } = await buildApp({ ...deps, reconciler });
  const sweeper = createSweeper(deps);
  const poller = createBalancePoller(deps);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    // Stop taking work, let in-flight requests and executions finish, then close the pool and the ledger connection.
    void Promise.all([reconciler.stop(), sweeper.stop(), poller.stop()])
      .then(() => app.close())
      .then(() => executor.idle())
      .then(() => Promise.all([pool.end(), gateway.disconnect()]))
      .then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ host: config.host, port: config.port });
  reconciler.start();
  sweeper.start();
  poller.start();
  logger.info("guard.listening", { host: config.host, port: config.port, network: config.network });
}
main().catch((err: unknown) => {
  // ConfigError carries variable names only; everything else is redacted (G-1, G-3).
  logger.error("guard.startup_failed", { error: err instanceof ConfigError ? err.message : redactError(err) });
  process.exit(1);
});
