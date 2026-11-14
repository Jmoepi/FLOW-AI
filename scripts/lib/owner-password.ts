/** Pure helpers for the demo-owner password tools (no I/O, no secrets printed). */

/** Parses KEY=value lines. Accepts LF, CRLF and a stray trailing CR, so a Windows-edited file still parses exactly. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r\n|\n|\r/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2]);
  }
  return out;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1"]);
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}
/** Throws unless the host is loopback. Never includes the host value's credentials (only a host name is passed in). */
export function assertLocalHost(host: string): void {
  if (!isLoopbackHost(host)) throw new Error("Refusing: the target database host is not loopback.");
}

export interface ResetTarget {
  supabase: boolean;
  file: "web-owner.env" | "web-owner.supabase.env";
}
/** `--local` selects the loopback database; `--supabase` additionally needs `--allow-remote`. Exactly one target is required. */
export function parseResetArgs(argv: readonly string[]): ResetTarget {
  const args = argv.filter((a) => a !== "--");
  const known = new Set(["--local", "--supabase", "--allow-remote"]);
  const unknown = args.find((a) => !known.has(a));
  if (unknown !== undefined) throw new Error("Usage: pnpm db:reset-owner-password -- --local   (or: -- --supabase --allow-remote)");
  const local = args.includes("--local");
  const supabase = args.includes("--supabase");
  if (local === supabase) throw new Error("Choose exactly one target: --local or --supabase --allow-remote.");
  if (supabase && !args.includes("--allow-remote")) throw new Error("Refusing: the Supabase (remote) database needs the explicit --allow-remote flag.");
  if (local && args.includes("--allow-remote")) throw new Error("--allow-remote is only valid together with --supabase.");
  return supabase ? { supabase: true, file: "web-owner.supabase.env" } : { supabase: false, file: "web-owner.env" };
}
