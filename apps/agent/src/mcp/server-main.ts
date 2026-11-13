import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redactError } from "@flow-ai/contracts";
import { createGuardClient } from "../guard/client";
import { createLogger } from "../logger";
import { createToolServer } from "./server";
import { parseServerEnv } from "./server-env";

/** stdout carries protocol frames only; every log line goes to stderr. */
async function main(): Promise<void> {
  const log = createLogger();
  try {
    const cfg = parseServerEnv(process.env);
    const guard = createGuardClient({ baseUrl: cfg.guardUrl, token: cfg.token, timeouts: { readMs: cfg.readMs, paymentMs: cfg.paymentMs }, logger: log });
    const server = createToolServer({ guard, limits: { maxToolCalls: cfg.maxToolCalls, maxPayments: cfg.maxPayments }, logger: log });
    await server.connect(new StdioServerTransport());
    log.info("mcp.started", {});
  } catch (err) {
    log.error("mcp.start_failed", { error: redactError(err) });
    process.exitCode = 2;
  }
}

void main();
