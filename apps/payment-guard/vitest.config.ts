import { defineConfig } from "vitest/config";
// DB-less unit tests only; database behaviour is covered by packages/database (*.db.test.ts).
// The first buildApp() in a file pays the cold Fastify plugin load; under `pnpm -r test` (all workspaces in parallel) that
// exceeded the 5 s default on this machine. 20 s gives headroom without hiding a real hang.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/**/*.db.test.ts", "node_modules/**"], testTimeout: 20_000 } });
