import { vi } from 'vitest';

/** conductor モック用の既定 `getUsage()` 応答。 */
export function createMockConductorGetUsage() {
  return vi.fn().mockResolvedValue({
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    runs: [],
  });
}
