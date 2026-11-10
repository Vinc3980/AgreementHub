import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Runs migrations against the test DB once per run.
    globalSetup: ['./test/global-setup.ts'],
    // Tests share one database, so files must not run in parallel.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
