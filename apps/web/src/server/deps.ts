import type { Pool } from "@flow-ai/database";
import type { AuthProvider } from "./auth/provider";
import type { WebConfig } from "./config";
import type { Logger } from "./logger";
/** Everything a handler needs. Injected, so tests run the real handlers against a real database without Next. */
export interface WebDeps {
  pool: Pool;
  config: WebConfig;
  logger: Logger;
  now: () => Date;
  provider: AuthProvider;
}
