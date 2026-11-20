import { CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT } from '@agents-ensemble/core/operator-runtime';
import { randomUUID } from 'node:crypto';
import { DEFAULT_OPERATOR_AGENT_SCHEDULING } from './operator-agent-config.js';

export type OperatorDispatchPriority = 'open_question' | 'normal' | 'idle';

export type OperatorDispatchEvent =
  | {
      type: 'user';
      text: string;
      arrival: number;
      readyAt: number;
    }
  | {
      type: 'report';
      reportType:
        | 'session_state'
        | 'open_question'
        | 'conductor_message'
        | 'idle_candidate';
      conductorAgentId: string;
      issueUrl: string;
      text: string;
      reportId?: string;
      sendCount?: number;
      oversizedSendCounts?: number[];
      priority?: OperatorDispatchPriority;
      arrivalOrder?: number;
      firstQueuedAt?: number;
      eligibleAt?: number;
      batchReadyAt?: number;
      retryReadyAt?: number;
      frozenBatchId?: string;
      frozenPayload?: string;
      arrival: number;
      readyAt: number;
    };

export interface OperatorDispatchState {
  lastDispatchedSourceKey?: string;
  continuationConsumed: boolean;
  focusSessionId?: string;
}

export interface OperatorDispatchBatch {
  sourceKey: string;
  events: OperatorDispatchEvent[];
  usedContinuation: boolean;
  priority?: OperatorDispatchPriority;
  batchId?: string;
  payload?: string;
  selectionReason?: 'focus' | 'oq' | 'continuation' | 'normal_fifo' | 'aged_idle' | 'idle_fifo';
  eligibility?: 'request' | 'threshold' | 'ungated' | 'retry';
  deadlineReason?: 'cap' | 'quiet' | 'tie' | 'unknown';
}

export interface OperatorDispatchScheduling {
  batchMaxWaitMs: number;
  idleAgingMs: number;
  focusInactivityTimeoutMs: number;
  pushThreshold?: number;
  reportWeights?: Record<Extract<OperatorDispatchEvent, { type: 'report' }>['reportType'], number>;
}

export const DEFAULT_OPERATOR_DISPATCH_SCHEDULING: OperatorDispatchScheduling = {
  batchMaxWaitMs: DEFAULT_OPERATOR_AGENT_SCHEDULING.batchMaxWaitMs,
  idleAgingMs: DEFAULT_OPERATOR_AGENT_SCHEDULING.idleAgingMs,
  focusInactivityTimeoutMs:
    DEFAULT_OPERATOR_AGENT_SCHEDULING.focusInactivityTimeoutMs,
};

export interface OperatorDispatchQueue {
  subscribe(listener: () => void): () => void;
  enqueueUser(text: string): boolean;
  enqueueReport(
    event: Omit<Extract<OperatorDispatchEvent, { type: 'report' }>, 'arrival' | 'readyAt'>,
    debounceMs: number,
  ): void;
  enqueueReports(
    events: readonly Omit<
      Extract<OperatorDispatchEvent, { type: 'report' }>,
      'arrival' | 'readyAt'
    >[],
    debounceMs: number,
  ): void;
  enqueueDebouncedReports(
    events: readonly Omit<
      Extract<OperatorDispatchEvent, { type: 'report' }>,
      'arrival' | 'readyAt'
    >[],
    debounceMs: number,
  ): void;
  reconcileReports?(
    reports: readonly {
      event: Omit<
        Extract<OperatorDispatchEvent, { type: 'report' }>,
        'arrival' | 'readyAt'
      >;
      readyAt: number;
    }[],
  ): void;
  deferWatchReports?(conductorAgentId: string, debounceMs: number): void;
  discardQueuedReports?(reportIds: readonly string[]): void;
  requeue(event: OperatorDispatchEvent, delayMs: number): void;
  setConversationHold(hold: boolean): {
    heldEventCount: number;
    releasedEventCount: number;
  };
  setHold(hold: boolean): { heldEventCount: number; releasedEventCount: number };
  setFocus(conductorAgentId?: string, now?: number): string | undefined;
  noteOperatorInput(now?: number): void;
  requestReports(conductorAgentId: string): boolean;
  completeReportRequest(events: readonly OperatorDispatchEvent[]): void;
  listPendingReports(): Array<{ conductorAgentId: string; count: number }>;
  selectBatch(
    state: OperatorDispatchState,
    now?: number,
  ): OperatorDispatchBatch | undefined;
  isBatchCurrent(batch: OperatorDispatchBatch, state: OperatorDispatchState): boolean;
  commitBatch(batch: OperatorDispatchBatch, finalize?: () => void): boolean;
  rollbackBatchCommit(batch: OperatorDispatchBatch): void;
  takeBatch(state: OperatorDispatchState, now?: number): OperatorDispatchBatch | undefined;
  nextReadyAt(now?: number): number | undefined;
  waitForChange(timeoutMs?: number): Promise<void>;
  wake(): void;
  readonly heldEventCount: number;
  readonly pendingEventCount: number;
  readonly pendingUserCount: number;
  readonly conversationHold: boolean;
  readonly reportHold: boolean;
  readonly hold: boolean;
  readonly focusSessionId: string | undefined;
  readonly batchMaxWaitMs: number;
}

export function operatorEventSourceKey(event: OperatorDispatchEvent): string {
  if (event.type === 'user') return 'user';
  return reportSourceKey(event);
}

function reportSourceKey(
  event: Pick<
    Extract<OperatorDispatchEvent, { type: 'report' }>,
    'reportType' | 'conductorAgentId'
  >,
): string {
  return `session:${event.conductorAgentId}`;
}

export function selectOperatorDispatchBatch(
  queue: readonly OperatorDispatchEvent[],
  state: OperatorDispatchState,
  now = Date.now(),
  maxUserInputBytes = CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
  scheduling: Pick<OperatorDispatchScheduling, 'batchMaxWaitMs' | 'idleAgingMs'> =
    DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
  alreadyReady?: OperatorDispatchBatch,
  readyHeads?: WeakSet<OperatorDispatchEvent>,
  deadlineReasons?: WeakMap<OperatorDispatchEvent, NonNullable<OperatorDispatchBatch['deadlineReason']>>,
  onFocusDeferred?: (event: Extract<OperatorDispatchEvent, { type: 'report' }>) => void,
): { batch: OperatorDispatchBatch; remaining: OperatorDispatchEvent[] } | undefined {
  const ordered = [...queue].sort(compareDispatchEvents);
  const readyUsers = ordered.filter(
    (event) => event.type === 'user' && event.readyAt <= now,
  );
  const sessions = new Map<
    string,
    { events: Extract<OperatorDispatchEvent, { type: 'report' }>[]; readyAt: number; priority: OperatorDispatchPriority; hasQuestion: boolean }
  >();
  for (const event of ordered) {
    if (event.type !== 'report') continue;
    const sourceKey = operatorEventSourceKey(event);
    const group = sessions.get(sourceKey) ?? {
      events: [],
      readyAt: 0,
      priority: 'idle' as const,
      hasQuestion: false,
    };
    group.events.push(event);
    sessions.set(sourceKey, group);
  }

  const candidates: Array<{
    sourceKey: string;
    events: Extract<OperatorDispatchEvent, { type: 'report' }>[];
    order: number;
    readyAt: number;
    priority: OperatorDispatchPriority;
    hasQuestion: boolean;
    aged: boolean;
  }> = [];
  for (const [sourceKey, group] of sessions) {
    const first = group.events[0]!;
    const frozenBatchId = first.frozenBatchId;
    const events = frozenBatchId
      ? group.events.filter((event) => event.frozenBatchId === frozenBatchId)
      : group.events.filter((event) => !event.frozenBatchId);
    if (events.length === 0) continue;

    const readyAt = frozenBatchId
      ? Math.max(
          ...events.map((event) =>
            event.retryReadyAt ?? 0,
          ),
        )
      : Math.min(
          ...events.map((event) => event.batchReadyAt ?? Infinity),
          Math.max(...events.map((event) => event.readyAt)),
          Math.min(
            ...events.map(
              (event) =>
                (event.firstQueuedAt ?? event.readyAt) +
                scheduling.batchMaxWaitMs,
            ),
          ),
        );
    const originallySelected = alreadyReady?.events[0];
    const remainsSelectedHead =
      alreadyReady?.sourceKey === sourceKey &&
      originallySelected === first;
    if (
      readyAt > now &&
      !remainsSelectedHead &&
      (frozenBatchId !== undefined || !readyHeads?.has(first))
    ) continue;
    if (!frozenBatchId && readyAt <= now) {
      if (deadlineReasons && !deadlineReasons.has(first)) {
        const quietAt = Math.max(...events.map((event) => event.readyAt));
        const capAt = Math.min(...events.map((event) =>
          (event.firstQueuedAt ?? event.readyAt) + scheduling.batchMaxWaitMs));
        const retained = events.some((event) => event.batchReadyAt !== undefined);
        deadlineReasons.set(first, retained ? 'unknown' : quietAt === capAt ? 'tie' : quietAt < capAt ? 'quiet' : 'cap');
      }
      readyHeads?.add(first);
    }

    const priority: OperatorDispatchPriority = events.some(
      (event) => event.priority === 'open_question',
    )
      ? 'open_question'
      : events.some((event) => event.priority !== 'idle')
        ? 'normal'
        : 'idle';
    const eligibleAt = Math.min(
      ...events.map((event) => event.eligibleAt ?? event.firstQueuedAt ?? event.readyAt),
    );
    const aged = priority === 'idle' && now >= eligibleAt + scheduling.idleAgingMs;
    candidates.push({
      sourceKey,
      events,
      order: eventOrder(first),
      readyAt,
      priority,
      hasQuestion: events.some((event) => event.reportType === 'open_question'),
      aged,
    });
  }

  if (readyUsers.length === 0 && candidates.length === 0) return undefined;
  const user = readyUsers[0];
  let sourceKey: string;
  let usedContinuation = false;
  let selectionReason: OperatorDispatchBatch['selectionReason'];
  let selectedCandidate:
    | (typeof candidates)[number]
    | undefined;
  if (user) {
    sourceKey = 'user';
  } else {
    const focus = state.focusSessionId
      ? candidates.find(
          (candidate) =>
            candidate.sourceKey === `session:${state.focusSessionId}`,
        )
      : undefined;
    const question = candidates
      .filter((candidate) => candidate.hasQuestion)
      .sort((left, right) => left.order - right.order)[0];
    selectedCandidate = focus ?? question;
    if (focus && onFocusDeferred) {
      for (const candidate of candidates) {
        if (candidate !== focus) for (const event of candidate.events) onFocusDeferred(event);
      }
    }
    if (focus) selectionReason = 'focus';
    else if (question) selectionReason = 'oq';
    if (
      !selectedCandidate &&
      !state.continuationConsumed &&
      state.lastDispatchedSourceKey?.startsWith('session:')
    ) {
      selectedCandidate = candidates.find(
        (candidate) =>
          candidate.sourceKey === state.lastDispatchedSourceKey,
      );
      usedContinuation = selectedCandidate !== undefined;
      if (selectedCandidate) selectionReason = 'continuation';
    }
    if (!selectedCandidate) {
      const normalFifo = candidates
        .filter((candidate) => candidate.priority === 'normal' || candidate.aged)
        .sort((left, right) => left.order - right.order);
      selectedCandidate =
        normalFifo[0] ??
        candidates.sort((left, right) => left.order - right.order)[0];
      selectionReason = selectedCandidate?.aged ? 'aged_idle'
        : selectedCandidate?.priority === 'normal' ? 'normal_fifo' : 'idle_fifo';
    }
    if (!selectedCandidate) return undefined;
    sourceKey = selectedCandidate.sourceKey;
  }

  let events: OperatorDispatchEvent[] = user
    ? readyUsers
    : [...(selectedCandidate?.events ?? [])];
  if (sourceKey === 'user') {
    const bounded: OperatorDispatchEvent[] = [];
    let inputBytes = 0;
    for (const event of events) {
      if (event.type !== 'user') break;
      const eventBytes = Buffer.byteLength(event.text, 'utf8');
      if (eventBytes > maxUserInputBytes) break;
      if (bounded.length > 0 && inputBytes + eventBytes > maxUserInputBytes) {
        break;
      }
      bounded.push(event);
      inputBytes += eventBytes;
    }
    events = bounded;
    if (events.length === 0) return undefined;
  }
  const selected = new Set(events);
  const frozen = events.find(
    (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
      event.type === 'report' && event.frozenBatchId !== undefined,
  );
  return {
    batch: {
      sourceKey,
      events,
      usedContinuation,
      ...(selectionReason ? { selectionReason } : {}),
      ...(selectedCandidate ? { deadlineReason: deadlineReasons?.get(selectedCandidate.events[0]!) ?? 'unknown' } : {}),
      ...(selectedCandidate ? { priority: selectedCandidate.aged ? 'normal' : selectedCandidate.priority } : {}),
      ...(frozen?.frozenBatchId ? { batchId: frozen.frozenBatchId } : {}),
      ...(frozen?.frozenPayload ? { payload: frozen.frozenPayload } : {}),
    },
    remaining: queue.filter((event) => !selected.has(event)),
  };
}

function eventOrder(event: OperatorDispatchEvent): number {
  return event.type === 'report'
    ? event.arrivalOrder ?? event.arrival
    : event.arrival;
}

function compareDispatchEvents(
  left: OperatorDispatchEvent,
  right: OperatorDispatchEvent,
): number {
  return eventOrder(left) - eventOrder(right) || left.arrival - right.arrival;
}

export function formatOperatorDispatchBatch(
  events: readonly OperatorDispatchEvent[],
): string {
  if (events.length === 0) return '';
  if (events.length === 1 && events[0]!.type === 'user') {
    return events[0]!.text;
  }
  if (
    events.every((event) => event.type === 'report')
  ) {
    const reports = events.filter(
      (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
        event.type === 'report',
    );
    const reportTypes = new Set(reports.map((event) => event.reportType));
    if (reportTypes.size === 1 && reportTypes.has('conductor_message')) {
      const messages = aggregateOversizedConductorMessageWarnings(reports);
      if (messages.length === 1) {
        return ['## Conductor の発言', '', messages[0]!.text].join('\n');
      }
      return [
        `## Conductor の発言（${messages.length} 件）`,
        ...messages.map((event, index) =>
          [`### ${index + 1}/${messages.length}`, '', event.text].join('\n'),
        ),
      ].join('\n\n');
    }
    if (reportTypes.size === 1 && reportTypes.has('open_question')) {
      const hasLifecycleChange = reports.some(
        (event) =>
          event.text.includes('\n解決:') ||
          event.text.includes('\n一覧から消失:'),
      );
      const title = hasLifecycleChange
        ? 'Open Question の変化'
        : 'Open Question 追加';
      if (reports.length === 1) {
        return [`## ${title}`, '', reports[0]!.text].join('\n');
      }
      return [
        `## ${title}（${reports.length} 件）`,
        '',
        ...reports.map((event, index) =>
          [`### ${index + 1}/${reports.length}`, '', event.text].join('\n'),
        ),
      ].join('\n\n');
    }
    if (reportTypes.size > 1) {
      const typeLabels: Record<
        Extract<OperatorDispatchEvent, { type: 'report' }>['reportType'],
        string
      > = {
        session_state: 'セッション状態',
        open_question: 'Open Question',
        conductor_message: 'Conductor の発言',
        idle_candidate: '稼働 session の確認候補',
      };
      const formattedReports = aggregateOversizedConductorMessageWarnings(
        reports,
      );
      return [
        `## セッション報告（${reports.length} 件）`,
        ...formattedReports.map((event, index) =>
          [
            `### ${index + 1}/${formattedReports.length} — ${typeLabels[event.reportType]}`,
            '',
            event.text,
          ].join('\n'),
        ),
      ].join('\n\n');
    }
  }
  if (events.length === 1) {
    const event = events[0]!;
    return [
      '## セッション報告',
      '',
      event.text,
    ].join('\n');
  }

  const title =
    events[0]!.type === 'user'
      ? `## user 発話（${events.length} 件）`
      : `## セッション報告（${events.length} 件）`;
  return [
    title,
    '',
    ...events.map((event, index) =>
      [`### ${index + 1}/${events.length}`, '', event.text].join('\n'),
    ),
  ].join('\n\n');
}

function aggregateOversizedConductorMessageWarnings(
  reports: readonly Extract<OperatorDispatchEvent, { type: 'report' }>[],
): Extract<OperatorDispatchEvent, { type: 'report' }>[] {
  const result: Extract<
    OperatorDispatchEvent,
    { type: 'report' }
  >[] = [];
  let adjacentWarnings: Extract<
    OperatorDispatchEvent,
    { type: 'report' }
  >[] = [];
  const flushWarnings = () => {
    if (adjacentWarnings.length === 0) return;
    const firstWarning = adjacentWarnings[0]!;
    const sendCounts = [
      ...new Set(
        adjacentWarnings.flatMap((event) => event.oversizedSendCounts ?? []),
      ),
    ].sort((left, right) => left - right);
    result.push({
      ...firstWarning,
      text: formatOversizedConductorMessageWarning(
        firstWarning.issueUrl,
        firstWarning.conductorAgentId,
        sendCounts,
      ),
      sendCount: sendCounts.at(-1)!,
      oversizedSendCounts: sendCounts,
    });
    adjacentWarnings = [];
  };
  for (const report of reports) {
    if ((report.oversizedSendCounts?.length ?? 0) > 0) {
      adjacentWarnings.push(report);
      continue;
    }
    flushWarnings();
    result.push(report);
  }
  flushWarnings();
  return result;
}

export function formatOversizedConductorMessageWarning(
  issueUrl: string,
  conductorAgentId: string,
  sendCounts: readonly number[],
): string {
  return [
    `対象: ${issueUrl} (${conductorAgentId})`,
    `⚠ ${sendCounts.length}件の発言は単独のUDS responseが1 MiBを超えたため読み取れず、本文を切り詰めずにlistenで読み飛ばしました（sendCount: ${sendCounts.join(', ')}）。`,
  ].join('\n');
}

export interface OperatorClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

const realOperatorClock: OperatorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function createOperatorDispatchQueue(
  scheduling: OperatorDispatchScheduling = DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
  clock: OperatorClock = realOperatorClock,
  onSchedulingEvent?: (event: Record<string, unknown>) => void,
): OperatorDispatchQueue {
  let arrival = 0;
  let held: Extract<OperatorDispatchEvent, { type: 'report' }>[] = [];
  let pending: OperatorDispatchEvent[] = [];
  const readyHeads = new WeakSet<OperatorDispatchEvent>();
  const deadlineReasons = new WeakMap<OperatorDispatchEvent, NonNullable<OperatorDispatchBatch['deadlineReason']>>();
  const inFlightReportIds = new Set<string>();
  const retryReadyAtById = new Map<string, number>();
  const requestedReports = new Map<string, Set<string>>();
  const requestKey = (event: Extract<OperatorDispatchEvent, { type: 'report' }>) =>
    event.reportId ? `id:${event.reportId}` : `arrival:${event.arrival}`;
  let conversationHold = false;
  let reportHold = false;
  let focusSessionId: string | undefined;
  let focusLastInputAt: number | undefined;
  let lastOperatorInputAt: number | undefined;
  let firstFocusActivationAt: number | undefined;
  const deferred = new Set<string>();
  const record = (event: Record<string, unknown>) => {
    try { onSchedulingEvent?.(event); } catch { /* diagnostic only */ }
  };
  const recordDeferred = (event: Extract<OperatorDispatchEvent, { type: 'report' }>, now: number) => {
    if (!event.reportId || deferred.has(event.reportId)) return;
    deferred.add(event.reportId);
    record({ type: 'report.deferred_by_focus', ts: now, reportId: event.reportId, conductorAgentId: event.conductorAgentId });
  };
  const isHeld = () => conversationHold || reportHold;
  const hasReport = (reportId: string) =>
    inFlightReportIds.has(reportId) ||
    pending.some(
      (event) => event.type === 'report' && event.reportId === reportId,
    ) ||
    held.some((event) => event.reportId === reportId);
  const clearExpiredFocus = (now: number) => {
    if (
      focusSessionId &&
      focusLastInputAt !== undefined &&
      now - focusLastInputAt >= scheduling.focusInactivityTimeoutMs
    ) {
      record({ type: 'focus.clear', ts: now, reason: 'timeout', conductorAgentId: focusSessionId });
      focusSessionId = undefined;
      focusLastInputAt = undefined;
      deferred.clear();
      notify();
    }
  };
  const orderReports = (
    reports: Extract<OperatorDispatchEvent, { type: 'report' }>[],
  ) => reports.sort(compareDispatchEvents);
  const eligibleReports = (now: number): OperatorDispatchEvent[] => {
    if (scheduling.pushThreshold === undefined || !scheduling.reportWeights) return pending;
    const groups = new Map<string, Extract<OperatorDispatchEvent, { type: 'report' }>[]>();
    for (const event of pending) {
      if (event.type !== 'report') continue;
      const group = groups.get(event.conductorAgentId) ?? [];
      group.push(event);
      groups.set(event.conductorAgentId, group);
    }
    const eligible = new Set<string>();
    for (const [id, reports] of groups) {
      orderReports(reports);
      const first = reports[0]!;
      if (requestedReports.has(id)) {
        if (!first.frozenBatchId) {
          if (!deadlineReasons.has(first)) deadlineReasons.set(first, 'unknown');
          readyHeads.add(first);
        }
        eligible.add(id);
        continue;
      }
      if (focusSessionId) {
        for (const report of reports) {
          recordDeferred(report, now);
        }
        continue;
      }
      if (first.frozenBatchId) {
        eligible.add(id);
        continue;
      }
      let weight = 0;
      let reachedAt: number | undefined;
      for (const report of reports) {
        if (report.frozenBatchId) break;
        weight += scheduling.reportWeights?.[report.reportType] ?? 0;
        if (weight >= scheduling.pushThreshold) {
          reachedAt = report.firstQueuedAt ?? now;
          break;
        }
      }
      if (reachedAt === undefined) continue;
      const quietAt = Math.max(...reports.map((report) => report.readyAt));
      if (Math.min(quietAt, reachedAt + scheduling.batchMaxWaitMs) <= now) {
        if (!deadlineReasons.has(first)) {
          const capAt = reachedAt + scheduling.batchMaxWaitMs;
          deadlineReasons.set(first, reports.some((report) => report.batchReadyAt !== undefined)
            ? 'unknown' : quietAt === capAt ? 'tie' : quietAt < capAt ? 'quiet' : 'cap');
        }
        readyHeads.add(first);
        eligible.add(id);
      }
    }
    return pending.filter((event) => event.type === 'user' || eligible.has(event.conductorAgentId));
  };
  const latchReadyBeforeUpdate = (sourceKeys: Set<string>, now: number) => {
    for (const sourceKey of sourceKeys) {
      const reports = orderReports(
        [...pending, ...held].filter(
          (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
            event.type === 'report' &&
            !event.frozenBatchId &&
            operatorEventSourceKey(event) === sourceKey,
        ),
      );
      const first = reports[0];
      if (!first) continue;
      const readyAt = Math.min(
        ...reports.map((event) => event.batchReadyAt ?? Infinity),
        Math.max(...reports.map((event) => event.readyAt)),
        Math.min(...reports.map((event) =>
          (event.firstQueuedAt ?? event.readyAt) + scheduling.batchMaxWaitMs)),
      );
      if (readyAt <= now) {
        const belowThreshold = scheduling.pushThreshold !== undefined && scheduling.reportWeights &&
          reports.reduce((total, report) => total + (scheduling.reportWeights?.[report.reportType] ?? 0), 0) < scheduling.pushThreshold;
        if (!belowThreshold && !deadlineReasons.has(first)) {
          const quietAt = Math.max(...reports.map((event) => event.readyAt));
          const capAt = Math.min(...reports.map((event) =>
            (event.firstQueuedAt ?? event.readyAt) + scheduling.batchMaxWaitMs));
          deadlineReasons.set(first, scheduling.pushThreshold !== undefined || reports.some((event) => event.batchReadyAt !== undefined)
            ? 'unknown' : quietAt === capAt ? 'tie' : quietAt < capAt ? 'quiet' : 'cap');
        }
        readyHeads.add(first);
      }
    }
  };
  const updateHold = (
    previousHold: boolean,
  ): { heldEventCount: number; releasedEventCount: number } => {
    const hold = isHeld();
    if (previousHold === hold) {
      notify();
      return { heldEventCount: held.length, releasedEventCount: 0 };
    }
    if (hold) {
      const reports = pending.filter(
        (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
          event.type === 'report',
      );
      held.push(...reports);
      pending = pending.filter((event) => event.type === 'user');
      notify();
      return { heldEventCount: held.length, releasedEventCount: 0 };
    }
    const releasedEventCount = held.length;
    pending = [...pending, ...held].sort((left, right) => left.arrival - right.arrival);
    held = [];
    notify();
    return { heldEventCount: 0, releasedEventCount };
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enqueueUser(text) {
      const normalizedText = text.trim();
      if (
        !normalizedText ||
        Buffer.byteLength(text, 'utf8') > CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT
      ) {
        return false;
      }
      pending.push({
        type: 'user',
        text,
        arrival: arrival++,
        readyAt: 0,
      });
      notify();
      return true;
    },
    enqueueReport(event, debounceMs) {
      this.enqueueReports([event], debounceMs);
    },
    enqueueReports(events, debounceMs) {
      if (events.length === 0) return;
      const now = clock.now();
      latchReadyBeforeUpdate(new Set(events.map(reportSourceKey)), now);
      const readyAt = now + Math.max(0, debounceMs);
      let added = false;
      for (const event of events) {
        const priority =
          event.priority ??
          (event.reportType === 'idle_candidate'
            ? 'idle'
            : event.reportType === 'open_question'
              ? 'open_question'
              : 'normal');
        if (event.reportId && hasReport(event.reportId)) continue;
        const next = {
          ...event,
          priority,
          arrivalOrder: event.arrivalOrder ?? arrival,
          firstQueuedAt: event.firstQueuedAt ?? now,
          ...(priority === 'idle'
            ? { eligibleAt: now }
            : {}),
          arrival: arrival++,
          readyAt,
        };
        if (isHeld()) held.push(next);
        else pending.push(next);
        added = true;
      }
      if (added) notify();
    },
    enqueueDebouncedReports(events, debounceMs) {
      if (events.length === 0) return;
      const now = clock.now();
      const readyAt = now + Math.max(0, debounceMs);
      const sourceKeys = new Set(events.map(reportSourceKey));
      latchReadyBeforeUpdate(sourceKeys, now);
      let changed = false;
      for (const event of pending) {
        if (
          event.type === 'report' &&
          !event.frozenBatchId &&
          sourceKeys.has(operatorEventSourceKey(event))
        ) {
          event.readyAt = readyAt;
          changed = true;
        }
      }
      for (const event of held) {
        if (
          !event.frozenBatchId &&
          sourceKeys.has(operatorEventSourceKey(event))
        ) {
          event.readyAt = readyAt;
          changed = true;
        }
      }
      for (const event of events) {
        const priority =
          event.priority ??
          (event.reportType === 'idle_candidate'
            ? 'idle'
            : event.reportType === 'open_question'
              ? 'open_question'
              : 'normal');
        if (event.reportId && hasReport(event.reportId)) continue;
        const sourceKey = reportSourceKey(event);
        const next = {
          ...event,
          priority,
          arrivalOrder: event.arrivalOrder ?? arrival,
          firstQueuedAt: event.firstQueuedAt ?? now,
          ...(priority === 'idle'
            ? { eligibleAt: now }
            : {}),
          arrival: arrival++,
          readyAt,
        };
        if (isHeld()) held.push(next);
        else pending.push(next);
        changed = true;
      }
      pending.sort(compareDispatchEvents);
      held.sort(compareDispatchEvents);
      if (changed) notify();
    },
    reconcileReports(reports) {
      const desired = new Map(
        reports.flatMap(({ event, readyAt, ...metadata }) =>
          event.reportId
            ? [[event.reportId, { event, readyAt, ...metadata }] as const]
            : [],
        ),
      );
      const pendingBefore = pending.length;
      const heldBefore = held.length;
      pending = pending.filter(
        (event) =>
          event.type !== 'report' ||
          !event.reportId ||
          desired.has(event.reportId),
      );
      held = held.filter(
        (event) => !event.reportId || desired.has(event.reportId),
      );
      let changed = pending.length !== pendingBefore || held.length !== heldBefore;

      for (const [reportId, persisted] of desired) {
        const readyAt = Math.max(
          persisted.readyAt,
          persisted.event.retryReadyAt ?? 0,
          retryReadyAtById.get(reportId) ?? 0,
        );
        const queued = [...pending, ...held].find(
          (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
            event.type === 'report' && event.reportId === reportId,
        );
        if (queued) {
          if (
            queued.readyAt !== readyAt ||
            queued.arrivalOrder !== persisted.event.arrivalOrder ||
            queued.firstQueuedAt !== persisted.event.firstQueuedAt ||
            queued.eligibleAt !== persisted.event.eligibleAt ||
            queued.batchReadyAt !== persisted.event.batchReadyAt ||
            queued.priority !== persisted.event.priority ||
            queued.frozenBatchId !== persisted.event.frozenBatchId ||
            queued.frozenPayload !== persisted.event.frozenPayload ||
            queued.retryReadyAt !== persisted.event.retryReadyAt
          ) {
            Object.assign(queued, persisted.event, { readyAt });
            changed = true;
          }
          continue;
        }
        if (inFlightReportIds.has(reportId)) continue;

        const next = {
          ...persisted.event,
          arrival: persisted.event.arrivalOrder ?? arrival,
          readyAt,
        };
        arrival = Math.max(arrival, next.arrival + 1);
        if (isHeld()) held.push(next);
        else pending.push(next);
        changed = true;
      }
      pending.sort(compareDispatchEvents);
      held.sort(compareDispatchEvents);
      for (const [id, requested] of requestedReports) {
        for (const key of requested) {
          if (key.startsWith('id:') && !desired.has(key.slice(3)) &&
              !inFlightReportIds.has(key.slice(3))) requested.delete(key);
        }
        if (requested.size === 0) requestedReports.delete(id);
      }
      for (const reportId of retryReadyAtById.keys()) {
        if (!desired.has(reportId) && !inFlightReportIds.has(reportId)) {
          retryReadyAtById.delete(reportId);
        }
      }
      if (changed) notify();
    },
    deferWatchReports(conductorAgentId, debounceMs) {
      const readyAt = clock.now() + Math.max(0, debounceMs);
      latchReadyBeforeUpdate(new Set([`session:${conductorAgentId}`]), clock.now());
      for (const event of [...pending, ...held]) {
        if (
          event.type === 'report' &&
          !event.frozenBatchId &&
          event.conductorAgentId === conductorAgentId &&
          event.reportType !== 'conductor_message'
        ) {
          event.readyAt = readyAt;
        }
      }
      notify();
    },
    discardQueuedReports(reportIds) {
      const ids = new Set(reportIds);
      if (ids.size === 0) return;
      const pendingBefore = pending.length;
      const heldBefore = held.length;
      let changed = false;
      pending = pending.filter(
        (event) =>
          event.type !== 'report' ||
          event.reportId === undefined ||
          !ids.has(event.reportId),
      );
      held = held.filter(
        (event) => event.reportId === undefined || !ids.has(event.reportId),
      );
      changed =
        pending.length !== pendingBefore ||
        held.length !== heldBefore;
      for (const [id, requested] of requestedReports) {
        for (const reportId of ids) requested.delete(`id:${reportId}`);
        if (requested.size === 0) requestedReports.delete(id);
      }
      for (const reportId of ids) {
        if (inFlightReportIds.delete(reportId)) changed = true;
        if (retryReadyAtById.delete(reportId)) changed = true;
      }
      if (changed) notify();
    },
    requeue(event, delayMs) {
      if (event.type === 'user') {
        pending.push({ ...event, arrival: arrival++, readyAt: clock.now() });
      } else {
        const readyAt = clock.now() + Math.max(0, delayMs);
        const reportId = event.reportId;
        if (reportId) {
          inFlightReportIds.delete(reportId);
          retryReadyAtById.set(reportId, readyAt);
          const queued = [...pending, ...held].find(
            (candidate): candidate is Extract<OperatorDispatchEvent, { type: 'report' }> =>
              candidate.type === 'report' && candidate.reportId === reportId,
          );
          if (queued) {
            queued.retryReadyAt = readyAt;
            notify();
            return;
          }
        }
        const next = {
          ...event,
          arrivalOrder: event.arrivalOrder ?? event.arrival,
          retryReadyAt: readyAt,
          arrival: event.arrival,
          readyAt: event.readyAt,
        };
        if (isHeld()) held.push(next);
        else pending.push(next);
        pending.sort(compareDispatchEvents);
        held.sort(compareDispatchEvents);
      }
      notify();
    },
    setConversationHold(nextHold) {
      const previousHold = isHeld();
      conversationHold = nextHold;
      return updateHold(previousHold);
    },
    setHold(nextHold) {
      const previousHold = isHeld();
      reportHold = nextHold;
      return updateHold(previousHold);
    },
    setFocus(conductorAgentId, now = clock.now()) {
      const previous = focusSessionId;
      const normalized = conductorAgentId?.trim();
      focusSessionId = normalized || undefined;
      if (focusSessionId !== previous) {
        deferred.clear();
        if (focusSessionId) {
          record({ type: 'focus.set', ts: now, conductorAgentId: focusSessionId });
        } else if (previous) {
          record({ type: 'focus.clear', ts: now, reason: 'manual', conductorAgentId: previous });
        }
      }
      if (!focusSessionId) {
        focusLastInputAt = undefined;
      } else if (!previous) {
        // The TTY input handler records its human input before applying the
        // focus command. Tool calls can activate or switch focus, but cannot
        // move an existing human-input deadline forward. If no human input
        // has been observed, seed a one-time fallback from first activation.
        firstFocusActivationAt ??= now;
        focusLastInputAt = lastOperatorInputAt ?? firstFocusActivationAt;
      }
      notify();
      return previous;
    },
    noteOperatorInput(now = clock.now()) {
      lastOperatorInputAt = now;
      if (!focusSessionId) return;
      focusLastInputAt = now;
      notify();
    },
    requestReports(conductorAgentId) {
      const id = conductorAgentId.trim();
      const reports = [...pending, ...held].filter(
        (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
          event.type === 'report' && event.conductorAgentId === id,
      );
      if (!id || reports.length === 0) return false;
      const requested = requestedReports.get(id) ?? new Set<string>();
      for (const report of reports) requested.add(requestKey(report));
      requestedReports.set(id, requested);
      notify();
      return true;
    },
    completeReportRequest(events) {
      for (const event of events) {
        if (event.type !== 'report') continue;
        const requested = requestedReports.get(event.conductorAgentId);
        if (!requested) continue;
        requested.delete(requestKey(event));
        if (requested.size === 0) requestedReports.delete(event.conductorAgentId);
      }
    },
    listPendingReports() {
      const counts = new Map<string, number>();
      for (const event of [...pending, ...held]) {
        if (event.type === 'report') {
          counts.set(event.conductorAgentId, (counts.get(event.conductorAgentId) ?? 0) + 1);
        }
      }
      return [...counts].map(([conductorAgentId, count]) => ({ conductorAgentId, count }));
    },
    selectBatch(state, now = clock.now()) {
      clearExpiredFocus(now);
      const selected = selectOperatorDispatchBatch(
        eligibleReports(now),
        { ...state, focusSessionId },
        now,
        CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
        scheduling,
        undefined,
        readyHeads,
        deadlineReasons,
        (event) => recordDeferred(event, now),
      );
      if (selected?.batch.sourceKey.startsWith('session:')) {
        const id = selected.batch.sourceKey.slice('session:'.length);
        selected.batch.eligibility = selected.batch.batchId ? 'retry'
          : requestedReports.has(id) ? 'request'
          : scheduling.pushThreshold !== undefined && scheduling.reportWeights ? 'threshold'
          : 'ungated';
      }
      return selected?.batch;
    },
    isBatchCurrent(batch, state) {
      clearExpiredFocus(clock.now());
      const eligible = eligibleReports(clock.now());
      const selectionNow = clock.now();
      const selected = selectOperatorDispatchBatch(
        eligible,
        { ...state, focusSessionId },
        selectionNow,
        CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
        scheduling,
        batch,
        readyHeads,
        deadlineReasons,
        (event) => recordDeferred(event, selectionNow),
      )?.batch;
      if (
        !selected ||
        selected.sourceKey !== batch.sourceKey ||
        selected.events[0] !== batch.events[0]
      ) {
        return false;
      }
      batch.usedContinuation = selected.usedContinuation;
      batch.selectionReason = selected.selectionReason;
      batch.deadlineReason = selected.deadlineReason;
      const id = batch.sourceKey.startsWith('session:') ? batch.sourceKey.slice('session:'.length) : '';
      batch.eligibility = selected.batchId ? 'retry'
        : requestedReports.has(id) ? 'request'
        : scheduling.pushThreshold !== undefined && scheduling.reportWeights ? 'threshold'
        : 'ungated';
      return true;
    },
    commitBatch(batch, finalize) {
      let events = batch.events;
      if (batch.sourceKey !== 'user' && !batch.batchId) {
        const appendable = orderReports(
          pending.filter(
            (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
              event.type === 'report' &&
              operatorEventSourceKey(event) === batch.sourceKey &&
              !event.frozenBatchId,
          ),
        );
        if (appendable.length > 0) {
          events = appendable;
          batch.events.splice(0, batch.events.length, ...appendable);
          const batchId = randomUUID();
          const payload = formatOperatorDispatchBatch(appendable);
          batch.batchId = batchId;
          batch.payload = payload;
          const memberPriority: OperatorDispatchPriority = appendable.some(
            (event) => event.priority === 'open_question',
          )
            ? 'open_question'
            : appendable.some((event) => event.priority !== 'idle')
              ? 'normal'
              : 'idle';
          batch.priority =
            memberPriority === 'idle' && batch.priority === 'normal'
              ? 'normal'
              : memberPriority;
          for (const event of appendable) {
            event.frozenBatchId = batchId;
            event.frozenPayload = payload;
          }
        }
      } else if (batch.batchId) {
        const frozenReports = orderReports(
          pending.filter(
            (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
              event.type === 'report' &&
              event.frozenBatchId === batch.batchId,
          ),
        );
        if (frozenReports.length > 0) {
          events = frozenReports;
          batch.events.splice(0, batch.events.length, ...frozenReports);
          batch.payload = frozenReports[0]!.frozenPayload;
        }
      }
      const selected = new Set(events);
      const previousLength = pending.length;
      pending = pending.filter((event) => !selected.has(event));
      if (pending.length === previousLength) return false;
      for (const event of events) {
        if (event.type === 'report' && event.reportId) {
          inFlightReportIds.add(event.reportId);
          retryReadyAtById.delete(event.reportId);
        }
      }
      finalize?.();
      notify();
      return true;
    },
    rollbackBatchCommit(batch) {
      if (batch.sourceKey === 'user') return;
      for (const event of batch.events) {
        if (event.type !== 'report') continue;
        if (event.reportId) inFlightReportIds.delete(event.reportId);
        if (batch.batchId && event.frozenBatchId === batch.batchId) {
          delete event.frozenBatchId;
          delete event.frozenPayload;
        }
        if (!pending.includes(event)) pending.push(event);
      }
      pending.sort(compareDispatchEvents);
      delete batch.batchId;
      delete batch.payload;
      notify();
    },
    takeBatch(state, now = clock.now()) {
      const batch = this.selectBatch(state, now);
      if (!batch) return undefined;
      this.commitBatch(batch);
      return batch;
    },
    nextReadyAt(now = clock.now()) {
      let nextUserReadyAt: number | undefined;
      const nextCandidateTimes: number[] = [];
      clearExpiredFocus(now);
      if (focusSessionId && focusLastInputAt !== undefined) {
        nextCandidateTimes.push(
          focusLastInputAt + scheduling.focusInactivityTimeoutMs,
        );
      }
      const bySource = new Map<
        string,
        Extract<OperatorDispatchEvent, { type: 'report' }>[]
      >();
      for (const event of pending) {
        if (event.type === 'user') {
          nextUserReadyAt =
            nextUserReadyAt === undefined
              ? event.readyAt
              : Math.min(nextUserReadyAt, event.readyAt);
          continue;
        }
        const sourceKey = operatorEventSourceKey(event);
        const reports = bySource.get(sourceKey) ?? [];
        reports.push(event);
        bySource.set(sourceKey, reports);
      }
      for (const reports of bySource.values()) {
        orderReports(reports);
        const first = reports[0]!;
        const frozenBatchId = first.frozenBatchId;
        const batch = frozenBatchId
          ? reports.filter((event) => event.frozenBatchId === frozenBatchId)
          : reports.filter((event) => !event.frozenBatchId);
        if (batch.length === 0) continue;
        if (scheduling.pushThreshold !== undefined && scheduling.reportWeights && !frozenBatchId) {
          if (focusSessionId && !requestedReports.has(first.conductorAgentId)) continue;
          if (requestedReports.has(first.conductorAgentId)) {
            nextCandidateTimes.push(now);
            continue;
          }
          let weight = 0;
          let reachedAt: number | undefined;
          for (const event of batch) {
            weight += scheduling.reportWeights?.[event.reportType] ?? 0;
            if (weight >= scheduling.pushThreshold) {
              reachedAt = event.firstQueuedAt ?? now;
              break;
            }
          }
          if (reachedAt !== undefined) {
            nextCandidateTimes.push(Math.min(
              Math.max(...batch.map((event) => event.readyAt)),
              reachedAt + scheduling.batchMaxWaitMs,
            ));
          }
          continue;
        }
        if (scheduling.pushThreshold !== undefined && scheduling.reportWeights && focusSessionId &&
            !requestedReports.has(first.conductorAgentId)) continue;
        const readyAt = frozenBatchId
          ? Math.max(
              ...batch.map((event) =>
                Math.max(
                  event.retryReadyAt ?? 0,
                  retryReadyAtById.get(event.reportId ?? '') ?? 0,
                ),
              ),
            )
          : Math.min(
              ...batch.map((event) => event.batchReadyAt ?? Infinity),
              Math.max(...batch.map((event) => event.readyAt)),
              Math.min(
                ...batch.map(
                  (event) =>
                    (event.firstQueuedAt ?? event.readyAt) +
                    scheduling.batchMaxWaitMs,
                ),
              ),
            );
        nextCandidateTimes.push(readyAt);
        const idleOnly = batch.every((event) => event.priority === 'idle');
        if (idleOnly) {
          const eligibleAt = Math.min(
            ...batch.map(
              (event) =>
                event.eligibleAt ?? event.firstQueuedAt ?? event.readyAt,
            ),
          );
          nextCandidateTimes.push(eligibleAt + scheduling.idleAgingMs);
        }
      }
      const deadlines = [
        ...(nextUserReadyAt === undefined ? [] : [nextUserReadyAt]),
        ...nextCandidateTimes.filter((deadline) => deadline > now),
      ];
      return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
    },
    waitForChange(timeoutMs) {
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const finish = () => {
          listeners.delete(finish);
          if (timer) clock.clearTimeout(timer);
          resolve();
        };
        listeners.add(finish);
        if (timeoutMs !== undefined) {
          timer = clock.setTimeout(finish, Math.max(0, timeoutMs));
          timer.unref();
        }
      });
    },
    wake: notify,
    get heldEventCount() {
      return held.length;
    },
    get pendingEventCount() {
      return pending.length;
    },
    get pendingUserCount() {
      return pending.filter((event) => event.type === 'user').length;
    },
    get conversationHold() {
      return conversationHold;
    },
    get reportHold() {
      return reportHold;
    },
    get hold() {
      return isHeld();
    },
    get focusSessionId() {
      clearExpiredFocus(clock.now());
      return focusSessionId;
    },
    get batchMaxWaitMs() {
      return scheduling.batchMaxWaitMs;
    },
  };
}
