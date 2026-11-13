import { defineConfig } from "vitest/config";

// Unit tests only (no Docker). Database tests live in *.db.test.ts and run via `pnpm test:db`.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], exclude: ["test/**/*.db.test.ts", "node_modules/**"] },
});
