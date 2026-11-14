# Flow AI web UI design

This document describes the redesigned `apps/web` interface: tokens, components, accessibility decisions, build pipeline, size figures, and what to check by eye. The look follows the supplied "KORTEX" template (near-black, red accent, glass cards, starfield). The text, data and behaviour are Flow AI's own.

## Honest limits of this work

- No browser was available while this was built. Nothing here was looked at on a screen. Layout, spacing, animation and colour inside glass cards are unverified visually.
- What is verified: jsdom tests (jest-axe, keyboard, XSS, CSP static checks), computed WCAG contrast ratios from the token values, a grep of the built output for external origins, and `curl` against the production build.
- Automated checks do not replace a real-browser pass. The checklist is at the end of this file.
- Accessibility goal is WCAG 2.2 AA. Compliance is not claimed.

## Tokens

Defined in `apps/web/src/app/globals.css`: Tailwind v4 `@theme` for utilities, and literal `--name: #hex;` custom properties on `:root`. `test/contrast.test.ts` reads those literals and computes the ratios, so a token change that breaks contrast fails the test.

| Group | Token | Value | Use |
|---|---|---|---|
| Colour | `--bg` / `noir` | `#000000` | Page background (with a bottom radial gradient from `--glow-bottom` `#1a0505`) |
| Colour | `--surface` | `#0a0a0a` | Raised panels |
| Colour | `--text` | `#f4f4f5` | Body and headings |
| Colour | `--muted` | `#a1a1aa` (zinc-400) | Secondary text. Nothing dimmer is used for text |
| Colour | `--link` | `#ff6b7d` | Links on black |
| Colour | `--accent` | `#ef233c` | Brand accent, focus-adjacent glow, the accent strip |
| Colour | `--accent-dark` / `--btn-bg` | `#d90429` | Primary button fill (white text) |
| Colour | `--focus` | `#ffffff` | Focus ring |
| Colour | `--border` / `--rule` | `#71717a` / `#27272a` | Control borders (3:1 or more) and decorative rules |
| Status | `--ok-*` | text `#86efac` on `#052e16` | Success |
| Status | `--warn-*` | text `#fcd34d` on `#3b2400` | Pending or warning |
| Status | `--bad-*` | text `#fca5a5` on `#450a0a` | Blocked, degraded, revoked |
| Status | `--danger-*` | white on `#b91c1c` | Destructive button |
| Status | `--net-*` | `#c7d2fe` on `#1e1b4b` | Testnet badge |
| Radius | `--radius-pill`, `--radius-card` | `9999px`, `1.5rem` | Pills and glass cards |
| Shadow | `--shadow-accent-glow`, `--shadow-card-hover` | red glow, soft red lift | Primary button, card hover |
| Motion | `--duration-fast/base/slow` | 150 / 300 / 400 ms | Transitions |
| Size | `--target` | `2.75rem` (44px) | Minimum interactive height and width |
| Fonts | `--font-display`, `--font-sans`, `--font-mono` | Manrope, Inter, system mono | Headings, body, data |

## Components

Shared primitives are in `apps/web/src/components/ui/`:

- `Icon`: local inline SVG paths (lucide-style, written by hand). `aria-hidden` unless given a title. No icon package.
- `Button`: primary red pill with glow, secondary outline pill. Renders a link or a button.
- `ShinyButton`: black pill with the animated accent border (`.shiny-cta`). Has a visible focus ring. The sweep stops under reduced motion.
- `GlassCard`: black/60 surface, blur, 1px white/8 border. Hover and `focus-within` both raise the border.
- `StatusChip`: icon, text and colour together. Delegated to by `Badge`, so existing callers and `status-vocab.ts` still work.
- `Section`: heading level is a prop. Each page supplies exactly one `h1`.
- `Starfield`: server component. 120 stars from a seeded PRNG (mulberry32), three size groups, SVG `<circle>` elements, drifting upward with a CSS `transform` animation. No client JS, no `style` prop, `aria-hidden`.
- `Globe`: inline SVG dotted sphere, slow CSS rotation, decorative, never fetches.
- `ScrollProgress`: 2px accent bar driven by CSS `animation-timeline: scroll()`. Hidden where unsupported and under reduced motion.
- `GlowOrbs`: blurred red orbs, decorative.
- `MobileMenu` (client component): disclosure with `aria-expanded` and `aria-controls`. Esc closes it and returns focus to the button. From `md` up the links are always inline.
- `Footer`: real routes only, an outlined `FLOW` watermark (`aria-hidden`), and the Testnet line.

Page-level: `Shell` (floating pill nav, skip link first, `<main id="main" tabIndex={-1}>`), `Landing` (public `/`), and restyled views for overview, invoices, payments, suppliers, policy, agent activity, audit, login, and the error, not-found, loading and empty states. Authenticated pages are denser and have no starfield, to keep them fast. The starfield, scroll bar and orbs appear on the landing page only.

## Accessibility decisions

- **Red is brand, not status.** The accent red marks the brand and primary actions. Danger and risk use red only together with an icon and a text label. Examples: blocked is red with a shield-x icon and the word "Blocked". A degraded or revoked signing key is red with an alert icon and text.
- **Status never relies on colour alone.** Success is green with a check and "Paid". Pending is amber with a clock. Blocked is red with shield-x. Degraded or revoked is red with an alert icon.
- **Contrast is computed, not eyeballed.** Every text and background pair is tested at 4.5:1 or more, non-text at 3:1 or more. This includes zinc-400 on black, and black text on the accent strip. Glass cards are approximated as black, which is the worst case for light text over a dark blur.
- **Focus:** 3px white outline with offset on every interactive element, including the pill nav and shiny buttons. Hover effects have `focus-visible` or `focus-within` equivalents.
- **Targets:** 44px minimum height and width for controls (`--target`). Nothing smaller than 24px.
- **Motion:** star drift, globe rotation, border shine, ping, scroll bar, shimmer and card lift are all off under `prefers-reduced-motion`. Under `forced-colors` the glass and shiny effects fall back to system borders.
- **Structure:** one `h1` per page, landmarks (banner, main, contentinfo), skip link first. Decorative layers are `aria-hidden` and `pointer-events-none`.
- **Reflow:** single column at 320px. Tables keep the `data-label` card layout below 40em. The nav collapses to a menu button.
- **Preserved from before:** form labels, error summaries, `aria-describedby`, focus management, the confirm step for risky policy changes, `aria-live` status regions, the persistent Testnet badge.
- **Text only:** `agent_reason` and supplier names remain plain text nodes. No `dangerouslySetInnerHTML`.

## Build pipeline

- **Tailwind CSS v4**, compiled at build time through `@tailwindcss/postcss` (`apps/web/.postcssrc.json`). Both `tailwindcss` and `@tailwindcss/postcss` are exact-pinned devDependencies at 4.3.5. v4 is CSS-first, so there is no `tailwind.config.js` and no `autoprefixer`, which means fewer packages than the v3 set. The output is one static stylesheet served from `'self'`.
- **Fonts:** Manrope and Inter variable fonts (latin subset), committed as woff2 under `apps/web/src/fonts/` with their OFL-1.1 licence texts, loaded with `next/font/local` (`src/app/fonts.ts`). They become same-origin static files at build time. The build and the running app contact no font service. The template's Google Fonts links were not used.
- **CSP:** unchanged. `style-src` still uses the nonce, and `font-src 'self'` already covers the emitted files. The rules in `test/csp-static.test.ts` still hold: no `style` props, no `<script>`, no inline handlers.

## Size: `pnpm web:size`

Measured from the production build on disk. "Before" is `.agents/tasks/ui-redesign/size-before.txt` (main at `3fe235f`). "After" is a fresh `pnpm web:size` run at the end of the work.

| | Before | After | Change |
|---|---|---|---|
| JS files | 16 | 17 | +1 |
| JS raw | 625,443 B (610.8 KiB) | 637,648 B (622.7 KiB) | +12,205 B |
| JS gzip | 194,530 B (190.0 KiB) | 199,507 B (194.8 KiB) | +4,977 B (+4.9 KiB) |
| CSS files | 1 | 1 | 0 |
| CSS raw | 8,603 B (8.4 KiB) | 42,906 B (41.9 KiB) | +34,303 B |
| CSS gzip | 2,470 B (2.4 KiB) | 9,484 B (9.3 KiB) | +7,014 B (+6.9 KiB) |

- The brief allowed about +25 KiB gzip for JS. The measured growth is +4.9 KiB, inside that limit.
- Both totals stay inside the repo budgets: JS gzip at most 250 KiB (194.8 KiB used), CSS gzip at most 20 KiB (9.3 KiB used).
- The report measures file sizes only. Load time, time to interactive and phone performance were not measured (no browser).

## Landing page at `/`

`/` shows the public landing page when the request carries no valid session. Any session at all goes through the existing `requireOwner()` gate, so logged-in behaviour is the same as before. The check is `isLoggedOut()` in `src/server/page-auth.ts`. It uses the same `getSessionContext` path as the owner gate. The proxy, API routes and other pages' redirects are unchanged.

Content: hero with the pitch, a capabilities bento (independent payment guard, owner-set limits, on-ledger kill switch through a revocable regular key, tamper-evident audit, validated XRPL settlement), a how-it-works strip, a "Built on" strip (XRP Ledger Testnet, RLUSD, MCP, as text), a "What it will not do" section, a "Hypothesis we are testing" strip on the accent colour, and the "Testnet only, hackathon MVP" notice. The market statement is worded as an unvalidated assumption.

## Intentionally NOT copied from the template

| Template item | Why it was left out |
|---|---|
| Tailwind Play CDN script | Third-party runtime script. Breaks the nonce CSP. Tailwind is compiled at build time instead. |
| Iconify CDN | Third-party runtime script. Icons are local inline SVG. |
| D3.js and the remote GeoJSON globe | Third-party script and a runtime fetch. The globe is a local inline SVG, decorative, with no data. |
| Google Fonts `<link>` tags and the extra font families | Remote requests, and `font-src 'self'`. Only Manrope and Inter are used, self-hosted. |
| "Trusted by" logo strip | Fabricated customers. Replaced by a text-only "Built on" strip. |
| Testimonial strip | Fabricated quote. Replaced by a labelled hypothesis. |
| Pricing cards, "Recommended" badge | Flow AI has no prices or plans. Replaced by the "What it will not do" section. |
| Hundreds of computed `box-shadow` stars, client-side | Slow and needs inline styles. Stars are generated with a fixed seed on the server as SVG. |
| `xmlns` attribute on inline SVG | Not needed for inline SVG in HTML, and it would add a URL to the output. |
| Decorative statistics and progress figures | Would be invented numbers. Visual bars are decorative or carry text. |

## Manual checks for the owner (real browser)

1. 320px wide: no horizontal scroll on `/`, `/login` and each authenticated page. Tables show as cards or scroll inside a labelled region.
2. Desktop (1280px and wider): nav pill, hero and globe, bento alignment, footer watermark.
3. Keyboard only: first Tab lands on the skip link and it moves focus to main content. Tab order follows the visual order. Focus ring is visible on the nav, shiny CTA, chips, table links and form fields.
4. Nav menu at small width: opens with Enter or Space, Esc closes it and focus returns to the menu button.
5. 200% text zoom (and browser zoom to 400%): nothing is clipped or overlaps.
6. Reduced motion (OS setting): stars, globe, border shine, scroll bar and card lift are static.
7. Contrast by eye inside glass cards, especially muted text over the starfield and over red glow orbs on the landing page.
8. Forced-colors mode (Windows High Contrast): borders and focus rings remain visible.
9. Status chips: blocked, pending, paid and revoked-key states each show icon and text.
10. Policy form: the confirm step for a risky change still appears, and error summary focus still works.
11. Scroll-progress bar: shows in Chromium, is absent (not broken) in browsers without `animation-timeline`.
