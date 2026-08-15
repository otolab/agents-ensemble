import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'react-ink-textarea/dist/textUtils.js': path.resolve(
        packageRoot,
        'node_modules/react-ink-textarea/dist/textUtils.js',
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['test/e2e/**'],
    testTimeout: 10_000,
  },
  ssr: {
    noExternal: ['ink', 'ink-testing-library', 'react-ink-textarea'],
  },
});
