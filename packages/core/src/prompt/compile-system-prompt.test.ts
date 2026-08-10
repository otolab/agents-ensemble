import { describe, expect, it } from 'vitest';
import {
  TEST_ISSUE_URL,
  TEST_PROFILE,
} from './testing/test-profile.js';
import { compileConductorSystemPrompt } from './compile-system-prompt.js';

describe('compileConductorSystemPrompt', () => {
  it('includes ensemble base and conductor instructions', () => {
    const prompt = compileConductorSystemPrompt({
      issueUrl: TEST_ISSUE_URL,
      profile: TEST_PROFILE,
    });

    expect(prompt).toContain('**conductor**');
    expect(prompt).toContain('Issue #42');
    expect(prompt).toContain('Current State');
    expect(prompt).toContain('**implementer**: `implementer`');
    expect(prompt).toContain('参加者');
    expect(prompt).toContain('作業フローの連鎖');
    expect(prompt).toContain('resolve_permission');
  });

  it('merges profile role bootstrap after ensemble instructions', () => {
    const prompt = compileConductorSystemPrompt({
      issueUrl: TEST_ISSUE_URL,
      profile: TEST_PROFILE,
      roleBootstrap: '# conductor 起動文書\n\nprofile 固有の指示。',
    });

    expect(prompt).toContain('profile 固有の指示');
    expect(prompt).toContain('演奏しない');
    expect(prompt).toContain('Instructions');
  });

  it('includes profile materials in Prepared Materials', () => {
    const prompt = compileConductorSystemPrompt({
      issueUrl: TEST_ISSUE_URL,
      profile: {
        ...TEST_PROFILE,
        materials: [
          {
            id: 'team',
            title: 'Team definition',
            content: '# team\n\nprofile team 定義',
          },
        ],
      },
    });

    expect(prompt).toContain('行動時の定義として読み、従う');
    expect(prompt).toContain('## Prepared Materials');
    expect(prompt).toContain('### Team definition');
    expect(prompt).toContain('profile team 定義');
  });
});
