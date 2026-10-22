import { describe, expect, it } from 'vitest';
import {
  listSessionResumeStates,
  listSessionSidecars,
  loadSessionResumeState,
  loadSessionSidecar,
} from './operator-runtime.js';

describe('operator-runtime session resume exports', () => {
  it('keeps deprecated sidecar aliases mapped to the SessionResumeStore APIs', () => {
    expect(loadSessionSidecar).toBe(loadSessionResumeState);
    expect(listSessionSidecars).toBe(listSessionResumeStates);
  });
});
