import { vi } from 'vitest';
import type { ConductorAgentUsage } from '../conductor/conductor-agent.js';

/** conductor モック用の既定 `getUsage()` 応答。 */
export function createMockConductorGetUsage() {
  return vi.fn<() => Promise<ConductorAgentUsage>>().mockResolvedValue({});
}
