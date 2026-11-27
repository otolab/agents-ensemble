import { describe, expect, it } from 'vitest';
import { loadProfile } from './load-profile.js';
import { bundledProfilePath } from './profile-paths.js';
import { sessionStateFromProfile } from './types.js';
import { compileConductorSystemPrompt } from '../prompt/compile-system-prompt.js';
import { buildWorkerAttachPrompt } from '../prompt/build-worker-attach-prompt.js';

const issueUrl = 'https://github.com/example/repo/issues/1';

describe('with-architect bundled profile', () => {
  it('loads by name with a workspace-less architect worker', async () => {
    const { profile, profilePath } = await loadProfile({
      profile: 'with-architect',
      cwd: process.cwd(),
      env: {},
    });

    expect(profilePath).toBe(bundledProfilePath('with-architect'));
    expect(profile.workers.map(({ name, kind, modelTag }) => ({ name, kind, modelTag }))).toEqual([
      { name: 'implementer', kind: 'implementer', modelTag: 'default' },
      { name: 'reviewer', kind: 'reviewer', modelTag: 'default' },
      { name: 'architect', kind: 'architect', modelTag: 'high' },
    ]);
    expect(profile.workers.every(({ workspace }) => workspace === undefined)).toBe(true);
  });

  it('delivers architect materials only to the architect and consultation guidance to the conductor', async () => {
    const { profile } = await loadProfile({
      profile: 'with-architect',
      cwd: process.cwd(),
      env: {},
    });
    const sessionState = sessionStateFromProfile(profile);

    const conductor = compileConductorSystemPrompt({ issueUrl, profile });
    expect(conductor).toContain('標準動作モード（conductor）');
    expect(conductor).toContain('architect への相談');
    expect(conductor).not.toContain('標準動作モード（architect）');

    const attachPrompt = (kind: string) =>
      buildWorkerAttachPrompt({ issueUrl, kind, worktreePath: '/worktree', sessionState });

    const architect = attachPrompt('architect');
    expect(architect).toContain('標準動作モード（architect）');
    expect(architect).toContain('標準動作モード（共通）');
    expect(architect).toContain('安楽椅子探偵型の設計相談役');
    expect(architect).not.toContain('標準動作モード（conductor）');
    expect(architect).not.toContain('標準動作モード（implementer）');
    expect(architect).not.toContain('標準動作モード（reviewer）');

    for (const kind of ['implementer', 'reviewer']) {
      const prompt = attachPrompt(kind);
      expect(prompt).toContain(`標準動作モード（${kind}）`);
      expect(prompt).not.toContain('標準動作モード（architect）');
    }
  });
});
