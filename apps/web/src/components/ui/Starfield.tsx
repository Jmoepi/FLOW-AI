import type { ReactNode } from "react";
/** Deterministic seeded PRNG (mulberry32): the same stars on every render, server and client. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GROUPS = [
  { cls: "star-drift-slow", r: 0.9, count: 50 },
  { cls: "star-drift-mid", r: 1.4, count: 40 },
  { cls: "star-drift-fast", r: 2, count: 30 },
] as const;
export const STAR_TOTAL = GROUPS.reduce((n, g) => n + g.count, 0);
const SPAN = 2000;
const r2 = (n: number): number => Math.round(n * 100) / 100;
/**
 * Fixed decorative layer. Each group drifts up by exactly one SPAN (transform only) and is drawn twice, one SPAN apart,
 * so the loop is seamless. No client JS, no style prop; motion stops under prefers-reduced-motion (globals.css).
 */
export function Starfield(): ReactNode {
  const rand = mulberry32(0x464c4f57);
  const groups = GROUPS.map((g) => ({ ...g, stars: Array.from({ length: g.count }, () => ({ x: r2(rand() * 1000), y: r2(rand() * SPAN) })) }));
  return (
    <svg aria-hidden="true" focusable="false" className="pointer-events-none fixed inset-0 -z-10 h-full w-full overflow-hidden fill-white opacity-70" viewBox={`0 0 1000 ${SPAN}`} preserveAspectRatio="xMidYMid slice">
      {groups.map((g) => (
        <g key={g.cls} className={`${g.cls} optimize-gpu`}>
          {[0, SPAN].map((dy) => (
            <g key={dy} transform={`translate(0 ${dy})`}>
              {g.stars.map((s, i) => (
                <circle key={i} cx={s.x} cy={s.y} r={g.r} />
              ))}
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}
