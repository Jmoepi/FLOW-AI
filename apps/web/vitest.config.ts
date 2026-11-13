import { defineConfig } from "vitest/config";
// DB-less unit tests only; database behaviour is covered by *.db.test.ts (pnpm test:db).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/**/*.db.test.ts", "node_modules/**"] } });
