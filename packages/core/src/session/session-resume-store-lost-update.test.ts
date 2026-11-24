import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SessionOwnership } from './session-ownership.js';
import { loadSessionResumeStore, saveSessionResumeStore, type SessionResumeStore } from './session-resume-store.js';

it('rejects a second owner until the first update is saved and released', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resume-store-lost-update-'));
  const path = join(dir, 'store.json');
  const initial: SessionResumeStore = {
    version: 1, conductorAgentId: 'agent', issueUrl: 'https://github.com/org/repo/issues/1',
    repoRoot: dir, profile: { workers: [] }, openQuestions: [], sequence: 0, workers: {}, updatedAt: 0,
  };
  try {
    const first = await SessionOwnership.acquire(path);
    try {
      await first.runWrite((lease) => saveSessionResumeStore(path, initial, first, lease));
      const snapshot = (await loadSessionResumeStore(path))!;
      await expect(SessionOwnership.acquire(path)).rejects.toThrow(/already in use/);
      await first.runWrite((lease) => saveSessionResumeStore(path, { ...snapshot, sequence: 1 }, first, lease));
    } finally {
      await first.closeWritesAndDrain();
      first.release();
    }
    const second = await SessionOwnership.acquire(path);
    try {
      const snapshot = (await loadSessionResumeStore(path))!;
      await second.runWrite((lease) => saveSessionResumeStore(path, { ...snapshot, lazyWorkers: true }, second, lease));
    } finally {
      await second.closeWritesAndDrain();
      second.release();
    }
    expect(await loadSessionResumeStore(path)).toMatchObject({ sequence: 1, lazyWorkers: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
