import { describe, it } from 'vitest';
import { hasDispatchWorkerE2eConfig } from './test-config.js';

describe.skipIf(!hasDispatchWorkerE2eConfig())('ensemble issue e2e', () => {
  it('runs conductor issue flow (requires CURSOR_API_KEY + test-acp.yaml)', () => {
    // TODO: wire full conductor e2e when stable test issue is available
  });
});
