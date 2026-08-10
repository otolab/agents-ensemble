import type { EnsembleSessionState, Profile } from '../../profile/types.js';
import { sessionStateFromProfile } from '../../profile/types.js';

export const TEST_ISSUE_URL = 'https://github.com/org/repo/issues/42';

export const TEST_PROFILE: Pick<Profile, 'workers' | 'agents'> = {
  workers: [
    { name: 'implementer', kind: 'implementer' },
    { name: 'reviewer', kind: 'reviewer' },
  ],
  agents: {
    conductor: {},
    implementer: {},
    reviewer: {},
  },
};

export const TEST_SESSION_STATE: EnsembleSessionState =
  sessionStateFromProfile(TEST_PROFILE);
