import { describe, expect, it } from 'vitest';
import { DEFAULT_ENSEMBLE_CONFIG } from '../config/defaults.js';
import { profileWorkersToSessionSpecs } from '../profile/types.js';
import { SessionUsageTracker } from '../usage/session-usage-tracker.js';
import { buildSessionModelsSummary } from './build-session-models-summary.js';

describe('buildSessionModelsSummary', () => {
  it('includes configured conductor model, last used model, and worker spawn models', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-1',
      status: 'finished',
      modelId: 'gpt-6-luna',
    });

    const config = {
      ...DEFAULT_ENSEMBLE_CONFIG,
      conductor: { model: 'default', backend: 'pi' as const },
      acp: {
        defaultPreset: 'codex' as const,
        tags: { high: 'strong' },
        models: {
          strong: { model: 'gpt-6.1-terra', reasoning: 'high' },
        },
      },
    };
    const workers = profileWorkersToSessionSpecs(
      {
        workers: [
          { name: 'worker-1', kind: 'implementer', modelTag: 'high' },
          { name: 'reviewer', kind: 'reviewer' },
        ],
      },
      { defaultAcp: { config, env: {} } },
    );

    expect(
      buildSessionModelsSummary({
        backend: 'pi',
        config,
        env: {},
        workers,
        usageTracker: tracker,
      }),
    ).toEqual({
      conductor: {
        backend: 'pi',
        configuredModelId: 'default',
        lastUsedModelId: 'gpt-6-luna',
      },
      workers: [
        {
          name: 'worker-1',
          kind: 'implementer',
          modelTag: 'high',
          acpPreset: 'codex',
          model: 'gpt-6.1-terra',
          reasoning: 'high',
        },
        {
          name: 'reviewer',
          kind: 'reviewer',
          modelTag: 'default',
          acpPreset: 'codex',
        },
      ],
    });
  });

  it.each([
    { explicit: 'cli-model', env: 'env-model', expected: 'cli-model' },
    { explicit: undefined, env: 'env-model', expected: 'env-model' },
    { explicit: undefined, env: undefined, expected: 'config-model' },
  ])(
    'resolves the configured conductor model in precedence order',
    ({ explicit, env, expected }) => {
      const summary = buildSessionModelsSummary({
        backend: 'cursor',
        explicitConductorModelId: explicit,
        env: env ? { CONDUCTOR_MODEL_ID: env } : {},
        config: {
          ...DEFAULT_ENSEMBLE_CONFIG,
          conductor: { model: 'config-model' },
        },
        workers: [],
        usageTracker: new SessionUsageTracker(),
      });

      expect(summary).toEqual({
        conductor: { backend: 'cursor', configuredModelId: expected },
        workers: [],
      });
    },
  );

  it('uses only the final conductor send, even when a worker ran later', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'first',
      status: 'finished',
      modelId: 'first-model',
    });
    tracker.recordConductorRound({
      runId: 'last',
      status: 'finished',
      modelId: 'last-model',
    });
    tracker.recordWorkerRound({
      name: 'worker-1',
      kind: 'implementer',
      prompt: 'work',
      promptResult: { stopReason: 'end_turn', responseText: 'done' },
    });

    expect(
      buildSessionModelsSummary({
        backend: 'cursor', env: {}, workers: [], usageTracker: tracker,
      }).conductor,
    ).toEqual({
      backend: 'cursor',
      configuredModelId: 'default',
      lastUsedModelId: 'last-model',
    });
  });

  it('omits the used model when the final send did not report one', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'first',
      status: 'finished',
      modelId: 'earlier-model',
    });
    tracker.recordConductorRound({ runId: 'last', status: 'error' });

    expect(
      buildSessionModelsSummary({
        backend: 'cursor', env: {}, workers: [], usageTracker: tracker,
      }).conductor,
    ).toEqual({ backend: 'cursor', configuredModelId: 'default' });
  });

  it('keeps a model reported by a failed send', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'failed', status: 'error', modelId: 'selected-model',
    });

    expect(
      buildSessionModelsSummary({
        backend: 'pi', env: {}, workers: [], usageTracker: tracker,
      }).conductor,
    ).toEqual({
      backend: 'pi', configuredModelId: 'default', lastUsedModelId: 'selected-model',
    });
  });

  it('uses the default preset and omits the model when no worker mapping is configured', () => {
    const workers = profileWorkersToSessionSpecs(
      { workers: [{ name: 'reviewer', kind: 'reviewer' }] },
      { defaultAcp: { env: {} } },
    );

    expect(
      buildSessionModelsSummary({
        backend: 'cursor', env: {}, workers, usageTracker: new SessionUsageTracker(),
      }).workers,
    ).toEqual([{
      name: 'reviewer', kind: 'reviewer', modelTag: 'default', acpPreset: 'cursor',
    }]);
  });
});
