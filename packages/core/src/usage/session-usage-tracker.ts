import type { TokenUsage } from '@cursor/sdk';
import type { PromptResult } from '../acp/types.js';
import { estimateTokenUsageFromText } from './estimate-token-usage.js';
import type {
  LlmTokenCounts,
  LlmUsageRecord,
  SessionContextUtilization,
  SessionUsageAgentTotals,
  SessionUsageRound,
  SessionUsageSummary,
} from './types.js';

export interface SessionUsageTrackerOptions {
  /** テスト用。SDK が limit を返さないため、指定時のみ利用率を算出する。 */
  contextLimitTokens?: number;
}

let roundCounter = 0;

export class SessionUsageTracker {
  private readonly rounds: SessionUsageRound[] = [];
  private readonly contextLimitTokens?: number;

  constructor(options: SessionUsageTrackerOptions = {}) {
    this.contextLimitTokens = options.contextLimitTokens;
  }

  recordConductorRound(input: {
    runId: string;
    status: string;
    usage?: TokenUsage;
    modelId?: string;
  }): SessionUsageRound {
    const usage = input.usage ? fromSdkTokenUsage(input.usage) : null;
    const round: SessionUsageRound = {
      roundId: nextRoundId(),
      agentKind: 'conductor',
      runId: input.runId,
      modelId: input.modelId,
      stopReason: input.status,
      usage,
      recordedAt: Date.now(),
    };
    this.rounds.push(round);
    return round;
  }

  recordWorkerRound(input: {
    name: string;
    kind: string;
    roundKind?: 'bootstrap' | 'instruction';
    prompt: string;
    promptResult: PromptResult;
  }): SessionUsageRound {
    const usage =
      input.promptResult.usage != null
        ? fromAcpUsage(input.promptResult.usage)
        : estimateTokenUsageFromText({
            promptText: input.prompt,
            responseText: input.promptResult.responseText,
          });

    const round: SessionUsageRound = {
      roundId: nextRoundId(),
      agentKind: 'worker',
      agentName: input.name,
      workerKind: input.kind,
      roundKind: input.roundKind,
      stopReason: input.promptResult.stopReason,
      usage,
      recordedAt: Date.now(),
    };
    this.rounds.push(round);
    return round;
  }

  getLatestRound(filter?: {
    agent?: 'conductor' | string;
  }): SessionUsageRound | null {
    if (!filter?.agent) {
      return this.rounds.at(-1) ?? null;
    }
    if (filter.agent === 'conductor') {
      return findLast(this.rounds, (round) => round.agentKind === 'conductor');
    }
    return findLast(
      this.rounds,
      (round) => round.agentKind === 'worker' && round.agentName === filter.agent,
    );
  }

  getSessionSummary(): SessionUsageSummary {
    const conductorRounds = this.rounds.filter((round) => round.agentKind === 'conductor');
    const workerNames = [
      ...new Set(
        this.rounds
          .filter((round) => round.agentKind === 'worker' && round.agentName)
          .map((round) => round.agentName!),
      ),
    ];

    const workers: Record<string, SessionUsageAgentTotals> = {};
    for (const name of workerNames) {
      workers[name] = summarizeAgent(
        this.rounds.filter(
          (round) => round.agentKind === 'worker' && round.agentName === name,
        ),
      );
    }

    const allWithUsage = this.rounds.filter((round) => round.usage != null);

    return {
      totals: {
        rounds: this.rounds.length,
        roundsWithUsage: allWithUsage.length,
        tokens: sumUsageRecords(allWithUsage.map((round) => round.usage!)),
      },
      byAgent: {
        conductor: summarizeAgent(conductorRounds),
        workers,
      },
      context: this.buildContextUtilization(),
      latestRound: this.getLatestRound(),
    };
  }

  private buildContextUtilization(): SessionContextUtilization {
    const usedInputTokens = sumInputTokens(this.rounds);
    if (this.contextLimitTokens == null || this.contextLimitTokens <= 0) {
      return {
        limit: null,
        usedInputTokens,
        percent: null,
        limitUnavailableReason:
          '@cursor/sdk 1.0.27 の RunResult / ModelListItem に context limit が無い。RunConductorSessionOptions.contextLimitTokens 未指定。',
      };
    }

    const percent = Math.min(
      100,
      Math.round((usedInputTokens / this.contextLimitTokens) * 100),
    );
    return {
      limit: this.contextLimitTokens,
      usedInputTokens,
      percent,
    };
  }
}

function nextRoundId(): string {
  roundCounter += 1;
  return `usage-round-${roundCounter}`;
}

function fromSdkTokenUsage(usage: TokenUsage): LlmUsageRecord {
  return {
    source: 'sdk',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

function fromAcpUsage(usage: NonNullable<PromptResult['usage']>): LlmUsageRecord {
  return {
    source: 'acp',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens:
      usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

function summarizeAgent(rounds: SessionUsageRound[]): SessionUsageAgentTotals {
  const withUsage = rounds.filter((round) => round.usage != null);
  return {
    rounds: rounds.length,
    roundsWithUsage: withUsage.length,
    tokens: sumUsageRecords(withUsage.map((round) => round.usage!)),
  };
}

function sumUsageRecords(records: LlmUsageRecord[]): LlmTokenCounts | null {
  if (records.length === 0) {
    return null;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let hasReasoning = false;
  let hasCacheRead = false;
  let hasCacheWrite = false;

  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    totalTokens += record.totalTokens;
    if (record.reasoningTokens != null) {
      hasReasoning = true;
      reasoningTokens += record.reasoningTokens;
    }
    if (record.cacheReadTokens != null) {
      hasCacheRead = true;
      cacheReadTokens += record.cacheReadTokens;
    }
    if (record.cacheWriteTokens != null) {
      hasCacheWrite = true;
      cacheWriteTokens += record.cacheWriteTokens;
    }
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(hasReasoning ? { reasoningTokens } : {}),
    ...(hasCacheRead ? { cacheReadTokens } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens } : {}),
  };
}

function sumInputTokens(rounds: SessionUsageRound[]): number {
  return rounds.reduce((sum, round) => sum + (round.usage?.inputTokens ?? 0), 0);
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      return items[index]!;
    }
  }
  return null;
}

/** テスト用。 */
export function resetSessionUsageRoundCounter(): void {
  roundCounter = 0;
}
