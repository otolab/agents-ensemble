import { compile } from '@modular-prompt/core';
import { describe, expect, it } from 'vitest';
import { renderCompiledPrompt } from '../../render-compiled-prompt.js';
import { profilePromptModule } from './profile-prompt-module.js';

describe('profilePromptModule', () => {
  it('returns undefined when bootstrap and materials are empty', () => {
    expect(profilePromptModule({})).toBeUndefined();
    expect(profilePromptModule({ roleBootstrap: '  ' })).toBeUndefined();
  });

  it('puts role bootstrap and materials reference in instructions', () => {
    const prompt = renderCompiledPrompt(
      compile(
        profilePromptModule({
          roleBootstrap: '# role\n\nbootstrap 指示',
          materials: [
            {
              id: 'team',
              title: 'Team definition',
              content: '# team\n\nteam 定義',
            },
          ],
        })!,
      ),
    );

    expect(prompt).toContain('bootstrap 指示');
    expect(prompt).toContain('行動時の定義として読み、従う');
    expect(prompt).toContain('## Prepared Materials');
    expect(prompt).toContain('### Team definition');
    expect(prompt).toContain('team 定義');
  });

  it('includes materials without role bootstrap', () => {
    const prompt = renderCompiledPrompt(
      compile(
        profilePromptModule({
          materials: [
            {
              id: 'team',
              title: 'Team definition',
              content: 'team only',
            },
          ],
        })!,
      ),
    );

    expect(prompt).toContain('行動時の定義として読み、従う');
    expect(prompt).toContain('## Instructions');
    expect(prompt).toContain('## Prepared Materials');
    expect(prompt).toContain('team only');
  });
});
