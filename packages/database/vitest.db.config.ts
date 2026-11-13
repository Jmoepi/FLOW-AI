import { defineConfig } from "vitest/config";

// Needs the local Docker Postgres (`pnpm db:up`). Files run one at a time; each creates its own throwaway database.
export default defineConfig({
  test: {
    include: ["test/**/*.db.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ["./src/testing/global-setup.ts"],
  },
});
