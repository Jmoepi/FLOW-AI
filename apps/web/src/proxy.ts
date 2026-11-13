import { NextResponse, type NextRequest } from "next/server";
import { buildSecurityHeaders, newNonce, runtimeMode } from "./server/security-headers";
/**
 * Next 16 name for what earlier versions called middleware. Runs on every request except static assets: sets a fresh
 * CSP nonce, forwards it (and the CSP) to the app on the request, and adds the security headers to the response.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const headers = buildSecurityHeaders(nonce, runtimeMode(process.env.NODE_ENV));
  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);
  forwarded.set("content-security-policy", headers["content-security-policy"] ?? "");
  const response = NextResponse.next({ request: { headers: forwarded } });
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}
export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
