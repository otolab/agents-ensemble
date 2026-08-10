import { describe, expect, it } from 'vitest';
import { compile } from '@modular-prompt/core';
import { ensembleContext } from './contexts/kind.js';
import { workerEnsembleModule } from './modules/ensemble/index.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';
import { TEST_SESSION_STATE } from './testing/test-profile.js';

describe('renderCompiledPrompt', () => {
  it('renders worker ensemble system prompt with kind context', () => {
    const prompt = renderCompiledPrompt(
      compile(
        workerEnsembleModule,
        ensembleContext(
          'implementer',
          'https://github.com/org/repo/issues/1',
          TEST_SESSION_STATE,
        ),
      ),
    );

    expect(prompt).toContain('**implementer**');
    expect(prompt).toContain('Issue #1');
    expect(prompt).toContain('Issue / PR');
  });
});
