import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
export type ButtonVariant = "primary" | "secondary";
/** Pill buttons. Targets are 44px tall on mobile and at least 40px from `md` up. Focus ring is explicit as well as global. */
const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-medium transition-colors duration-150 motion-reduce:transition-none md:min-h-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent-dark text-white shadow-accent-glow hover:bg-red-600",
  secondary: "border border-white/20 bg-black/60 text-zinc-100 hover:border-white/40 hover:bg-white/10",
};
export const buttonClass = (variant: ButtonVariant, extra = ""): string => `${BASE} ${VARIANT[variant]} ${extra}`.trim();
type Common = { variant?: ButtonVariant; className?: string; children: ReactNode };
export type ButtonProps = Common & (({ href?: undefined } & ButtonHTMLAttributes<HTMLButtonElement>) | { href: string; "aria-label"?: string });
export function Button(props: ButtonProps): ReactNode {
  const { variant = "primary", className = "", children } = props;
  if (props.href !== undefined) {
    const label = props["aria-label"];
    return (
      <Link href={props.href} className={buttonClass(variant, className)} {...(label ? { "aria-label": label } : {})}>
        {children}
      </Link>
    );
  }
  const { href: _h, variant: _v, className: _c, children: _ch, type = "button", ...rest } = props;
  return (
    <button type={type} className={buttonClass(variant, className)} {...rest}>
      {children}
    </button>
  );
}
