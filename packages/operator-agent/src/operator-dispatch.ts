import { CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT } from '@agents-ensemble/core/operator-runtime';

export type OperatorDispatchEvent =
  | {
      type: 'user';
      text: string;
      arrival: number;
      readyAt: number;
    }
  | {
      type: 'report';
      reportType: 'session_state' | 'open_question' | 'conductor_message';
      conductorAgentId: string;
      issueUrl: string;
      text: string;
      reportId?: string;
      sendCount?: number;
      oversizedSendCounts?: number[];
      arrival: number;
      readyAt: number;
    };

export interface OperatorDispatchState {
  lastDispatchedSourceKey?: string;
  continuationConsumed: boolean;
}

export interface OperatorDispatchBatch {
  sourceKey: string;
  events: OperatorDispatchEvent[];
  usedContinuation: boolean;
}

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
  deferWatchReports?(conductorAgentId: string, debounceMs: number): void;
  discardQueuedReports?(reportIds: readonly string[]): void;
  requeue(event: OperatorDispatchEvent, delayMs: number): void;
  setConversationHold(hold: boolean): {
    heldEventCount: number;
    releasedEventCount: number;
  };
  setHold(hold: boolean): { heldEventCount: number; releasedEventCount: number };
  selectBatch(
    state: OperatorDispatchState,
    now?: number,
  ): OperatorDispatchBatch | undefined;
  commitBatch(batch: OperatorDispatchBatch): boolean;
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
): { batch: OperatorDispatchBatch; remaining: OperatorDispatchEvent[] } | undefined {
  const ready = queue.filter((event) => {
    if (event.readyAt > now) return false;
    if (event.type === 'user') return true;
    return queue
      .filter(
        (candidate) =>
          candidate.type === 'report' &&
          operatorEventSourceKey(candidate) === operatorEventSourceKey(event),
      )
      .every((candidate) => candidate.readyAt <= now);
  });
  if (ready.length === 0) return undefined;

  const user = ready.find((event) => event.type === 'user');
  let sourceKey: string;
  let usedContinuation = false;
  if (user) {
    sourceKey = 'user';
  } else {
    const question = ready.find(
      (event) => event.type === 'report' && event.reportType === 'open_question',
    );
    if (question) {
      sourceKey = operatorEventSourceKey(question);
    } else if (
      !state.continuationConsumed &&
      state.lastDispatchedSourceKey?.startsWith('session:') &&
      ready.some(
        (event) =>
          operatorEventSourceKey(event) === state.lastDispatchedSourceKey,
      )
    ) {
      sourceKey = state.lastDispatchedSourceKey;
      usedContinuation = true;
    } else {
      sourceKey = operatorEventSourceKey(ready[0]!);
    }
  }

  let events = ready.filter(
    (event) => operatorEventSourceKey(event) === sourceKey,
  );
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
  return {
    batch: { sourceKey, events, usedContinuation },
    remaining: queue.filter((event) => !selected.has(event)),
  };
}

export function formatOperatorDispatchBatch(
  events: readonly OperatorDispatchEvent[],
): string {
  if (events.length === 0) return '';
  if (events.length === 1 && events[0]!.type === 'user') {
    return events[0]!.text.trim();
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
      const messages = aggregateOversizedConductorMessageWarnings(reports).sort(
        (left, right) =>
          (left.sendCount ?? 0) - (right.sendCount ?? 0),
      );
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

export function createOperatorDispatchQueue(): OperatorDispatchQueue {
  let arrival = 0;
  let held: Extract<OperatorDispatchEvent, { type: 'report' }>[] = [];
  let pending: OperatorDispatchEvent[] = [];
  let conversationHold = false;
  let reportHold = false;
  const isHeld = () => conversationHold || reportHold;
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
      const trimmed = text.trim();
      if (
        !trimmed ||
        Buffer.byteLength(trimmed, 'utf8') > CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT
      ) {
        return false;
      }
      pending.push({
        type: 'user',
        text: trimmed,
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
      const readyAt = Date.now() + Math.max(0, debounceMs);
      for (const event of events) {
        const next = { ...event, arrival: arrival++, readyAt };
        if (isHeld()) held.push(next);
        else pending.push(next);
      }
      notify();
    },
    enqueueDebouncedReports(events, debounceMs) {
      if (events.length === 0) return;
      const readyAt = Date.now() + Math.max(0, debounceMs);
      const sourceKeys = new Set(events.map(reportSourceKey));
      for (const event of pending) {
        if (sourceKeys.has(operatorEventSourceKey(event))) event.readyAt = readyAt;
      }
      for (const event of held) {
        if (sourceKeys.has(operatorEventSourceKey(event))) event.readyAt = readyAt;
      }
      for (const event of events) {
        const next = { ...event, arrival: arrival++, readyAt };
        if (isHeld()) held.push(next);
        else pending.push(next);
      }
      notify();
    },
    deferWatchReports(conductorAgentId, debounceMs) {
      const readyAt = Date.now() + Math.max(0, debounceMs);
      for (const event of [...pending, ...held]) {
        if (
          event.type === 'report' &&
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
      pending = pending.filter(
        (event) =>
          event.type !== 'report' ||
          event.reportId === undefined ||
          !ids.has(event.reportId),
      );
      held = held.filter(
        (event) => event.reportId === undefined || !ids.has(event.reportId),
      );
      if (pending.length !== pendingBefore || held.length !== heldBefore) notify();
    },
    requeue(event, delayMs) {
      if (event.type === 'user') {
        pending.push({ ...event, arrival: arrival++, readyAt: Date.now() });
      } else {
        const next = {
          ...event,
          arrival: arrival++,
          readyAt: Date.now() + Math.max(0, delayMs),
        };
        if (isHeld()) held.push(next);
        else pending.push(next);
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
    selectBatch(state, now = Date.now()) {
      const selected = selectOperatorDispatchBatch(pending, state, now);
      return selected?.batch;
    },
    commitBatch(batch) {
      const selected = new Set(batch.events);
      const previousLength = pending.length;
      pending = pending.filter((event) => !selected.has(event));
      if (pending.length === previousLength) return false;
      notify();
      return true;
    },
    takeBatch(state, now = Date.now()) {
      const batch = this.selectBatch(state, now);
      if (!batch) return undefined;
      this.commitBatch(batch);
      return batch;
    },
    nextReadyAt() {
      const nextBySource = new Map<string, number>();
      let nextUserReadyAt: number | undefined;
      for (const event of pending) {
        if (event.type === 'user') {
          nextUserReadyAt =
            nextUserReadyAt === undefined
              ? event.readyAt
              : Math.min(nextUserReadyAt, event.readyAt);
          continue;
        }
        const sourceKey = operatorEventSourceKey(event);
        nextBySource.set(
          sourceKey,
          Math.max(nextBySource.get(sourceKey) ?? Number.NEGATIVE_INFINITY, event.readyAt),
        );
      }
      const deadlines = [
        ...(nextUserReadyAt === undefined ? [] : [nextUserReadyAt]),
        ...nextBySource.values(),
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
  };
}
