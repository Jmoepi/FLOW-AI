import type { ReactNode } from "react";
const R = 90;
const r2 = (n: number): number => Math.round(n * 100) / 100;
/** Front-hemisphere dots on a latitude/longitude grid, orthographically projected. Pure computation, no data, no fetch. */
function dots(): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = [];
  for (let lat = -75; lat <= 75; lat += 15) {
    const step = Math.max(15, Math.round(15 / Math.cos((lat * Math.PI) / 180) / 5) * 5);
    for (let lon = -90; lon <= 90; lon += step) {
      const la = (lat * Math.PI) / 180;
      const lo = (lon * Math.PI) / 180;
      out.push({ x: r2(R * Math.cos(la) * Math.sin(lo)), y: r2(-R * Math.sin(la)), r: r2(0.8 + 1.4 * Math.cos(la) * Math.cos(lo)) });
    }
  }
  return out;
}
const DOTS = dots();
export const GLOBE_DOT_COUNT = DOTS.length;
/** Decorative dotted globe. Slow CSS rotation of the dot group, off under reduced motion. */
export function Globe({ className = "" }: { className?: string }): ReactNode {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="-100 -100 200 200" className={`pointer-events-none ${className}`.trim()}>
      <circle cx="0" cy="0" r={R} className="fill-accent/5 stroke-white/10" strokeWidth="0.5" />
      <g className="animate-spin-slow motion-reduce:animate-none origin-center [transform-box:fill-box]">
        {DOTS.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r} className="fill-zinc-300/70" />
        ))}
      </g>
    </svg>
  );
}
