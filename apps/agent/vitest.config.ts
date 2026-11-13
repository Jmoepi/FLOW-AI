import { defineConfig } from "vitest/config";
// DB-less unit tests only; database behaviour is covered by packages/database (*.db.test.ts).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/**/*.db.test.ts", "node_modules/**"] } });
