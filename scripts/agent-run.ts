/**
 * One agent run against the locally running payment guard.
 * Usage: pnpm agent:run [-- --probe-ineligible] [--schedule] [--guard-port <port>]
 * Prerequisite: pnpm guard:dev -- --business <uuid> [--enable-execution] (it writes the dev token this reads).
 * The agent runs in a clean environment (see lib/agent-launcher.ts). Nothing secret is printed.
 */
import { readDevToken, startAgent } from "./lib/agent-launcher";

function main(): Promise<number> {
  const raw = process.argv.slice(2).filter((a) => a !== "--");
  let guardPort = 4002;
  const passthrough: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] as string;
    if (a === "--guard-port") {
      const v = Number(raw[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 65535) {
        process.stderr.write("Usage: agent:run [--guard-port <1-65535>] [agent flags]\n");
        return Promise.resolve(2);
      }
      guardPort = v;
    } else passthrough.push(a);
  }
  const devToken = readDevToken();
  if (devToken === null) {
    process.stderr.write("Start the guard first: pnpm guard:dev -- --business <uuid> --enable-execution\n");
    return Promise.resolve(2);
  }
  return startAgent({ guardPort, token: devToken, args: passthrough });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : "agent:run failed"}\n`);
    process.exitCode = 1;
  },
);
