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
}

export interface OperatorDispatchScheduling {
  batchMaxWaitMs: number;
  idleAgingMs: number;
  focusInactivityTimeoutMs: number;
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
  selectBatch(
    state: OperatorDispatchState,
    now?: number,
  ): OperatorDispatchBatch | undefined;
  isBatchCurrent(batch: OperatorDispatchBatch, state: OperatorDispatchState): boolean;
  commitBatch(batch: OperatorDispatchBatch, finalize?: () => void): boolean;
  rollbackBatchCommit(batch: OperatorDispatchBatch): void;
  takeBatch(state: OperatorDispatchState, now?: number): OperatorDispatchBatch | undefined;
  nextReadyAt(): number | undefined;
  waitForChange(timeoutMs?: number): Promise<void>;
  wake(): void;
  readonly heldEventCount: number;
  readonly pendingEventCount: number;
  readonly pendingUserCount: number;
  readonly conversationHold: boolean;
  readonly reportHold: boolean;
  readonly hold: boolean;
  readonly focusSessionId: string | undefined;
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
    if (!frozenBatchId && readyAt <= now) readyHeads?.add(first);

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
    }
    if (!selectedCandidate) {
      const normalFifo = candidates
        .filter((candidate) => candidate.priority === 'normal' || candidate.aged)
        .sort((left, right) => left.order - right.order);
      selectedCandidate =
        normalFifo[0] ??
        candidates.sort((left, right) => left.order - right.order)[0];
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

export function createOperatorDispatchQueue(
  scheduling: OperatorDispatchScheduling = DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
): OperatorDispatchQueue {
  let arrival = 0;
  let held: Extract<OperatorDispatchEvent, { type: 'report' }>[] = [];
  let pending: OperatorDispatchEvent[] = [];
  const readyHeads = new WeakSet<OperatorDispatchEvent>();
  const inFlightReportIds = new Set<string>();
  const retryReadyAtById = new Map<string, number>();
  let conversationHold = false;
  let reportHold = false;
  let focusSessionId: string | undefined;
  let focusLastInputAt: number | undefined;
  let lastOperatorInputAt: number | undefined;
  let firstFocusActivationAt: number | undefined;
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
      focusSessionId = undefined;
      focusLastInputAt = undefined;
      notify();
    }
  };
  const orderReports = (
    reports: Extract<OperatorDispatchEvent, { type: 'report' }>[],
  ) => reports.sort(compareDispatchEvents);
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
      const now = Date.now();
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
      const now = Date.now();
      const readyAt = now + Math.max(0, debounceMs);
      const sourceKeys = new Set(events.map(reportSourceKey));
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
      for (const reportId of retryReadyAtById.keys()) {
        if (!desired.has(reportId) && !inFlightReportIds.has(reportId)) {
          retryReadyAtById.delete(reportId);
        }
      }
      if (changed) notify();
    },
    deferWatchReports(conductorAgentId, debounceMs) {
      const readyAt = Date.now() + Math.max(0, debounceMs);
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
      for (const reportId of ids) {
        if (inFlightReportIds.delete(reportId)) changed = true;
        if (retryReadyAtById.delete(reportId)) changed = true;
      }
      if (changed) notify();
    },
    requeue(event, delayMs) {
      if (event.type === 'user') {
        pending.push({ ...event, arrival: arrival++, readyAt: Date.now() });
      } else {
        const readyAt = Date.now() + Math.max(0, delayMs);
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
    setFocus(conductorAgentId, now = Date.now()) {
      const previous = focusSessionId;
      const normalized = conductorAgentId?.trim();
      focusSessionId = normalized || undefined;
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
    noteOperatorInput(now = Date.now()) {
      lastOperatorInputAt = now;
      if (!focusSessionId) return;
      focusLastInputAt = now;
      notify();
    },
    selectBatch(state, now = Date.now()) {
      clearExpiredFocus(now);
      const selected = selectOperatorDispatchBatch(
        pending,
        { ...state, focusSessionId },
        now,
        CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
        scheduling,
        undefined,
        readyHeads,
      );
      return selected?.batch;
    },
    isBatchCurrent(batch, state) {
      clearExpiredFocus(Date.now());
      const selected = selectOperatorDispatchBatch(
        pending,
        { ...state, focusSessionId },
        Date.now(),
        CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
        scheduling,
        batch,
        readyHeads,
      )?.batch;
      if (
        !selected ||
        selected.sourceKey !== batch.sourceKey ||
        selected.events[0] !== batch.events[0]
      ) {
        return false;
      }
      batch.usedContinuation = selected.usedContinuation;
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
    takeBatch(state, now = Date.now()) {
      const batch = this.selectBatch(state, now);
      if (!batch) return undefined;
      this.commitBatch(batch);
      return batch;
    },
    nextReadyAt() {
      let nextUserReadyAt: number | undefined;
      const nextCandidateTimes: number[] = [];
      const now = Date.now();
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
          if (timer) clearTimeout(timer);
          resolve();
        };
        listeners.add(finish);
        if (timeoutMs !== undefined) {
          timer = setTimeout(finish, Math.max(0, timeoutMs));
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
      clearExpiredFocus(Date.now());
      return focusSessionId;
    },
  };
}
