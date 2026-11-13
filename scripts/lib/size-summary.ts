/** Pure helpers for the web build size report. No file system access here, so they are unit tested. */
export interface FileSize {
  path: string;
  raw: number;
  gzip: number;
}
export interface Group {
  files: number;
  raw: number;
  gzip: number;
}
export interface SizeSummary {
  js: Group;
  css: Group;
  other: Group;
  largestJs: FileSize[];
}
/** Targets, not measurements: the report compares the build against them but they say nothing about real page speed. */
export const BUDGET = { jsGzipBytes: 250 * 1024, cssGzipBytes: 20 * 1024 } as const;
const empty = (): Group => ({ files: 0, raw: 0, gzip: 0 });
export function summarize(files: readonly FileSize[]): SizeSummary {
  const js = empty();
  const css = empty();
  const other = empty();
  for (const f of files) {
    const g = f.path.endsWith(".js") ? js : f.path.endsWith(".css") ? css : other;
    g.files += 1;
    g.raw += f.raw;
    g.gzip += f.gzip;
  }
  const largestJs = files
    .filter((f) => f.path.endsWith(".js"))
    .sort((a, b) => b.raw - a.raw || a.path.localeCompare(b.path))
    .slice(0, 5);
  return { js, css, other, largestJs };
}
export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  return `${(n / 1024).toFixed(1)} KiB`;
}
export function withinBudget(s: SizeSummary): { js: boolean; css: boolean } {
  return { js: s.js.gzip <= BUDGET.jsGzipBytes, css: s.css.gzip <= BUDGET.cssGzipBytes };
}
