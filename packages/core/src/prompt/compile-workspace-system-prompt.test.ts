import { describe, expect, it } from 'vitest';
import { compileWorkspaceConductorSystemPrompt } from './compile-workspace-system-prompt.js';
import { TEST_PROFILE } from './testing/test-profile.js';

describe('compileWorkspaceConductorSystemPrompt', () => {
  it('combines common conductor tools with workspace instructions without ticket guidance', () => {
    const prompt = compileWorkspaceConductorSystemPrompt({
      workspaceSlugKey: 'research', profile: TEST_PROFILE, briefText: '調査する',
    });
    expect(prompt).toContain('resolve_permission');
    expect(prompt).toContain('list_open_questions');
    expect(prompt).toContain('create_note');
    expect(prompt).toContain('調査する');
    expect(prompt).not.toMatch(/register_github_watch|github\.update|operator\.githubLogin|Issue #\d|Issue \/ PR を source of truth/);
    expect(prompt).toMatchSnapshot();
  });
});
