import localFont from "next/font/local";
// Self-hosted variable fonts (OFL-1.1, see src/fonts/OFL-*.txt). Emitted as same-origin static assets at build time, so the
// CSP font-src 'self' is enough and nothing is fetched from a third party.
export const manrope = localFont({
  src: "../fonts/manrope-latin-wght-normal.woff2",
  weight: "300 800",
  display: "swap",
  variable: "--font-manrope",
});
export const inter = localFont({
  src: "../fonts/inter-latin-wght-normal.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter",
});
