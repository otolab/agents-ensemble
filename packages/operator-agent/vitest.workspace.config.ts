import { defineConfig } from 'vitest/config';

// These filesystem-only tests do not use the Unix socket setup required by the
// operator-agent integration suite and can therefore also run on Windows.
export default defineConfig({
  test: {
    include: [
      'src/operator-workspace-lock.test.ts',
      'src/operator-workspace-maintenance.test.ts',
    ],
  },
});
