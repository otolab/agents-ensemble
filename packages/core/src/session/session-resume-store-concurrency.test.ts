import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SessionOwnership } from './session-ownership.js';
import { saveSessionResumeStore, type SessionResumeStore } from './session-resume-store.js';

it('rejects a store write with a lease from another session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resume-store-concurrent-'));
  const path = join(dir, 'store.json');
  const store: SessionResumeStore = {
    version: 1, conductorAgentId: 'agent', issueUrl: 'https://github.com/org/repo/issues/1',
    repoRoot: dir, profile: { workers: [] }, openQuestions: [], sequence: 0, workers: {}, updatedAt: 0,
  };
  try {
    const first = await SessionOwnership.acquire(path);
    const second = await SessionOwnership.acquire(join(dir, 'other.json'));
    try {
      await expect(second.runWrite((lease) => saveSessionResumeStore(path, store, first, lease))).rejects.toThrow(/invalid/);
    } finally {
      await first.closeWritesAndDrain(); first.release();
      await second.closeWritesAndDrain(); second.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
