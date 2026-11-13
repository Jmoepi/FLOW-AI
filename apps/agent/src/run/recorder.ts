import { redactError, redactValue, type AgentMode, type AgentRunEvent, type AgentRunFinish, type AgentTrigger } from "@flow-ai/contracts";
import { GuardError, type GuardClient } from "../guard/client";
import { createLogger, type Logger } from "../logger";

const MAX_STRING = 300;
const MAX_EVENT_BYTES = 4096;

function truncateStrings(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}...[truncated]` : v;
  if (v === null || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => truncateStrings(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = truncateStrings(x, depth + 1);
  return out;
}

function projection(obj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (obj === undefined) return undefined;
  const safe = truncateStrings(redactValue(obj)) as Record<string, unknown>;
  return new TextEncoder().encode(JSON.stringify(safe)).length > MAX_EVENT_BYTES ? { truncated: true } : safe;
}

/** Redacts, truncates and size-caps an event before it leaves the process. */
export function sanitizeEvent(ev: AgentRunEvent): AgentRunEvent {
  const { input, output, ...rest } = ev;
  const i = projection(input);
  const o = projection(output);
  return { ...rest, ...(i === undefined ? {} : { input: i }), ...(o === undefined ? {} : { output: o }) };
}

/** Thrown when the awaited intent event could not be stored: the caller must not go on to request a payment. */
export class RecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecorderError";
  }
}

export interface Recorder {
  readonly runId: string | null;
  /** Must succeed or no run starts. Throws the GuardError (a 409 means a run is already in progress). */
  start(trigger: AgentTrigger, mode: AgentMode): Promise<string>;
  /** Best-effort append. Never throws into the loop. */
  event(ev: AgentRunEvent): Promise<void>;
  /** Awaited append used before the payment request. Throws RecorderError when it cannot be stored (fail closed). */
  intent(ev: AgentRunEvent): Promise<void>;
  /** Retries once, never throws. Returns whether the guard accepted it. */
  finish(patch: AgentRunFinish): Promise<boolean>;
  /** In-memory copy of the sanitised events, for `--record`. */
  events(): AgentRunEvent[];
}

export function createRecorder(guard: GuardClient, logger: Logger = createLogger()): Recorder {
  let runId: string | null = null;
  const kept: AgentRunEvent[] = [];

  async function append(ev: AgentRunEvent): Promise<void> {
    if (runId === null) throw new RecorderError("The run has not started.");
    const clean = sanitizeEvent(ev);
    kept.push(clean);
    await guard.appendEvent(runId, clean);
  }

  return {
    get runId() {
      return runId;
    },
    async start(trigger, mode) {
      const created = await guard.createRun({ trigger, mode });
      runId = created.run_id;
      return runId;
    },
    async event(ev) {
      try {
        await append(ev);
      } catch (err) {
        logger.warn("recorder.event_failed", { error: redactError(err) });
      }
    },
    async intent(ev) {
      try {
        await append(ev);
      } catch (err) {
        logger.error("recorder.intent_failed", { error: redactError(err) });
        throw new RecorderError("The payment intent could not be recorded; no payment was requested.");
      }
    },
    async finish(patch) {
      if (runId === null) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await guard.finishRun(runId, patch);
          return true;
        } catch (err) {
          // 409 on the retry means the first attempt landed (a run can only be finished once).
          if (attempt > 0 && err instanceof GuardError && err.status === 409) return true;
          logger.warn("recorder.finish_failed", { attempt: attempt + 1, error: redactError(err) });
        }
      }
      return false;
    },
    events: () => [...kept],
  };
}
