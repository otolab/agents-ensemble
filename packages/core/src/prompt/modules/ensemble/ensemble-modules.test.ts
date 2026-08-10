import { compile } from '@modular-prompt/core';
import { describe, expect, it } from 'vitest';
import { ensembleContext } from '../../contexts/kind.js';
import { renderCompiledPrompt } from '../../render-compiled-prompt.js';
import {
  TEST_ISSUE_URL,
  TEST_SESSION_STATE,
} from '../../testing/test-profile.js';
import {
  baseModule,
  conductorBaseModule,
  conductorEnsembleModule,
  mergeConductorSystemPrompt,
  mergeWorkerSystemPrompt,
  workerBaseModule,
  workerEnsembleModule,
} from './index.js';

describe('ensemble prompt modules', () => {
  it('exports Base, ConductorBase, WorkerBase as the three foundations', () => {
    expect(baseModule.objective).toBeDefined();
    expect(baseModule.methodology).toBeDefined();
    expect(baseModule.state).toBeDefined();
    expect(conductorBaseModule.objective).toBeDefined();
    expect(workerBaseModule.objective).toBeDefined();
  });

  it('merges Base + ConductorBase for conductor', () => {
    const prompt = renderCompiledPrompt(
      compile(
        conductorEnsembleModule,
        ensembleContext('conductor', TEST_ISSUE_URL, TEST_SESSION_STATE),
      ),
    );

    expect(prompt).toContain('**conductor**');
    expect(prompt).toContain('Issue #42');
    expect(prompt).toContain('Current State');
    expect(prompt).toContain('**implementer**: `implementer`');
    expect(prompt).toContain('`reviewer`');
    expect(prompt).toContain('参加者');
    expect(prompt).toContain('prompt_worker');
    expect(prompt).toContain('resolve_permission');
    expect(prompt).toContain('conductor が決められないことはオペレータが最終判断する');
    expect(prompt).not.toContain('permission を要求する');
  });

  it('merges Base + WorkerBase with kind context', () => {
    const prompt = renderCompiledPrompt(
      compile(
        workerEnsembleModule,
        ensembleContext('implementer', TEST_ISSUE_URL, TEST_SESSION_STATE),
      ),
    );

    expect(prompt).toContain('**implementer**');
    expect(prompt).toContain('Issue #42');
    expect(prompt).toContain('**reviewer**: `reviewer`');
    expect(prompt).toContain('作業の実行は worker');
    expect(prompt).toContain('permission を要求する');
  });

  it('appends profile objective after ensemble objectives', () => {
    const profileModule = {
      objective: ['起動文書固有の objective'],
      terms: ['- **implementer**: 実装を担う worker'],
    };

    const prompt = renderCompiledPrompt(
      compile(
        mergeConductorSystemPrompt(profileModule),
        ensembleContext('conductor', TEST_ISSUE_URL, TEST_SESSION_STATE),
      ),
    );

    const objectiveIndex = prompt.indexOf('Objective and Role');
    const teamObjective = prompt.indexOf('チームで Issue #42', objectiveIndex);
    const ensembleObjective = prompt.indexOf(
      '作業フローの連鎖',
      objectiveIndex,
    );
    const profileObjective = prompt.indexOf('起動文書固有の objective');

    expect(teamObjective).toBeGreaterThan(-1);
    expect(ensembleObjective).toBeGreaterThan(teamObjective);
    expect(profileObjective).toBeGreaterThan(ensembleObjective);
  });

  it('appends profile instructions to worker ensemble instructions', () => {
    const profileModule = {
      instructions: ['- implementer 固有: worktree を作成して PR まで持っていく'],
    };

    const prompt = renderCompiledPrompt(
      compile(
        mergeWorkerSystemPrompt(profileModule),
        ensembleContext('implementer', TEST_ISSUE_URL, TEST_SESSION_STATE),
      ),
    );

    expect(prompt).toContain('**implementer**');
    expect(prompt).toContain('worktree を作成して PR まで持っていく');
  });

  it('keeps base-only content when profile module is omitted', () => {
    const prompt = renderCompiledPrompt(
      compile(
        baseModule,
        ensembleContext('implementer', TEST_ISSUE_URL, TEST_SESSION_STATE),
      ),
    );

    expect(prompt).toContain('Issue / PR');
    expect(prompt).toContain('Issue #42');
    expect(prompt).not.toContain('ask_human');
  });
});
