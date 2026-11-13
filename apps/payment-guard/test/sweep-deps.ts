import type { ServiceDeps } from "../src/services/payments";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { validEnv } from "./helpers";

/** Minimal deps for jobs whose database access is replaced by a test double. */
export function makeSweepDeps(): ServiceDeps {
  return { pool: {} as never, gateway: {} as never, config: loadConfig(validEnv()), env: () => ({}), logger: createLogger(() => undefined) };
}
