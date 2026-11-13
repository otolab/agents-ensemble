import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk, { Chalk } from 'chalk';
import {
  CONDUCTOR_PROVIDER_HISTORY_LIMIT,
  findSessionResumeStore,
  harnessPhaseFromLegacyLifecycle,
  listConductorProviderHistory,
  type ConductorBackend,
  type ConductorProviderHistoryMessage,
  type HarnessPhase,
  type SessionLifecycle,
} from '@agents-ensemble/core/operator-runtime';

export interface SessionTimelineSummary {
  startedAt: number;
  durationMs: number;
  sendCount: number;
  lastRunStatus: string;
  lastError?: { message: string; code?: string };
}

export type SessionTimelineHarnessEvent =
  | {
      kind: 'conductor.send';
      line: number;
      sendCount: number;
      status: string;
      error?: string;
    }
  | {
      kind: 'conductor.transport.reconnect';
      line: number;
      status: 'attempt' | 'succeeded' | 'failed';
      agentId: string;
      error?: string;
      previousSendCountInLog?: number;
    }
  | {
      kind: 'conductor.auth.reconnect';
      line: number;
      status: 'attempt';
      agentId: string;
      previousSendCountInLog?: number;
    };

export interface SessionTimelineSend {
  sendCount: number;
  providerPairStatus:
    | 'available'
    | 'not-found'
    | 'not-correlatable'
    | 'unavailable';
  providerMessages: ConductorProviderHistoryMessage[];
  harnessEvents: SessionTimelineHarnessEvent[];
  summary?: SessionTimelineSummary;
}

export interface SessionTimelineGap {
  missingFromSendCount: number;
  missingThroughSendCount: number;
  beforeSendCount?: number;
  afterSendCount?: number;
  evidence: string[];
  explanation: string;
}

export interface SessionTimelineResult {
  session: {
    conductorAgentId: string;
    issueUrl: string;
    repoRoot: string;
    backend: ConductorBackend;
    lifecycle: SessionLifecycle;
    harnessPhase: HarnessPhase | null;
    updatedAt: number;
  };
  paths: {
    sessionResumeStore: string;
  };
  sources: {
    providerHistory:
      | {
          status: 'available';
          backend: ConductorBackend;
          count: number;
          limit: number;
          hasMore: boolean;
        }
      | {
          status: 'unavailable';
          backend: ConductorBackend;
          reason: string;
        };
    sessionSummary:
      | { status: 'not-provided' }
      | { status: 'available'; path: string }
      | { status: 'unavailable'; path: string; reason: string };
    harnessLog:
      | { status: 'not-provided' }
      | {
          status: 'available';
          path: string;
          lineCount: number;
          recognizedEventCount: number;
        }
      | { status: 'unavailable'; path: string; reason: string };
    sessionLogEvents: {
      status: 'not-persisted';
      reason: string;
    };
    sendCorrelation:
      | {
          status: 'available';
          basis: 'Pi sendCount strictly inside a Date.now-derived SessionSummary window; boundaries excluded as ambiguous; assumes non-overlapping processes and a stable wall clock';
        }
      | { status: 'unavailable'; reason: string };
  };
  sessionSummary: SessionTimelineSummary | null;
  sendTimeline: SessionTimelineSend[];
  uncorrelatedProviderMessages: ConductorProviderHistoryMessage[];
  uncorrelatedHarnessEvents: SessionTimelineHarnessEvent[];
  gaps: SessionTimelineGap[];
}

interface SessionTimelineSummarySource {
  source: SessionTimelineResult['sources']['sessionSummary'];
  summary: SessionTimelineSummary | null;
}

interface SessionTimelineHarnessLogSource {
  source: SessionTimelineResult['sources']['harnessLog'];
  events: SessionTimelineHarnessEvent[];
}

interface MutableSessionTimelineSend {
  sendCount: number;
  providerMessages: ConductorProviderHistoryMessage[];
  harnessEvents: SessionTimelineHarnessEvent[];
  summary?: SessionTimelineSummary;
}

export async function readSavedSessionTimeline(input: {
  repoRoot: string;
  conductorAgentId: string;
  summaryPath?: string;
  harnessLogPath?: string;
}): Promise<SessionTimelineResult> {
  const repoRoot = resolve(input.repoRoot);
  const conductorAgentId = requireNonEmpty(
    input.conductorAgentId,
    'conductorAgentId',
  );
  const located = await findSessionResumeStore(repoRoot, conductorAgentId);
  if (
    !located ||
    resolve(located.resumeStore.repoRoot) !== repoRoot
  ) {
    throw new Error(`No saved session found for ${conductorAgentId}.`);
  }

  const resumeStore = located.resumeStore;
  const backend = resumeStore.conductorBackend ?? 'cursor';
  const [providerHistory, summaryResult, harnessLogResult] =
    await Promise.all([
      readProviderHistory({
        backend,
        conductorAgentId,
        cwd: resumeStore.conductorCwd ?? resumeStore.repoRoot,
        repoRoot: resumeStore.repoRoot,
        ...(resumeStore.cursorBootstrapRunId
          ? { cursorBootstrapRunId: resumeStore.cursorBootstrapRunId }
          : {}),
      }),
      readSessionSummary({
        path: input.summaryPath,
        conductorAgentId,
        issueUrl: resumeStore.issueUrl,
        repoRoot: resumeStore.repoRoot,
      }),
      readHarnessLog(input.harnessLogPath),
    ]);

  const providerMessages =
    providerHistory.status === 'available'
      ? [...providerHistory.messages].reverse()
      : [];
  const providerCorrelationAvailable =
    providerHistory.status === 'available' &&
    backend === 'pi' &&
    summaryResult.source.status === 'available' &&
    summaryResult.summary !== null;
  // Pi keeps history across resume, but the harness sendCount resets per process.
  const correlatableProviderMessages: ConductorProviderHistoryMessage[] = [];
  const providerMessagesOutsideCurrentRun: ConductorProviderHistoryMessage[] =
    [];
  for (const message of providerMessages) {
    if (
      providerCorrelationAvailable &&
      summaryResult.summary &&
      isWithinSessionSummaryWindow(message, summaryResult.summary)
    ) {
      correlatableProviderMessages.push(message);
    } else {
      providerMessagesOutsideCurrentRun.push(message);
    }
  }
  const {
    sendTimeline,
    uncorrelatedProviderMessages: providerMessagesWithoutSendCount,
    uncorrelatedHarnessEvents,
  } = buildSendTimeline({
    backend,
    providerHistoryAvailable: providerHistory.status === 'available',
    providerCorrelationAvailable,
    providerMessages: correlatableProviderMessages,
    harnessEvents: harnessLogResult.events,
    summary: summaryResult.summary,
  });

  return {
    session: {
      conductorAgentId: resumeStore.conductorAgentId,
      issueUrl: resumeStore.issueUrl,
      repoRoot: resumeStore.repoRoot,
      backend,
      lifecycle: resumeStore.lifecycle ?? 'unknown',
      harnessPhase:
        resumeStore.harnessPhase ??
        harnessPhaseFromLegacyLifecycle(resumeStore.lifecycle),
      updatedAt: resumeStore.updatedAt,
    },
    paths: {
      sessionResumeStore: located.path,
    },
    sources: {
      providerHistory:
        providerHistory.status === 'available'
          ? {
              status: 'available',
              backend,
              count: providerHistory.messages.length,
              limit: CONDUCTOR_PROVIDER_HISTORY_LIMIT,
              hasMore: providerHistory.hasMore,
            }
          : { status: 'unavailable', backend, reason: providerHistory.reason },
      sessionSummary: summaryResult.source,
      harnessLog: harnessLogResult.source,
      sessionLogEvents: {
        status: 'not-persisted',
        reason:
          'SessionLogEvent は通常の session 保存先に履歴として保存されません。reconnect の確認には captured harness log が必要です。',
      },
      sendCorrelation:
        providerHistory.status !== 'available'
          ? {
              status: 'unavailable',
              reason: 'provider history を読めないため send 番号を照合できません。',
            }
          : backend === 'pi'
            ? providerCorrelationAvailable
              ? {
                  status: 'available',
                  basis:
                    'Pi sendCount strictly inside a Date.now-derived SessionSummary window; boundaries excluded as ambiguous; assumes non-overlapping processes and a stable wall clock',
                }
              : {
                  status: 'unavailable',
                  reason:
                    'Pi sendCount は run ごとに再利用されます。対象 run の有効な時間窓を示す SessionSummary がないため provider history と照合しません。',
                }
            : {
                status: 'unavailable',
                reason:
                  'Cursor provider history に harness の sendCount がないため、log の send 番号とは照合しません。',
              },
    },
    sessionSummary: summaryResult.summary,
    sendTimeline,
    uncorrelatedProviderMessages: [
      ...providerMessagesOutsideCurrentRun,
      ...providerMessagesWithoutSendCount,
    ],
    uncorrelatedHarnessEvents,
    gaps: buildTimelineGaps({
      backend,
      providerHistory:
        providerCorrelationAvailable && providerHistory.status === 'available'
          ? {
              ...providerHistory,
              messages: correlatableProviderMessages,
            }
          : undefined,
      sendTimeline,
    }),
  };
}

export function formatSessionTimelineText(
  result: SessionTimelineResult,
): string {
  const color = outputChalk();
  const providerHistory = result.sources.providerHistory;
  const summary = result.sources.sessionSummary;
  const harnessLog = result.sources.harnessLog;
  const lines = [
    `${color.bold(result.session.conductorAgentId)} (${color.cyan(
      result.session.backend,
    )})`,
    `Issue: ${result.session.issueUrl}`,
    `ResumeStore: ${result.paths.sessionResumeStore}`,
    `保存状態: ${result.session.harnessPhase ?? result.session.lifecycle} / ${formatTimestamp(result.session.updatedAt)}`,
    '',
    'データ源:',
    `  ResumeStore: 読取済み`,
    `  provider history: ${formatProviderSource(providerHistory)}`,
    `  SessionSummary: ${formatOptionalSource(summary)}`,
    `  captured harness log: ${formatOptionalSource(harnessLog)}`,
    `  SessionLogEvent 履歴: 永続化されていません`,
    `  send 番号の照合: ${result.sources.sendCorrelation.status === 'available' ? 'Pi sendCount で照合（境界は除外。process の重複がなく、システム時計が安定している前提）' : result.sources.sendCorrelation.reason}`,
    '',
    'Timeline:',
  ];

  if (result.sessionSummary) {
    lines.splice(
      lines.indexOf('Timeline:'),
      0,
      `  SessionSummary snapshot: started ${formatTimestamp(result.sessionSummary.startedAt)}, duration ${result.sessionSummary.durationMs} ms, sendCount=${result.sessionSummary.sendCount}, lastRunStatus=${result.sessionSummary.lastRunStatus}`,
      ...(result.sessionSummary.lastError
        ? [
            `    lastError${result.sessionSummary.lastError.code ? ` (${result.sessionSummary.lastError.code})` : ''}: ${result.sessionSummary.lastError.message}`,
          ]
        : []),
    );
  }

  if (result.sessionSummary?.sendCount === 0) {
    lines.push('  SessionSummary: send はありません。');
  }

  if (result.sendTimeline.length === 0) {
    lines.push('  照合できる send はありません。');
  }

  for (const send of result.sendTimeline) {
    lines.push('', `send #${send.sendCount}`);

    for (const message of send.providerMessages) {
      lines.push(
        `  provider history ${formatTimestamp(message.at)} (providerId: ${message.providerId})`,
        '    operator → conductor:',
        ...indentLines(message.inbound),
        '    conductor → operator:',
        ...indentLines(message.text),
      );
    }

    if (
      send.providerMessages.length === 0 &&
      send.providerPairStatus === 'not-found'
    ) {
      lines.push(
        `  provider history: send #${send.sendCount} に対応する inbound / response pair は見つかりません。`,
      );
    } else if (
      send.providerMessages.length === 0 &&
      send.providerPairStatus === 'not-correlatable'
    ) {
      const reason =
        result.sources.sendCorrelation.status === 'unavailable'
          ? result.sources.sendCorrelation.reason
          : 'send 番号を照合できません。';
      lines.push(`  provider history: ${reason}`);
    } else if (
      send.providerMessages.length === 0 &&
      send.providerPairStatus === 'unavailable'
    ) {
      lines.push('  provider history: 読み取れませんでした。');
    }

    for (const event of send.harnessEvents) {
      lines.push(...formatHarnessEvent(event));
    }

    if (send.summary) {
      lines.push(
        `  SessionSummary: 最新 send status=${send.summary.lastRunStatus}（個々の send 時刻はありません）`,
      );
    }
  }

  if (result.uncorrelatedProviderMessages.length > 0) {
    lines.push('', '今回の run と send 番号を照合していない provider history:');
    for (const message of result.uncorrelatedProviderMessages) {
      lines.push(
        `  ${formatTimestamp(message.at)} ${message.backend} providerId=${message.providerId}${
          message.sendCount === undefined ? '' : ` sendCount=${message.sendCount}`
        }`,
        '    operator → conductor:',
        ...indentLines(message.inbound),
        '    conductor → operator:',
        ...indentLines(message.text),
      );
    }
  }

  if (result.uncorrelatedHarnessEvents.length > 0) {
    lines.push('', 'send 番号に結び付けられない harness log 行:');
    for (const event of result.uncorrelatedHarnessEvents) {
      lines.push(...formatHarnessEvent(event));
    }
  }

  lines.push('', 'Gaps:');
  if (result.gaps.length === 0) {
    lines.push('  観測できた sendCount gap はありません。');
  } else {
    for (const gap of result.gaps) {
      const range =
        gap.missingFromSendCount === gap.missingThroughSendCount
          ? `send #${gap.missingFromSendCount}`
          : `send #${gap.missingFromSendCount}–#${gap.missingThroughSendCount}`;
      lines.push(`  ${range}: ${gap.explanation}`);
      for (const evidence of gap.evidence) {
        lines.push(`    根拠: ${evidence}`);
      }
    }
  }

  if (providerHistory.status === 'available' && providerHistory.hasMore) {
    lines.push(
      '',
      `provider history は直近 ${providerHistory.limit} 件を表示しています。さらに古い履歴は含まれません。`,
    );
  }

  lines.push(
    '',
    '時刻のない harness log 行はファイル内の行順だけを示します。表示された gap から reconnect の原因や未記録の会話本文は断定できません。',
  );
  return lines.join('\n');
}

function buildSendTimeline(input: {
  backend: ConductorBackend;
  providerHistoryAvailable: boolean;
  providerCorrelationAvailable: boolean;
  providerMessages: ConductorProviderHistoryMessage[];
  harnessEvents: SessionTimelineHarnessEvent[];
  summary: SessionTimelineSummary | null;
}): {
  sendTimeline: SessionTimelineSend[];
  uncorrelatedProviderMessages: ConductorProviderHistoryMessage[];
  uncorrelatedHarnessEvents: SessionTimelineHarnessEvent[];
} {
  const sends = new Map<number, MutableSessionTimelineSend>();
  const uncorrelatedProviderMessages: ConductorProviderHistoryMessage[] = [];
  const uncorrelatedHarnessEvents: SessionTimelineHarnessEvent[] = [];

  const getSend = (sendCount: number): MutableSessionTimelineSend => {
    let send = sends.get(sendCount);
    if (!send) {
      send = { sendCount, providerMessages: [], harnessEvents: [] };
      sends.set(sendCount, send);
    }
    return send;
  };

  for (const message of input.providerMessages) {
    if (Number.isSafeInteger(message.sendCount) && message.sendCount! > 0) {
      getSend(message.sendCount!).providerMessages.push(message);
    } else {
      uncorrelatedProviderMessages.push(message);
    }
  }

  for (const event of input.harnessEvents) {
    if (event.kind === 'conductor.send') {
      getSend(event.sendCount).harnessEvents.push(event);
    } else if (event.previousSendCountInLog !== undefined) {
      getSend(event.previousSendCountInLog).harnessEvents.push(event);
    } else {
      uncorrelatedHarnessEvents.push(event);
    }
  }

  if (input.summary && input.summary.sendCount > 0) {
    getSend(input.summary.sendCount).summary = input.summary;
  }

  const sendTimeline = [...sends.values()]
    .sort((left, right) => left.sendCount - right.sendCount)
    .map((send): SessionTimelineSend => ({
      ...send,
      providerPairStatus: !input.providerHistoryAvailable
        ? 'unavailable'
        : input.backend !== 'pi' || !input.providerCorrelationAvailable
          ? 'not-correlatable'
          : send.providerMessages.length > 0
            ? 'available'
            : 'not-found',
      harnessEvents: [...send.harnessEvents].sort(
        (left, right) => left.line - right.line,
      ),
    }));

  return {
    sendTimeline,
    uncorrelatedProviderMessages,
    uncorrelatedHarnessEvents,
  };
}

function buildTimelineGaps(input: {
  backend: ConductorBackend;
  providerHistory:
    | {
        messages: ConductorProviderHistoryMessage[];
        hasMore: boolean;
      }
    | undefined;
  sendTimeline: SessionTimelineSend[];
}): SessionTimelineGap[] {
  if (!input.providerHistory || input.backend !== 'pi') return [];

  const gaps: SessionTimelineGap[] = [];
  const sendCounts = [
    ...new Set(
      input.providerHistory.messages
        .map((message) => message.sendCount)
        .filter(
          (sendCount): sendCount is number =>
            Number.isSafeInteger(sendCount) && (sendCount as number) > 0,
        ),
    ),
  ].sort((left, right) => left - right);

  for (let index = 1; index < sendCounts.length; index += 1) {
    const beforeSendCount = sendCounts[index - 1]!;
    const afterSendCount = sendCounts[index]!;
    if (afterSendCount <= beforeSendCount + 1) continue;
    gaps.push({
      missingFromSendCount: beforeSendCount + 1,
      missingThroughSendCount: afterSendCount - 1,
      beforeSendCount,
      afterSendCount,
      evidence: [],
      explanation:
        'Pi provider history にこの send 番号の pair がありません。番号の欠落だけでは原因や reconnect の有無は分かりません。',
    });
  }

  for (const send of input.sendTimeline) {
    if (
      send.providerPairStatus !== 'not-found' ||
      (!send.harnessEvents.some(
        (event) => event.kind === 'conductor.send',
      ) &&
        !send.summary)
    ) {
      continue;
    }

    const evidence = [
      ...send.harnessEvents.map((event) => describeHarnessEvent(event)),
      ...(send.summary
        ? [
            `SessionSummary: send #${send.sendCount} status=${send.summary.lastRunStatus}`,
          ]
        : []),
    ];
    const existingGap = gaps.find(
      (gap) =>
        send.sendCount >= gap.missingFromSendCount &&
        send.sendCount <= gap.missingThroughSendCount,
    );
    if (existingGap) {
      existingGap.evidence.push(...evidence);
      existingGap.explanation =
        'Pi provider history に対応する inbound / response pair がありません。履歴 reader は成功した pair を返すため、raw transcript に未対応 entry があるか、なぜ欠けたかはこの情報から判断できません。';
      continue;
    }

    gaps.push({
      missingFromSendCount: send.sendCount,
      missingThroughSendCount: send.sendCount,
      evidence,
      explanation:
        'Pi provider history に対応する inbound / response pair がありません。履歴 reader は成功した pair を返すため、raw transcript に未対応 entry があるか、なぜ欠けたかはこの情報から判断できません。',
    });
  }

  return gaps.sort(
    (left, right) =>
      left.missingFromSendCount - right.missingFromSendCount,
  );
}

async function readProviderHistory(input: {
  backend: ConductorBackend;
  conductorAgentId: string;
  cwd: string;
  repoRoot: string;
  cursorBootstrapRunId?: string;
}): Promise<
  | {
      status: 'available';
      messages: ConductorProviderHistoryMessage[];
      hasMore: boolean;
    }
  | { status: 'unavailable'; reason: string }
> {
  try {
    const history = await listConductorProviderHistory({
      backend: input.backend,
      conductorAgentId: input.conductorAgentId,
      cwd: input.cwd,
      repoRoot: input.repoRoot,
      ...(input.cursorBootstrapRunId
        ? { cursorBootstrapRunId: input.cursorBootstrapRunId }
        : {}),
      query: {
        limit: CONDUCTOR_PROVIDER_HISTORY_LIMIT,
        order: 'desc',
      },
    });
    return { status: 'available', ...history };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: errorMessage(error),
    };
  }
}

async function readSessionSummary(input: {
  path?: string;
  conductorAgentId: string;
  issueUrl: string;
  repoRoot: string;
}): Promise<SessionTimelineSummarySource> {
  if (!input.path) {
    return {
      source: { status: 'not-provided' },
      summary: null,
    };
  }

  const path = resolve(input.path);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return {
      source: {
        status: 'unavailable',
        path,
        reason: errorMessage(error),
      },
      summary: null,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      source: {
        status: 'unavailable',
        path,
        reason: '有効な JSON ではありません。',
      },
      summary: null,
    };
  }

  const parsed = parseSessionSummary(
    value,
    input.conductorAgentId,
    input.issueUrl,
    input.repoRoot,
  );
  if ('reason' in parsed) {
    return {
      source: { status: 'unavailable', path, reason: parsed.reason },
      summary: null,
    };
  }

  return {
    source: { status: 'available', path },
    summary: parsed.summary,
  };
}

function parseSessionSummary(
  value: unknown,
  conductorAgentId: string,
  issueUrl: string,
  repoRoot: string,
): { summary: SessionTimelineSummary } | { reason: string } {
  if (!isRecord(value)) {
    return { reason: 'JSON の最上位は object である必要があります。' };
  }
  if (value.agentId !== conductorAgentId) {
    return {
      reason: 'SessionSummary の agentId が指定した session と一致しません。',
    };
  }
  if (value.issueUrl !== issueUrl) {
    return {
      reason: 'SessionSummary の issueUrl が保存 session と一致しません。',
    };
  }
  if (
    typeof value.repoRoot !== 'string' ||
    resolve(value.repoRoot) !== resolve(repoRoot)
  ) {
    return {
      reason: 'SessionSummary の repoRoot が保存 session と一致しません。',
    };
  }
  if (!Object.hasOwn(value, 'startedAt')) {
    return { reason: 'SessionSummary に startedAt がありません。' };
  }
  const startedAt = value.startedAt;
  if (!isFiniteNumber(startedAt)) {
    return {
      reason: 'SessionSummary の startedAt は数値である必要があります。',
    };
  }
  if (!isDateNowTimestamp(startedAt)) {
    return {
      reason:
        'SessionSummary の startedAt は Date.now() で表せる整数の Unix epoch ms ではありません。',
    };
  }

  if (!Object.hasOwn(value, 'durationMs')) {
    return { reason: 'SessionSummary に durationMs がありません。' };
  }
  const durationMs = value.durationMs;
  if (!isFiniteNumber(durationMs)) {
    return {
      reason: 'SessionSummary の durationMs は数値である必要があります。',
    };
  }
  if (durationMs < 0) {
    return {
      reason:
        'SessionSummary の durationMs が負のため、開始後の時間窓として解釈できません。',
    };
  }
  if (!Number.isSafeInteger(durationMs)) {
    return {
      reason:
        'SessionSummary の durationMs はミリ秒精度を保てる安全な整数ではありません。',
    };
  }

  const endedAt = startedAt + durationMs;
  if (!isDateNowTimestamp(endedAt)) {
    return {
      reason:
        'SessionSummary の時間窓終端 startedAt + durationMs は Date.now() で表せる整数の Unix epoch ms ではありません。',
    };
  }

  if (!Object.hasOwn(value, 'sendCount')) {
    return { reason: 'SessionSummary に sendCount がありません。' };
  }
  const sendCount = value.sendCount;
  if (!Number.isSafeInteger(sendCount) || (sendCount as number) < 0) {
    return {
      reason:
        'SessionSummary の sendCount は 0 以上の安全な整数ではありません。',
    };
  }

  if (!Object.hasOwn(value, 'lastRunStatus')) {
    return { reason: 'SessionSummary に lastRunStatus がありません。' };
  }
  const lastRunStatus = value.lastRunStatus;
  if (typeof lastRunStatus !== 'string') {
    return {
      reason: 'SessionSummary の lastRunStatus は文字列ではありません。',
    };
  }
  if (
    value.lastError !== undefined &&
    (!isRecord(value.lastError) ||
      typeof value.lastError.message !== 'string' ||
      (value.lastError.code !== undefined &&
        typeof value.lastError.code !== 'string'))
  ) {
    return { reason: 'SessionSummary の lastError 形式が不正です。' };
  }

  return {
    summary: {
      startedAt,
      durationMs,
      sendCount: sendCount as number,
      lastRunStatus,
      ...(isRecord(value.lastError)
        ? {
            lastError: {
              message: value.lastError.message as string,
              ...(typeof value.lastError.code === 'string'
                ? { code: value.lastError.code }
                : {}),
            },
          }
        : {}),
    },
  };
}

function isWithinSessionSummaryWindow(
  message: ConductorProviderHistoryMessage,
  summary: SessionTimelineSummary,
): boolean {
  const endAt = summary.startedAt + summary.durationMs;
  // Millisecond timestamps cannot distinguish adjacent runs at either edge.
  return (
    message.at !== undefined &&
    message.at > summary.startedAt &&
    message.at < endAt
  );
}

async function readHarnessLog(
  inputPath?: string,
): Promise<SessionTimelineHarnessLogSource> {
  if (!inputPath) {
    return {
      source: { status: 'not-provided' },
      events: [],
    };
  }

  const path = resolve(inputPath);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    return {
      source: {
        status: 'unavailable',
        path,
        reason: errorMessage(error),
      },
      events: [],
    };
  }

  const events = parseCapturedHarnessLog(content);
  return {
    source: {
      status: 'available',
      path,
      lineCount:
        content.length === 0
          ? 0
          : content.split(/\r?\n/u).length -
            (content.endsWith('\n') ? 1 : 0),
      recognizedEventCount: events.length,
    },
    events,
  };
}

function parseCapturedHarnessLog(
  content: string,
): SessionTimelineHarnessEvent[] {
  const events: SessionTimelineHarnessEvent[] = [];
  let previousSendCount: number | undefined;
  const lines = content.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripAnsi(lines[index]!).trim();
    const sendMatch = /^\[harness\]\s+conductor\.send n=(\d+) status=([^\s]+)/u.exec(
      line,
    );
    if (sendMatch) {
      const sendCount = Number(sendMatch[1]);
      if (!Number.isSafeInteger(sendCount) || sendCount < 1) continue;
      previousSendCount = sendCount;
      const errorMatch = /\serror=(.*)$/u.exec(line);
      events.push({
        kind: 'conductor.send',
        line: index + 1,
        sendCount,
        status: sendMatch[2]!,
        ...(errorMatch
          ? {
              error: errorMatch[1]!.replace(/\s+code=\S+$/u, '').trim(),
            }
          : {}),
      });
      continue;
    }

    const reconnectMatch =
      /^\[harness\]\s+conductor\.transport\.reconnect status=(attempt|succeeded|failed)\s+agentId=([^\s]+)(?:\s+error=(.*))?$/u.exec(
        line,
      );
    if (reconnectMatch) {
      events.push({
        kind: 'conductor.transport.reconnect',
        line: index + 1,
        status: reconnectMatch[1] as 'attempt' | 'succeeded' | 'failed',
        agentId: reconnectMatch[2]!,
        ...(reconnectMatch[3] ? { error: reconnectMatch[3] } : {}),
        ...(previousSendCount !== undefined
          ? { previousSendCountInLog: previousSendCount }
          : {}),
      });
      continue;
    }

    const authReconnectMatch =
      /^(?:\[observation\]\s+)?\[auth\]\s+conductor 再接続を試行 agentId=([^\s]+)/u.exec(
        line,
      );
    if (authReconnectMatch) {
      events.push({
        kind: 'conductor.auth.reconnect',
        line: index + 1,
        status: 'attempt',
        agentId: authReconnectMatch[1]!,
        ...(previousSendCount !== undefined
          ? { previousSendCountInLog: previousSendCount }
          : {}),
      });
    }
  }

  return events;
}

function formatHarnessEvent(
  event: SessionTimelineHarnessEvent,
): string[] {
  const prefix = `  harness log line ${event.line}:`;
  switch (event.kind) {
    case 'conductor.send':
      return [
        `${prefix} conductor.send n=${event.sendCount} status=${event.status}`,
        ...(event.error ? [`    error: ${event.error}`] : []),
      ];
    case 'conductor.transport.reconnect':
      return [
        `${prefix} conductor.transport.reconnect status=${event.status} agentId=${event.agentId}`,
        ...(event.error ? [`    error: ${event.error}`] : []),
        ...(event.previousSendCountInLog !== undefined
          ? [
              `    log order: this row follows the preceding send row #${event.previousSendCountInLog}; it has no shared event ID.`,
            ]
          : []),
      ];
    case 'conductor.auth.reconnect':
      return [
        `${prefix} conductor.auth.reconnect status=attempt agentId=${event.agentId}`,
        ...(event.previousSendCountInLog !== undefined
          ? [
              `    log order: this row follows the preceding send row #${event.previousSendCountInLog}; it has no shared event ID.`,
            ]
          : []),
      ];
  }
}

function describeHarnessEvent(event: SessionTimelineHarnessEvent): string {
  switch (event.kind) {
    case 'conductor.send':
      return `harness log line ${event.line}: send #${event.sendCount} status=${event.status}`;
    case 'conductor.transport.reconnect':
      return `harness log line ${event.line}: transport reconnect ${event.status}`;
    case 'conductor.auth.reconnect':
      return `harness log line ${event.line}: auth reconnect attempt`;
  }
}

function formatProviderSource(
  source: SessionTimelineResult['sources']['providerHistory'],
): string {
  if (source.status === 'unavailable') {
    return `読取不能: ${source.reason}`;
  }
  return `${source.backend} ${source.count} 件（最大 ${source.limit} 件）${
    source.hasMore ? '。さらに古い履歴あり' : ''
  }`;
}

function formatOptionalSource(
  source:
    | SessionTimelineResult['sources']['sessionSummary']
    | SessionTimelineResult['sources']['harnessLog'],
): string {
  switch (source.status) {
    case 'not-provided':
      return '未指定';
    case 'unavailable':
      return `読取不能: ${source.reason}`;
    case 'available':
      if ('recognizedEventCount' in source) {
        return `読取済み: ${source.recognizedEventCount} 件の対象行 (${source.path})`;
      }
      return `読取済み (${source.path})`;
  }
}

function formatTimestamp(value: number | undefined): string {
  if (value === undefined) return '時刻不明';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

function indentLines(text: string): string[] {
  return text.split(/\r?\n/u).map((line) => `      ${line}`);
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDateNowTimestamp(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    new Date(value).getTime() === value
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputChalk() {
  return new Chalk({
    level: process.env.NO_COLOR ? 0 : chalk.level,
  });
}
