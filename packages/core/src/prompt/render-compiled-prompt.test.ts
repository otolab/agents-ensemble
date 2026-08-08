import { describe, expect, it } from 'vitest';
import { merge, compile } from '@modular-prompt/core';
import { bootstrapModule } from './modules/bootstrap.js';
import { defaultAgentModule } from './modules/default-agent-module.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';

describe('renderCompiledPrompt', () => {
  it('renders default agent prompt without skill name', () => {
    const module = merge(bootstrapModule, defaultAgentModule);
    const compiled = compile(module, {
      issueUrl: 'https://github.com/org/repo/issues/1',
      kind: 'ping',
      systemPrompt: 'respond with pong',
      worktreePath: '/tmp/wt',
    });
    const prompt = renderCompiledPrompt(compiled);

    expect(prompt).toContain('https://github.com/org/repo/issues/1');
    expect(prompt).toContain('agent kind: ping');
    expect(prompt).toContain('respond with pong');
    expect(prompt).not.toContain('lazy-implementer');
  });
});
