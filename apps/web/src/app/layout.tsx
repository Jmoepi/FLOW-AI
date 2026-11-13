import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
// Every page is rendered per request: the CSP nonce is per request, and the content is per user (no static caching).
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { default: "Flow AI", template: "%s | Flow AI" },
  description: "Owner controls for Flow AI payment policies (XRPL Testnet).",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
