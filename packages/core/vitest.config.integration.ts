import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration.test.ts'],
    setupFiles: ['test/integration/helpers/cursor-sdk-integration-home.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
