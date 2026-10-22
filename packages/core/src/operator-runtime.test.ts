import { describe, expect, it } from 'vitest';
import {
  listSessionResumeStores,
  listSessionSidecars,
  loadSessionResumeStore,
  loadSessionSidecar,
} from './operator-runtime.js';

describe('operator-runtime session resume exports', () => {
  it('keeps deprecated sidecar aliases mapped to the SessionResumeStore APIs', () => {
    expect(loadSessionSidecar).toBe(loadSessionResumeStore);
    expect(listSessionSidecars).toBe(listSessionResumeStores);
  });
});
