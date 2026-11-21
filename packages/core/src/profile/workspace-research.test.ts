import { describe, expect, it } from 'vitest';
import { loadProfile } from './load-profile.js';
import { sessionStateFromProfile } from './types.js';
import { compileWorkspaceConductorSystemPrompt, createWorkspacePiKickoffPrompt } from '../prompt/compile-workspace-system-prompt.js';
import { buildWorkerAttachPrompt } from '../prompt/build-worker-attach-prompt.js';

describe('workspace-research bundled profile', () => {
  it('loads by name and compiles run prompts for the whole team', async () => {
    const { profile, profilePath } = await loadProfile({
      profile: 'workspace-research',
      cwd: process.cwd(),
      env: {},
    });
    expect(profilePath).toContain('workspace-research');
    expect(profile.workers.map(({ kind }) => kind)).toEqual(['explore', 'librarian']);
    expect(profile.workers.every(({ workspace }) => workspace === undefined)).toBe(true);
    const sessionState = sessionStateFromProfile(profile);
    const conductor = compileWorkspaceConductorSystemPrompt({
      workspaceSlugKey: 'smoke', profile, briefText: '調査する',
    });
    expect(conductor).toContain('conductor の役割');
    expect(conductor).toContain('調査する');
    const prompts = [conductor, createWorkspacePiKickoffPrompt('smoke', '調査する')];
    for (const kind of ['explore', 'librarian']) {
      const prompt = buildWorkerAttachPrompt({
        issueUrl: 'workspace://smoke', kind, worktreePath: '/workspace', sessionState,
      });
      expect(prompt).toContain(`${kind} の役割`);
      expect(prompt).not.toContain(kind === 'explore' ? 'librarian の役割' : 'explore の役割');
      prompts.push(prompt);
    }
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/Issue\s*#\s*\d+|PR\s*(?:の)?\s*マージ|Issue\s*\/\s*PR 上の記録/iu);
    }
    for (const material of profile.materials ?? []) {
      expect(material.content).not.toMatch(/Issue|\bPR\b|GitHub/iu);
    }
  });
});
