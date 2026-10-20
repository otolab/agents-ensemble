import type { ConductorBackend } from '../config/types.js';
import type { ConductorAgentFactory } from './conductor-agent.js';
import { createCursorSdkConductorAgentFactory } from './cursor-sdk-conductor-agent.js';
import { createPiConductorAgentFactory } from './pi-conductor-agent.js';

/** Select the embedded conductor backend without depending on ConductorSession. */
export function createConductorAgentFactory(
  backend: ConductorBackend,
): ConductorAgentFactory {
  if (backend === 'cursor') {
    return createCursorSdkConductorAgentFactory();
  }
  return createPiConductorAgentFactory();
}
