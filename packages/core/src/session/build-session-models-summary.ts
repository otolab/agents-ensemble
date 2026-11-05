import type { AcpPresetId } from '../acp/resolve-acp-spawn.js';
import type {
  AcpModelTag,
  ConductorBackend,
  EnsembleConfig,
} from '../config/types.js';
import { resolveConductorModelId } from '../conductor/resolve-conductor-model-id.js';
import type { SessionWorkerSpec } from '../profile/types.js';
import type { SessionUsageTracker } from '../usage/session-usage-tracker.js';
export interface SessionConductorModelSummary {
  backend: ConductorBackend;
  /** config / CLI / env から解決した conductor model id。 */
  configuredModelId: string;
  /** 最後に conductor send で報告された model id（あれば）。 */
  lastUsedModelId?: string;
}

export interface SessionWorkerModelSummary {
  name: string;
  kind: string;
  modelTag: AcpModelTag;
  acpPreset: AcpPresetId;
  /** tag mapping から解決した ACP model ID（注入できた場合のみ）。 */
  model?: string;
  /** Configured reasoning effort, when the preset accepts it. */
  reasoning?: string;
  /** Explicit Cursor ACP fast setting, when configured. */
  cursorFast?: boolean;
}

export interface SessionModelsSummary {
  conductor: SessionConductorModelSummary;
  workers: SessionWorkerModelSummary[];
}

export function buildSessionModelsSummary(input: {
  backend: ConductorBackend;
  explicitConductorModelId?: string;
  config?: EnsembleConfig;
  env?: NodeJS.ProcessEnv;
  workers: SessionWorkerSpec[];
  usageTracker: SessionUsageTracker;
}): SessionModelsSummary {
  const lastConductorRound = input.usageTracker.getLatestRound({
    agent: 'conductor',
  });

  return {
    conductor: {
      backend: input.backend,
      configuredModelId: resolveConductorModelId(input.explicitConductorModelId, {
        config: input.config,
        env: input.env,
      }),
      ...(lastConductorRound?.modelId
        ? { lastUsedModelId: lastConductorRound.modelId }
        : {}),
    },
    workers: input.workers.map((worker) => ({
      name: worker.name,
      kind: worker.kind,
      modelTag: worker.modelTag,
      acpPreset: worker.acpFingerprint?.preset ?? 'cursor',
      ...(worker.acpFingerprint?.model
        ? { model: worker.acpFingerprint.model }
        : {}),
      ...(worker.acpFingerprint?.reasoning
        ? { reasoning: worker.acpFingerprint.reasoning }
        : {}),
      ...(worker.acpFingerprint?.cursorFast !== undefined
        ? { cursorFast: worker.acpFingerprint.cursorFast }
        : {}),
    })),
  };
}
