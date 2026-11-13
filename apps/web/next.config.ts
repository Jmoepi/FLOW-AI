import type { NextConfig } from "next";
const config: NextConfig = {
  // No framework fingerprint in responses (WB-6).
  poweredByHeader: false,
  reactStrictMode: true,
  // pg is a CommonJS driver with optional native bindings: keep it out of the bundle.
  serverExternalPackages: ["pg"],
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@flow-ai/contracts", "@flow-ai/database", "@flow-ai/policy-engine"],
};
export default config;
