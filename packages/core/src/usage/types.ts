import type { ConductorUsageCost } from '../conductor/conductor-agent.js';

/** Token counts for one LLM round or an aggregate. */
export interface LlmTokenCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type LlmUsageSource = 'sdk' | 'acp' | 'estimated';

export interface LlmUsageRecord extends LlmTokenCounts {
  source: LlmUsageSource;
}

export type SessionUsageAgentKind = 'conductor' | 'worker';

export interface SessionUsageRound {
  roundId: string;
  agentKind: SessionUsageAgentKind;
  /** worker 名。conductor のときは省略。 */
  agentName?: string;
  workerKind?: string;
  source?: 'harness' | 'conductor';
  runId?: string;
  modelId?: string;
  stopReason?: string;
  usage: LlmUsageRecord | null;
  recordedAt: number;
}

export interface SessionUsageAgentTotals {
  rounds: number;
  roundsWithUsage: number;
  tokens: LlmTokenCounts | null;
}

export interface SessionUsageCacheStats {
  /** Input-token cache hits divided by input tokens plus cache hits (0–1). */
  cacheHitRate?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SessionUsageCacheSummary {
  totals: SessionUsageCacheStats;
  byAgent: {
    conductor: SessionUsageCacheStats | null;
    workers: Record<string, SessionUsageCacheStats | null>;
  };
}

export interface SessionContextUtilization {
  limit: number | null;
  /** limit 算出に使った累計 input tokens。limit 不明時も参考値として返す。 */
  usedInputTokens: number;
  percent: number | null;
  limitUnavailableReason?: string;
}

export interface SessionUsageSummary {
  totals: {
    rounds: number;
    roundsWithUsage: number;
    tokens: LlmTokenCounts | null;
  };
  byAgent: {
    conductor: SessionUsageAgentTotals;
    workers: Record<string, SessionUsageAgentTotals>;
  };
  context: SessionContextUtilization;
  latestRound: SessionUsageRound | null;
  /** Cache-derived metrics. Omitted when no round reported cache counters. */
  cacheStats?: SessionUsageCacheSummary;
  /** Successful context compactions, when the selected backend has a reliable counter. */
  compactionCount?: number;
  /** Conductor の請求記録（セッション累計。推定値・未取得時は省略）。 */
  cost?: ConductorUsageCost;
}
