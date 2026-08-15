import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['test/e2e/**'],
    testTimeout: 10_000,
  },
  ssr: {
    noExternal: ['ink', 'ink-testing-library', 'react-ink-textarea'],
  },
});
