/**
 * Browser-facing security headers (WB-2..WB-6). Pure, so the exact policy is unit-tested. The nonce is generated per
 * request by the proxy (src/proxy.ts) and handed to Next through the request headers so framework scripts carry it.
 */
export type RuntimeMode = "production" | "development" | "test";
const PERMISSIONS_POLICY = [
  "accelerometer",
  "autoplay",
  "bluetooth",
  "camera",
  "clipboard-read",
  "display-capture",
  "geolocation",
  "gyroscope",
  "hid",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "xr-spatial-tracking",
]
  .map((f) => `${f}=()`)
  .join(", ");
/** 128-bit random nonce, base64. Uses Web Crypto so it runs in the proxy and in tests. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function buildCsp(nonce: string, mode: RuntimeMode): string {
  const dev = mode === "development";
  const directives = [
    "default-src 'self'",
    // 'strict-dynamic' lets nonced framework scripts load their chunks; no unsafe-inline, and unsafe-eval only for dev refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (mode === "production") directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
export function buildSecurityHeaders(nonce: string, mode: RuntimeMode): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": buildCsp(nonce, mode),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": PERMISSIONS_POLICY,
    "cross-origin-opener-policy": "same-origin",
    "x-frame-options": "DENY",
    // Authenticated, per-user content: never cached by the browser or an intermediary.
    "cache-control": "no-store",
  };
  if (mode === "production") headers["strict-transport-security"] = "max-age=63072000; includeSubDomains";
  return headers;
}
export function runtimeMode(nodeEnv: string | undefined): RuntimeMode {
  return nodeEnv === "production" ? "production" : nodeEnv === "development" ? "development" : "test";
}
