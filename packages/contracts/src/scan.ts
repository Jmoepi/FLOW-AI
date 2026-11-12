import { SECRET_ENV_NAMES, SECRET_RULES } from "./redact";

/**
 * Pure text scanner behind `pnpm secret-scan` and the pre-commit hook. Returns file:line style findings and
 * NEVER the matched value. Shares its rule table with the redactor so the two cannot drift apart.
 */
export interface ScanFinding {
  line: number;
  rule: string;
}

// eslint-disable-next-line security/detect-non-literal-regexp -- built from constant rule tables, never from input
const ENV_LINE = new RegExp(`^\\s*(?:export\\s+)?(${SECRET_ENV_NAMES.join("|")})\\s*=(.*)$`);

function isPlaceholder(rest: string): boolean {
  if (/^\s+#/.test(rest)) return true; // `NAME= # comment`
  const t = rest.trim().replace(/^["']|["']$/g, "");
  return t === "" || t.startsWith("<");
}

/** Base names that must never be tracked or staged, whatever they contain (matched on the base name only, which is short). */
// eslint-disable-next-line security/detect-unsafe-regex -- every repetition is bounded and the input is a single base name
const FORBIDDEN_NAME = /^(?:\.env(?:\..{1,64})?|[^/]{0,200}\.(?:pem|key|p12|pfx|seed)|[^/]{0,100}wallets[^/]{0,100}\.json|id_(?:rsa|ed25519|ecdsa))$/i;

export function forbiddenFileRule(relPath: string): string | null {
  const p = relPath.replace(/\\/g, "/");
  if (/(^|\/)\.env\.example$/.test(p)) return null;
  if (/(^|\/)\.secrets\//.test(p)) return "secrets-directory-in-scope";
  return FORBIDDEN_NAME.test(p.slice(p.lastIndexOf("/") + 1)) ? "forbidden-file-name (secret material must stay gitignored)" : null;
}

export function scanText(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const env = ENV_LINE.exec(line);
    if (env && !isPlaceholder(env[2] ?? "")) findings.push({ line: i + 1, rule: `non-empty ${env[1]}` });
    for (const { rule, pattern, scanAccept } of SECRET_RULES) {
      if (scanAccept) {
        // eslint-disable-next-line security/detect-non-literal-regexp -- derived from the constant rule table
        const g = new RegExp(pattern.source, `${pattern.flags}g`);
        for (const m of line.matchAll(g)) if (scanAccept(m[0])) findings.push({ line: i + 1, rule });
      } else if (pattern.test(line)) {
        findings.push({ line: i + 1, rule });
      }
    }
  }
  return findings;
}
