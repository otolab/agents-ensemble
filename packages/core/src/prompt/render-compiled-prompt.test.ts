import { describe, expect, it } from 'vitest';
import { compile, merge } from '@modular-prompt/core';
import { bootstrapModule } from './modules/bootstrap.js';
import { workerPromptModule } from './modules/worker-module.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';

describe('renderCompiledPrompt', () => {
  it('renders section titles and dynamic inputs', () => {
    const module = merge(bootstrapModule, workerPromptModule);
    const compiled = compile(module, {
      issueUrl: 'https://github.com/org/repo/issues/1',
      skillName: 'lazy-implementer',
      worktreePath: '/repo/.ensemble/worktrees/issue-1',
    });

    const prompt = renderCompiledPrompt(compiled);

    expect(prompt).toContain('## Objective and Role');
    expect(prompt).toContain('https://github.com/org/repo/issues/1');
    expect(prompt).toContain('lazy-implementer');
    expect(prompt).toContain('personaとfoundationモード');
  });
});
