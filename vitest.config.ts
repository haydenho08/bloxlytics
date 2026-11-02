import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Integration tests share one test database and one Redis db, so run files
    // one at a time rather than letting them truncate each other's tables.
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
