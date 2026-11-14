import type { ReactNode } from "react";
import { LINK, PILL, SkipLink, Brand } from "./Shell";
import { Button } from "./ui/Button";
import { Footer } from "./ui/Footer";
import { GlassCard } from "./ui/GlassCard";
import { Globe } from "./ui/Globe";
import { GlowOrbs } from "./ui/GlowOrbs";
import { Icon, type IconName } from "./ui/Icon";
import { MobileMenu } from "./ui/MobileMenu";
import { ScrollProgress } from "./ui/ScrollProgress";
import { Section } from "./ui/Section";
import { ShinyButton } from "./ui/ShinyButton";
import { Starfield } from "./ui/Starfield";
/** Public landing page for logged-out visitors. Static, factual copy (README and spec): no customers, logos, statistics or prices. */
const CAPABILITIES: { icon: IconName; title: string; body: string }[] = [
  { icon: "shield", title: "Independent payment guard", body: "A separate service holds the only signing key. It rebuilds each payment from its own records and signs only when every rule passes. The agent never holds a key." },
  { icon: "scale", title: "Owner-set limits", body: "The business owner sets the payment policy outside the agent. Limits are checked on every request, and risky policy changes need a confirm step." },
  { icon: "key", title: "On-ledger kill switch", body: "The guard signs with a revocable regular key. The owner can revoke it, and the ledger then refuses the guard's payments. Tested on XRPL Testnet." },
  { icon: "ledger", title: "Tamper-evident audit", body: "Policy changes and payment decisions are recorded as audit events, chained so a verify job can detect tampering." },
  { icon: "check", title: "Validated XRPL settlement", body: "Payments are RLUSD on XRPL Testnet. A payment counts as paid only after the ledger validates it, and an explorer link appears only for a validated hash." },
];
const STEPS: { title: string; body: string }[] = [
  { title: "Owner sets limits", body: "Policy lives with the owner, not the agent." },
  { title: "Agent chooses an invoice", body: "It picks the next eligible invoice and asks the guard to pay it." },
  { title: "Guard checks every rule", body: "Amount and destination come from the guard's own records, not from the model." },
  { title: "XRPL validates", body: "The guard signs only on an allow decision. The ledger confirms the result." },
  { title: "Audit records it", body: "Each decision, allowed or blocked, is written to the audit trail." },
];
const WILL_NOT: string[] = [
  "Let the agent hold a signing key or set policy.",
  "Trust an amount or destination supplied by the model.",
  "Pay when a rule fails, or when the owner has turned execution off.",
  "Move real funds. It runs on XRPL Testnet only.",
  "Claim on-ledger enforcement of every limit. The limits are enforced by the guard at the application layer, and the regular key is the on-ledger backstop.",
];
const BUILT_ON = ["XRP Ledger (Testnet)", "RLUSD", "Model Context Protocol (MCP)"];
export function Landing(): ReactNode {
  return (
    <>
      <SkipLink />
      <ScrollProgress />
      <Starfield />
      <GlowOrbs />
      <div aria-hidden="true" className="bg-grid-pattern pointer-events-none fixed inset-0 -z-10" />
      <header className="sticky top-2 z-40 px-3 pt-3">
        <div className={PILL}>
          <Brand name="Flow AI" />
          <MobileMenu label="Menu">
            <nav aria-label="Main">
              <ul className="m-0 flex list-none flex-col gap-1 p-0 md:flex-row">
                <li>
                  <a className={LINK} href="#capabilities">
                    Capabilities
                  </a>
                </li>
                <li>
                  <a className={LINK} href="#how-it-works">
                    How it works
                  </a>
                </li>
                <li>
                  <a className={LINK} href="#limits">
                    What it will not do
                  </a>
                </li>
              </ul>
            </nav>
            <ShinyButton href="/login">Sign in</ShinyButton>
          </MobileMenu>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="max-w-none p-0">
        <section aria-labelledby="hero-heading" className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 pt-16 pb-12 sm:px-6 lg:grid-cols-2 lg:pt-24">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-zinc-200">
              <span aria-hidden="true" className="relative inline-flex size-2">
                <span className="ping-dot absolute inline-flex size-full rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-accent" />
              </span>
              Testnet only, hackathon MVP
            </p>
            <h1 id="hero-heading" className="mt-6 mb-0 font-display text-4xl leading-[1.05] font-semibold tracking-tight text-balance text-white sm:text-5xl lg:text-6xl">
              An AI that pays your suppliers, but can&apos;t spend a cent you haven&apos;t allowed, and you can{" "}
              <span className="bg-gradient-to-r from-white to-[#dc8474] bg-clip-text text-transparent">prove it.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-balance text-zinc-300">
              Flow AI is an autonomous agent that pays supplier invoices in RLUSD on XRPL Testnet, within limits you set and an independent guard enforces.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button href="/login">
                Sign in
                <Icon name="arrow-right" />
              </Button>
              <Button href="#how-it-works" variant="secondary">
                How it works
              </Button>
            </div>
          </div>
          <Globe className="mx-auto hidden w-full max-w-md lg:block" />
        </section>
        <Section id="built-on" heading="Built on" className="py-8">
          <ul className="mt-4 flex list-none flex-wrap gap-3 p-0">
            {BUILT_ON.map((b) => (
              <li key={b} className="rounded-full border border-white/10 bg-white/5 px-4 py-2 font-mono text-sm text-zinc-200">
                {b}
              </li>
            ))}
          </ul>
        </Section>
        <Section id="capabilities" eyebrow="Capabilities" heading="Limits you can check, not just trust">
          <ul className="mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((c) => (
              <li key={c.title} className="flex">
                <GlassCard className="w-full">
                  <span className="inline-flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white">
                    <Icon name={c.icon} className="size-5" />
                  </span>
                  <h3 className="mt-4 mb-2 font-display text-lg font-semibold text-white">{c.title}</h3>
                  <p className="m-0 text-sm text-zinc-300">{c.body}</p>
                </GlassCard>
              </li>
            ))}
            <li className="flex sm:col-span-2 lg:col-span-1">
              <GlassCard className="w-full">
                <p className="m-0 text-xs font-medium tracking-widest text-zinc-400 uppercase">Illustrative example, not live data</p>
                <p className="mt-4 mb-0 flex items-center gap-2 rounded-xl border border-white/10 bg-black/60 p-3 font-mono text-sm text-zinc-100">
                  <Icon name="shield-x" className="size-4 shrink-0" />
                  Blocked: request above the owner&apos;s limit
                </p>
                <p className="mt-3 mb-0 flex items-center gap-2 rounded-xl border border-white/10 bg-black/60 p-3 font-mono text-sm text-zinc-100">
                  <Icon name="check" className="size-4 shrink-0" />
                  Paid: all rules passed, ledger validated
                </p>
              </GlassCard>
            </li>
          </ul>
        </Section>
        <Section id="how-it-works" eyebrow="How it works" heading="Five steps, one way to say yes">
          <ol className="mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-3xl border border-white/10 bg-black/60 p-5">
                <span className="font-mono text-sm text-zinc-400">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="mt-2 mb-2 font-display text-base font-semibold text-white">{s.title}</h3>
                <p className="m-0 text-sm text-zinc-300">{s.body}</p>
              </li>
            ))}
          </ol>
        </Section>
        <section aria-labelledby="hypothesis-heading" className="mt-8 bg-accent text-black">
          <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
            <h2 id="hypothesis-heading" className="m-0 font-display text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Hypothesis we are testing
            </h2>
            <p className="mt-3 mb-0 max-w-3xl text-base font-medium text-balance">
              Importers who pay both cross-border and domestic suppliers may want an agent that can show, from its own records, why each payment was allowed or blocked. This is an unvalidated assumption, not a market finding.
            </p>
          </div>
        </section>
        <Section id="limits" eyebrow="Trust" heading="What it will not do">
          <ul className="mt-8 grid list-none gap-3 p-0 sm:grid-cols-2">
            {WILL_NOT.map((w) => (
              <li key={w} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-black/60 p-4 text-sm text-zinc-200">
                <Icon name="x" className="mt-0.5 size-4 shrink-0" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section id="notice" heading="Testnet only, hackathon MVP" className="pb-4">
          <p className="mt-4 max-w-2xl text-zinc-300">
            This is not production software and not financial advice. It uses XRPL Testnet funds with no real value. Sign in to see the owner dashboard.
          </p>
          <div className="mt-6">
            <ShinyButton href="/login">Sign in</ShinyButton>
          </div>
        </Section>
      </main>
      <Footer />
    </>
  );
}
