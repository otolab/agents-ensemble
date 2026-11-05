import { describe, expect, it } from 'vitest';
import { SessionUsageTracker } from '../usage/session-usage-tracker.js';
import { buildSessionModelsSummary } from './build-session-models-summary.js';
import type { SessionWorkerSpec } from '../profile/types.js';

describe('buildSessionModelsSummary', () => {
  it('includes configured conductor model, last used model, and worker spawn models', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-1',
      status: 'finished',
      modelId: 'gpt-6-luna',
    });

    const workers: SessionWorkerSpec[] = [
      {
        name: 'implementer',
        kind: 'implementer',
        modelTag: 'high',
        acpFingerprint: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          modelTag: 'high',
          model: 'gpt-6.1-terra',
        },
      },
      {
        name: 'reviewer',
        kind: 'reviewer',
        modelTag: 'default',
        acpFingerprint: {
          preset: 'codex',
          command: 'codex-acp',
          args: [],
          modelTag: 'default',
          model: 'gpt-6-luna',
        },
      },
    ];

    expect(
      buildSessionModelsSummary({
        backend: 'pi',
        config: {
          conductor: { model: 'default', backend: 'pi', verbose: false },
          acp: { defaultPreset: 'codex' },
        } as import('../config/types.js').EnsembleConfig,
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
          name: 'implementer',
          kind: 'implementer',
          modelTag: 'high',
          acpPreset: 'codex',
          model: 'gpt-6.1-terra',
        },
        {
          name: 'reviewer',
          kind: 'reviewer',
          modelTag: 'default',
          acpPreset: 'codex',
          model: 'gpt-6-luna',
        },
      ],
    });
  });
});
