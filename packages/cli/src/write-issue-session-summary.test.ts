import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSessionModelsSummary,
  DEFAULT_ENSEMBLE_CONFIG,
  profileWorkersToSessionSpecs,
  SessionLogger,
  SessionUsageTracker,
  type ConductorSessionResult,
} from '@agents-ensemble/core';
import { writeIssueSessionSummary } from './write-issue-session-summary.js';

const BASE_SESSION_MODELS = {
  conductor: { backend: 'cursor', configuredModelId: 'default' },
  workers: [],
} satisfies ConductorSessionResult['sessionModels'];

const BASE_SUMMARY = {
  agentId: 'agent-1',
  issueUrl: 'https://github.com/org/repo/issues/1',
  repoRoot: '/repo',
  startedAt: 1_750_000_000_000,
  durationMs: 1_250,
  sendCount: 1,
  stopReason: 'completed',
  lastRunStatus: 'finished',
  sessionModels: BASE_SESSION_MODELS,
  workerDispatches: [],
  workerFailures: [],
  escalations: [],
  openQuestions: [],
} satisfies ConductorSessionResult;

describe('writeIssueSessionSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes JSON to stdout', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(BASE_SUMMARY, { format: 'json' });

    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      agentId: 'agent-1',
      sessionModels: BASE_SESSION_MODELS,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('writes text summary to stderr', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(BASE_SUMMARY, { format: 'text' });

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('セッション終了');
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      'conductor (cursor): 設定 default · 報告なし',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('writes a resolved model snapshot to both output formats', () => {
    const config = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      acp: {
        defaultPreset: 'codex' as const,
        tags: { high: 'strong' },
        models: { strong: 'worker-model' },
      },
    };
    const workers = profileWorkersToSessionSpecs(
      { workers: [{ name: 'worker-1', kind: 'implementer', modelTag: 'high' }] },
      { defaultAcp: { config, env: {} } },
    );
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-1', status: 'finished', modelId: 'reported-conductor',
    });
    const sessionModels = buildSessionModelsSummary({
      backend: 'pi',
      explicitConductorModelId: 'configured-conductor',
      env: {},
      config,
      workers,
      usageTracker: tracker,
    });
    const logger = new SessionLogger({
      issueUrl: BASE_SUMMARY.issueUrl, repoRoot: BASE_SUMMARY.repoRoot,
    });
    logger.finish('completed');
    const result = logger.snapshot({
      agentId: 'agent-1', escalations: [], openQuestions: [], sessionModels,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(result, { format: 'json' });
    writeIssueSessionSummary(result, { format: 'text' });

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).sessionModels).toEqual({
      conductor: {
        backend: 'pi',
        configuredModelId: 'configured-conductor',
        lastUsedModelId: 'reported-conductor',
      },
      workers: [{
        name: 'worker-1', kind: 'implementer', modelTag: 'high',
        acpPreset: 'codex', model: 'worker-model',
      }],
    });
    const text = String(errorSpy.mock.calls[0]?.[0]);
    expect(text).toContain('conductor (pi): 設定 configured-conductor · 報告 reported-conductor');
    expect(text).toContain('worker worker-1 (implementer, codex): modelTag high · 起動設定 worker-model');
  });

  it('writes tracker metrics from a ConductorSessionResult through the text formatter', () => {
    const tracker = new SessionUsageTracker({ trackCompactions: true });
    tracker.recordConductorRound({
      runId: 'run-1',
      status: 'finished',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });
    tracker.recordWorkerRound({
      name: 'implementer',
      kind: 'implementer',
      prompt: 'implement the issue',
      promptResult: {
        stopReason: 'end_turn',
        responseText: 'implemented',
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      },
    });
    tracker.recordContextCompaction();
    const result = {
      ...BASE_SUMMARY,
      workerDispatches: [
        {
          name: 'implementer',
          kind: 'implementer',
          source: 'conductor' as const,
          issue: {
            owner: 'org',
            repo: 'repo',
            number: 1,
            url: BASE_SUMMARY.issueUrl,
          },
          worktree: {
            path: '/repo/.ensemble/worktrees/issue-1',
            branch: 'ensemble/issue-1',
            issue: {
              owner: 'org',
              repo: 'repo',
              number: 1,
              url: BASE_SUMMARY.issueUrl,
            },
          },
          prompt: 'implement the issue',
          promptResult: {
            stopReason: 'end_turn',
            responseText: 'implemented',
            usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          },
          acpSessionId: 'acp-1',
        },
      ],
      sessionUsage: tracker.getSessionSummary(),
    } satisfies ConductorSessionResult;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(result, { format: 'text' });

    const text = String(errorSpy.mock.calls[0]?.[0]);
    expect(text).toContain('usage（記録済み）:');
    expect(text).toContain('conductor: input 80 · output 20');
    expect(text).toContain('worker implementer: input 40 · output 10');
    expect(text).toContain('合計: input 120 · output 30');
    expect(text).not.toContain('worker は ACP が usage を返さない');
    expect(text).toContain('コンテキスト圧縮: 1 回');
    expect(text).not.toContain('課金');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('keeps conductor cost scoped when a failed worker has no usage round', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-worker-failure',
      status: 'finished',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });
    const result = {
      ...BASE_SUMMARY,
      workerFailures: [
        {
          workerId: 'worker-implementer',
          name: 'implementer',
          kind: 'implementer',
          issueUrl: BASE_SUMMARY.issueUrl,
          error: 'ACP disconnected after the prompt started',
        },
      ],
      sessionUsage: {
        ...tracker.getSessionSummary(),
        cost: {
          rawCostCents: 51,
          chargedCents: 42,
          scope: 'conductor-only' as const,
        },
      },
    } satisfies ConductorSessionResult;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(result, { format: 'text' });

    const text = String(errorSpy.mock.calls[0]?.[0]);
    expect(text).toContain('worker ラウンド: 0 完了 / 1 失敗');
    expect(text).toContain('合計: input 80 · output 20');
    expect(text).not.toContain('失敗などで usage が未記録');
    expect(text).not.toContain('全体: input 80 / output 20');
    expect(text).toContain(
      '課金（取得できた conductor 実課金。worker 分は未算出）: $0.42 (raw $0.51)',
    );
    expect(text).not.toContain('全体 = conductor');
    expect(text).not.toContain('全体: $0.42');
  });
});
