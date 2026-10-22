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
  enqueueUser(text: string): void;
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
  requeue(event: OperatorDispatchEvent, delayMs: number): void;
  setConversationHold(hold: boolean): {
    heldEventCount: number;
    releasedEventCount: number;
  };
  setHold(hold: boolean): { heldEventCount: number; releasedEventCount: number };
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
  if (event.reportType === 'open_question') {
    return `open_question:${event.conductorAgentId}`;
  }
  if (event.reportType === 'conductor_message') {
    return `conductor_message:${event.conductorAgentId}`;
  }
  return `session:${event.conductorAgentId}`;
}

export function selectOperatorDispatchBatch(
  queue: readonly OperatorDispatchEvent[],
  state: OperatorDispatchState,
  now = Date.now(),
): { batch: OperatorDispatchBatch; remaining: OperatorDispatchEvent[] } | undefined {
  const ready = queue.filter((event) => event.readyAt <= now);
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

  const events = ready.filter(
    (event) => operatorEventSourceKey(event) === sourceKey,
  );
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
    events.every(
      (event) => event.type === 'report' && event.reportType === 'conductor_message',
    )
  ) {
    const reports = events.filter(
      (event): event is Extract<OperatorDispatchEvent, { type: 'report' }> =>
        event.type === 'report' && event.reportType === 'conductor_message',
    );
    const oversizedWarnings = reports.filter(
      (event) => (event.oversizedSendCounts?.length ?? 0) > 0,
    );
    const oversizedSendCounts = [
      ...new Set(
        oversizedWarnings.flatMap((event) => event.oversizedSendCounts ?? []),
      ),
    ].sort((left, right) => left - right);
    const messages = reports.filter(
      (event) => (event.oversizedSendCounts?.length ?? 0) === 0,
    );
    if (oversizedSendCounts.length > 0) {
      const warning = oversizedWarnings[0]!;
      messages.push({
        ...warning,
        text: formatOversizedConductorMessageWarning(
          warning.issueUrl,
          warning.conductorAgentId,
          oversizedSendCounts,
        ),
        sendCount: oversizedSendCounts.at(-1)!,
        oversizedSendCounts,
      });
    }
    messages.sort(
      (left, right) =>
        (left.type === 'report' ? left.sendCount ?? 0 : 0) -
        (right.type === 'report' ? right.sendCount ?? 0 : 0),
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
  if (events.length === 1) {
    const event = events[0]!;
    return [
      event.type === 'report' && event.reportType === 'open_question'
        ? '## Open Question 追加'
        : '## セッション報告',
      '',
      event.text,
    ].join('\n');
  }

  const title =
    events[0]!.type === 'user'
      ? `## user 発話（${events.length} 件）`
      : events[0]!.type === 'report' &&
          events[0]!.reportType === 'open_question'
        ? `## Open Question 追加（${events.length} 件）`
        : `## セッション報告（${events.length} 件）`;
  return [
    title,
    '',
    ...events.map((event, index) =>
      [`### ${index + 1}/${events.length}`, '', event.text].join('\n'),
    ),
  ].join('\n\n');
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
    enqueueUser(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      pending.push({
        type: 'user',
        text: trimmed,
        arrival: arrival++,
        readyAt: 0,
      });
      notify();
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
    takeBatch(state, now = Date.now()) {
      const selected = selectOperatorDispatchBatch(pending, state, now);
      if (!selected) return undefined;
      pending = selected.remaining;
      return selected.batch;
    },
    nextReadyAt() {
      return pending.reduce<number | undefined>(
        (minimum, event) =>
          minimum === undefined ? event.readyAt : Math.min(minimum, event.readyAt),
        undefined,
      );
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
