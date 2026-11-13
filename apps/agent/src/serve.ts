import http from "node:http";
import { isIP } from "node:net";
import { AgentConfigError } from "./config";
/** Settings of the long-running service mode (names only in docs; none of them is a secret). */
export interface ServeSettings {
  pollSeconds: number;
  healthHost: string;
  healthPort: number;
}
function intIn(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return def;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new AgentConfigError(`${name} must be an integer between ${String(min)} and ${String(max)}.`);
  return Number(raw);
}
export function loadServeSettings(env: NodeJS.ProcessEnv): ServeSettings {
  const host = (env.AGENT_HEALTH_HOST ?? "").trim() === "" ? "127.0.0.1" : (env.AGENT_HEALTH_HOST as string).trim();
  if (host !== "localhost" && isIP(host.replace(/^\[|\]$/g, "")) === 0) throw new AgentConfigError("AGENT_HEALTH_HOST must be an IP address or localhost.");
  return { pollSeconds: intIn(env, "AGENT_POLL_SECONDS", 5, 2, 60), healthHost: host, healthPort: intIn(env, "AGENT_HEALTH_PORT", 4003, 1, 65535) };
}
export interface ServeLoopOptions {
  pollMs: number;
  /** True when the guard handed over an owner request. */
  claim: (signal: AbortSignal) => Promise<boolean>;
  /** Runs the agent once. Never throws into the loop. */
  runOnce: (trigger: "manual" | "interval", signal: AbortSignal) => Promise<void>;
  onError: (err: unknown) => void;
  now?: () => Date;
}
export interface ServeLoop {
  /** Polls until stop() is called. Resolves after the active run, if any, has ended. */
  start(): Promise<void>;
  stop(): void;
  /** Runs the interval trigger. Skipped (returns false) while another run is active, so runs never overlap. */
  runInterval(): Promise<boolean>;
  lastPollAt(): string | null;
  isBusy(): boolean;
}
/**
 * Claims owner requests one at a time. The next poll happens only after the previous run ended (no overlap), an error in a
 * poll or a run is reported and the loop carries on. The guard's one-running-run index is the second lock.
 */
export function createServeLoop(opts: ServeLoopOptions): ServeLoop {
  const stopper = new AbortController();
  const now = opts.now ?? ((): Date => new Date());
  let busy = false;
  let last: string | null = null;
  let wake: (() => void) | null = null;
  const guarded = async (trigger: "manual" | "interval"): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    try {
      await opts.runOnce(trigger, stopper.signal);
    } catch (err) {
      opts.onError(err);
    } finally {
      busy = false;
    }
    return true;
  };
  return {
    async start() {
      while (!stopper.signal.aborted) {
        try {
          if (!busy && (await opts.claim(stopper.signal))) await guarded("manual");
        } catch (err) {
          if (!stopper.signal.aborted) opts.onError(err);
        }
        last = now().toISOString();
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, opts.pollMs);
          wake = (): void => {
            clearTimeout(t);
            resolve();
          };
        });
      }
      while (busy) await new Promise((r) => setTimeout(r, 25));
    },
    stop() {
      stopper.abort();
      wake?.();
    },
    runInterval: () => guarded("interval"),
    lastPollAt: () => last,
    isBusy: () => busy,
  };
}
/** Health listener: GET /healthz only, no secrets, no other route. Bound to the configured host. */
export function createHealthServer(status: () => { last_poll_at: string | null; busy: boolean }): http.Server {
  return http.createServer((req, res) => {
    const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/healthz") {
      res.writeHead(404, headers).end('{"error":"not_found"}');
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { ...headers, allow: "GET" }).end('{"error":"method_not_allowed"}');
      return;
    }
    const s = status();
    res.writeHead(200, headers).end(JSON.stringify({ status: "ok", last_poll_at: s.last_poll_at, busy: s.busy }));
  });
}
