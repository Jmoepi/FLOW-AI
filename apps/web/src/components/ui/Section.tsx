import type { ReactNode } from "react";
/** Labelled section. The heading level is a prop; callers keep exactly one h1 per page. */
export function Section({
  id,
  heading,
  level = 2,
  eyebrow,
  className = "",
  children,
}: {
  id: string;
  heading: ReactNode;
  level?: 1 | 2 | 3;
  eyebrow?: string;
  className?: string;
  children?: ReactNode;
}): ReactNode {
  const H = `h${level}` as const;
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className={`mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 ${className}`.trim()}>
      {eyebrow ? <p className="mb-3 text-sm font-semibold tracking-widest text-accent-3 uppercase">{eyebrow}</p> : null}
      <H id={`${id}-heading`} className="font-display text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        {heading}
      </H>
      {children}
    </section>
  );
}
