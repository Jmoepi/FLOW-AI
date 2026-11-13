/**
 * Read-only size report for the web build (`pnpm --filter @flow-ai/web build` first). Walks .next/static and prints raw
 * and gzip sizes of JS and CSS. It measures bytes on disk only: it says nothing about load time, TTI or phone performance,
 * which need a real browser run (see docs/m6-notes.md). Writes nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { BUDGET, formatBytes, summarize, withinBudget, type FileSize } from "./lib/size-summary";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = path.join(ROOT, "apps", "web", ".next", "static");
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
if (!existsSync(STATIC)) {
  process.stderr.write("No build output found. Run: pnpm --filter @flow-ai/web build\n");
  process.exit(1);
}
const files: FileSize[] = walk(STATIC)
  .filter((f) => /\.(js|css)$/.test(f))
  .map((f) => {
    const buf = readFileSync(f);
    return { path: path.relative(STATIC, f).split(path.sep).join("/"), raw: buf.byteLength, gzip: gzipSync(buf).byteLength };
  });
const s = summarize(files);
const line = (name: string, g: { files: number; raw: number; gzip: number }): string => `${name.padEnd(4)} files=${String(g.files).padStart(3)} raw=${String(g.raw).padStart(8)} B (${formatBytes(g.raw)}) gzip=${String(g.gzip).padStart(8)} B (${formatBytes(g.gzip)})`;
process.stdout.write(`${line("JS", s.js)}\n${line("CSS", s.css)}\n`);
process.stdout.write("Largest JS files (raw):\n");
for (const f of s.largestJs) process.stdout.write(`  ${formatBytes(f.raw).padStart(10)}  gzip ${formatBytes(f.gzip).padStart(9)}  ${f.path}\n`);
const ok = withinBudget(s);
process.stdout.write(`Targets (not measurements): JS gzip <= ${formatBytes(BUDGET.jsGzipBytes)} -> ${ok.js ? "within" : "OVER"}; CSS gzip <= ${formatBytes(BUDGET.cssGzipBytes)} -> ${ok.css ? "within" : "OVER"}\n`);
process.stdout.write("Not measured here: load time, time to interactive, phone performance (no browser run).\n");
