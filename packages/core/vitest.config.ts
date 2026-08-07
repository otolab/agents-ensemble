import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'test/integration/**',
      'test/e2e/**',
    ],
    testTimeout: 10_000,
  },
});
