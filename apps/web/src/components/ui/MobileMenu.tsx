"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
/**
 * Accessible disclosure for the pill nav. Below `md` the children sit in a panel toggled by a button
 * (aria-expanded/aria-controls); Esc closes it and returns focus to the button. From `md` up the panel is always shown
 * inline and the button is hidden, so desktop needs no JS. The panel is in the DOM when closed so server HTML keeps the links.
 */
export function MobileMenu({ label = "Menu", children }: { label?: string; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 px-4 text-sm font-medium text-zinc-100 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:hidden"
      >
        <Icon name={open ? "x" : "menu"} className="size-5" />
        {label}
      </button>
      <div
        id={id}
        className={`${open ? "flex" : "hidden"} absolute inset-x-0 top-full mt-2 flex-col gap-3 rounded-3xl border border-white/10 bg-black/90 p-4 backdrop-blur-xl md:static md:mt-0 md:flex md:flex-1 md:flex-row md:items-center md:justify-end md:gap-4 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none`}
      >
        {children}
      </div>
    </>
  );
}
