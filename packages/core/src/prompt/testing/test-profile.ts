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

/** per-kind materials を prompt compile 経路で検証する profile fixture。 */
export const KIND_FILTER_PROFILE: Profile = {
  ...TEST_PROFILE,
  materials: [
    {
      id: 'common',
      title: 'Common material',
      content: 'fixture common material',
    },
    {
      id: 'conductor-only',
      title: 'Conductor material',
      content: 'fixture conductor-only material',
      kinds: ['conductor'],
    },
    {
      id: 'implementer-only',
      title: 'Implementer material',
      content: 'fixture implementer-only material',
      kinds: ['implementer'],
    },
    {
      id: 'reviewer-only',
      title: 'Reviewer material',
      content: 'fixture reviewer-only material',
      kinds: ['reviewer'],
    },
  ],
};

export const KIND_FILTER_SESSION_STATE: EnsembleSessionState =
  sessionStateFromProfile(KIND_FILTER_PROFILE);
