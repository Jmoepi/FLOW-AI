import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactError } from "@flow-ai/contracts";
import { CliUsageError, exitCodeFor, formatSummary, parseCliArgs, type CliArgs } from "./cli";
import { AgentConfigError, agentConfigWarnings, buildToolServerEnv, loadAgentConfig, type AgentConfig } from "./config";
import { createGuardClient } from "./guard/client";
import { createLogger } from "./logger";
import { spawnStdioServer } from "./mcp/mcp-client";
import { createAnthropicAdapter } from "./llm/anthropic";
import { createLlmBrain } from "./llm/llm-brain";
import { createDeterministicBrain } from "./run/deterministic";
import { createRecorder } from "./run/recorder";
import { runAgent } from "./run/run-agent";
import { TranscriptError, writeTranscript } from "./run/transcript";
import type { Brain, RunResult } from "./run/types";
import { createScheduler } from "./scheduler";
import { createHealthServer, createServeLoop, loadServeSettings, type ServeSettings } from "./serve";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const log = createLogger();

function buildBrain(config: AgentConfig): Brain {
  // Never fall back to a different mode silently: llm without a usable key/model is a startup error (config.ts),
  // and a runtime fallback is recorded as a mode_fallback event and shown as the run's effective mode.
  if (config.mode === "llm") {
    if (config.ai === null) throw new AgentConfigError("AGENT_MODE=llm requires AI_PROVIDER, AI_MODEL and AI_API_KEY.");
    const adapter = createAnthropicAdapter({ apiKey: config.ai.apiKey, model: config.ai.model });
    return createLlmBrain({ adapter, fallback: createDeterministicBrain() });
  }
  return createDeterministicBrain();
}

/** One run with a fresh guard client, a fresh recorder and a fresh tool server (so the per-session bounds start at zero). */
async function runOnce(config: AgentConfig, args: CliArgs, signal: AbortSignal): Promise<RunResult> {
  const guard = createGuardClient({ baseUrl: config.guardUrl, token: config.token, logger: log });
  const tools = await spawnStdioServer({ env: buildToolServerEnv(config, process.env), cwd: ROOT });
  try {
    return await runAgent({
      config,
      recorder: createRecorder(guard, log),
      tools,
      brain: buildBrain(config),
      trigger: args.trigger,
      probeIneligible: args.probeIneligible,
      logger: log,
      signal,
    });
  } finally {
    await tools.close().catch(() => undefined);
  }
}

/**
 * Service mode (`pnpm start`): poll the guard for the owner's "Run treasury agent" requests and answer a health probe.
 * The interval trigger runs too when AGENT_SCHEDULE_INTERVAL_MINUTES is set. Runs never overlap.
 */
async function serve(config: AgentConfig, args: CliArgs, settings: ServeSettings, stop: AbortController): Promise<number> {
  const guard = createGuardClient({ baseUrl: config.guardUrl, token: config.token, logger: log });
  const loop = createServeLoop({
    pollMs: settings.pollSeconds * 1000,
    claim: (signal) => guard.claimRunRequest(signal),
    runOnce: async (trigger, signal) => {
      const result = await runOnce(config, { ...args, trigger }, signal);
      process.stdout.write(`${formatSummary(result)}\n`);
    },
    onError: (err) => log.error("agent.serve_error", { error: redactError(err) }),
  });
  const health = createHealthServer(() => ({ last_poll_at: loop.lastPollAt(), busy: loop.isBusy() }));
  await new Promise<void>((resolve, reject) => {
    health.once("error", reject);
    health.listen(settings.healthPort, settings.healthHost, () => resolve());
  });
  const scheduler =
    config.scheduleIntervalMinutes === null
      ? null
      : createScheduler({
          intervalMinutes: config.scheduleIntervalMinutes,
          runImmediately: false,
          runOnce: async () => {
            if (!(await loop.runInterval())) log.warn("agent.tick_skipped", { reason: "a run is already active" });
          },
          onError: (err) => log.error("agent.run_error", { error: redactError(err) }),
        });
  scheduler?.start();
  log.info("agent.serving", { poll_seconds: settings.pollSeconds, health_port: settings.healthPort, interval_minutes: config.scheduleIntervalMinutes });
  stop.signal.addEventListener("abort", () => loop.stop(), { once: true });
  await loop.start();
  await scheduler?.stop();
  await new Promise<void>((resolve) => health.close(() => resolve()));
  return 0;
}
async function main(): Promise<number> {
  let args: CliArgs;
  let config: AgentConfig;
  let serveSettings: ServeSettings | null = null;
  try {
    args = parseCliArgs(process.argv.slice(2));
    config = loadAgentConfig(process.env);
    for (const w of agentConfigWarnings(process.env)) log.warn("config.warning", { warning: w });
    buildBrain(config);
    if (typeof args.record === "string") throw new AgentConfigError("--record takes no path; transcripts are written under docs/demo/.");
    if (args.record !== null && args.schedule) throw new AgentConfigError("--record cannot be combined with --schedule.");
    if (args.serve === true && (args.record !== null || args.schedule)) throw new AgentConfigError("--serve cannot be combined with --record or --schedule (the interval is set by AGENT_SCHEDULE_INTERVAL_MINUTES).");
    if (args.serve === true) serveSettings = loadServeSettings(process.env);
    if (args.schedule && config.scheduleIntervalMinutes === null) {
      throw new AgentConfigError("AGENT_SCHEDULE_INTERVAL_MINUTES is empty; scheduling is disabled.");
    }
  } catch (err) {
    process.stderr.write(`${err instanceof CliUsageError || err instanceof AgentConfigError ? err.message : redactError(err)}\n`);
    return 2;
  }

  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  if (serveSettings !== null) return serve(config, args, serveSettings, stop);
  if (!args.schedule) {
    const result = await runOnce(config, args, stop.signal).catch((err: unknown) => {
      log.error("agent.run_error", { error: redactError(err) });
      return null;
    });
    if (result === null) return 1;
    process.stdout.write(`${formatSummary(result)}\n`);
    if (args.record !== null && result.runId !== null) {
      try {
        // The agent only ever talks to the real guard (Testnet), so the ledger label is always testnet here.
        const file = writeTranscript(path.join(ROOT, "docs", "demo"), result, "testnet");
        process.stdout.write(`transcript=${path.relative(ROOT, file).split(path.sep).join("/")}\n`);
      } catch (err) {
        process.stderr.write(`Transcript not written: ${err instanceof TranscriptError ? err.message : redactError(err)}\n`);
        return 1;
      }
    }
    return exitCodeFor(result.status);
  }

  // Interval trigger: overlap-protected in process, and the guard rejects a second running run (409).
  const interval = config.scheduleIntervalMinutes as number;
  const scheduler = createScheduler({
    intervalMinutes: interval,
    runImmediately: true,
    runOnce: async () => {
      const result = await runOnce(config, { ...args, trigger: "interval" }, stop.signal);
      process.stdout.write(`${formatSummary(result)}\n`);
    },
    onError: (err) => log.error("agent.run_error", { error: redactError(err) }),
    onSkip: () => log.warn("agent.tick_skipped", { reason: "previous run still active" }),
  });
  scheduler.start();
  log.info("agent.scheduled", { interval_minutes: interval });
  await new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
  await scheduler.stop();
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${redactError(err)}\n`);
    process.exitCode = 1;
  },
);
