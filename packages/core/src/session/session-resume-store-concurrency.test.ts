import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { saveSessionResumeStore, type SessionResumeStore } from './session-resume-store.js';

const gate = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release: () => release(), arrivals: 0 };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (++gate.arrivals === 2) gate.release();
      await gate.ready;
      return actual.rename(...args);
    },
  };
});

it('keeps overlapping saves to the same store independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resume-store-concurrent-'));
  const path = join(dir, 'store.json');
  const store: SessionResumeStore = {
    version: 1,
    conductorAgentId: 'agent',
    issueUrl: 'https://github.com/org/repo/issues/1',
    repoRoot: dir,
    profile: { workers: [] },
    openQuestions: [],
    sequence: 0,
    workers: {},
    updatedAt: 0,
  };
  try {
    await Promise.all([
      saveSessionResumeStore(path, { ...store, sequence: 1 }),
      saveSessionResumeStore(path, { ...store, sequence: 2 }),
    ]);
    expect([1, 2]).toContain(JSON.parse(await readFile(path, 'utf8')).sequence);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
