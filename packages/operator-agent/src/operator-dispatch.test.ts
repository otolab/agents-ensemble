import { describe, expect, it, vi } from 'vitest';
import {
  createOperatorDispatchQueue,
  DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
  formatOperatorDispatchBatch,
  selectOperatorDispatchBatch,
  type OperatorDispatchEvent,
} from './operator-dispatch.js';
import { CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT } from '@agents-ensemble/core/operator-runtime';

function report(
  conductorAgentId: string,
  reportType:
    | 'session_state'
    | 'open_question'
    | 'conductor_message'
    | 'idle_candidate' =
    'session_state',
  text = conductorAgentId,
  arrival = 0,
  sendCount?: number,
): OperatorDispatchEvent {
  return {
    type: 'report',
    reportType,
    conductorAgentId,
    issueUrl: `https://github.com/example/repo/issues/${conductorAgentId}`,
    text,
    ...(sendCount !== undefined ? { sendCount } : {}),
    arrival,
    readyAt: 0,
  };
}

describe('operator dispatch batching', () => {
  it('selects user input first, then open questions, then one-shot session continuation', () => {
    const queue = [
      report('one', 'session_state'),
      report('two', 'session_state'),
      report('one', 'open_question'),
    ];
    const first = selectOperatorDispatchBatch(
      queue,
      { lastDispatchedSourceKey: 'session:one', continuationConsumed: false },
      0,
    );
    expect(first?.batch.sourceKey).toBe('session:one');

    const user: OperatorDispatchEvent = {
      type: 'user',
      text: 'please summarize',
      arrival: 4,
      readyAt: 0,
    };
    const userFirst = selectOperatorDispatchBatch(
      [...queue, user],
      {
        lastDispatchedSourceKey: 'session:one',
        continuationConsumed: false,
        focusSessionId: 'two',
      },
      0,
    );
    expect(userFirst?.batch.events).toEqual([user]);

    const continued = selectOperatorDispatchBatch(
      [report('two', 'session_state'), report('one', 'session_state', 'follow-up', 1)],
      { lastDispatchedSourceKey: 'session:one', continuationConsumed: false },
      0,
    );
    expect(continued?.batch.sourceKey).toBe('session:one');
    expect(continued?.batch.usedContinuation).toBe(true);
    expect(continued?.batch.events.map((event) => event.text)).toEqual(['follow-up']);

    const afterContinuation = selectOperatorDispatchBatch(
      [report('two', 'session_state', 'earlier', 0), report('one', 'session_state')],
      { lastDispatchedSourceKey: 'session:one', continuationConsumed: true },
      0,
    );
    expect(afterContinuation?.batch.sourceKey).toBe('session:two');
  });

  it('consumes session continuation for one selection only', () => {
    const first = selectOperatorDispatchBatch(
      [report('one'), report('two')],
      { continuationConsumed: false },
      0,
    );
    expect(first?.batch.sourceKey).toBe('session:one');
    expect(first?.batch.usedContinuation).toBe(false);

    const stateAfterFirst = {
      lastDispatchedSourceKey: first!.batch.sourceKey,
      continuationConsumed: first!.batch.usedContinuation,
    };
    const continued = selectOperatorDispatchBatch(
      [report('two'), report('one', 'session_state', 'follow-up', 3)],
      stateAfterFirst,
      0,
    );
    expect(continued?.batch.sourceKey).toBe('session:one');
    expect(continued?.batch.usedContinuation).toBe(true);

    const stateAfterContinuation = {
      lastDispatchedSourceKey: continued!.batch.sourceKey,
      continuationConsumed: continued!.batch.usedContinuation,
    };
    const next = selectOperatorDispatchBatch(
      [report('two'), report('one', 'session_state', 'later', 4)],
      stateAfterContinuation,
      0,
    );
    expect(next?.batch.sourceKey).toBe('session:two');
    expect(next?.batch.usedContinuation).toBe(false);
  });

  it('batches same-source reports in arrival order and formats numbered sections', () => {
    const queue = [
      report('session-1', 'session_state', 'first', 0),
      report('session-2', 'session_state', 'other source', 1),
      report('session-1', 'session_state', 'second', 2),
    ];
    const selected = selectOperatorDispatchBatch(
      queue,
      { continuationConsumed: false },
      0,
    );
    expect(selected?.batch.events.map((event) => event.text)).toEqual([
      'first',
      'second',
    ]);
    expect(selected?.remaining).toEqual([queue[1]]);
    expect(formatOperatorDispatchBatch(selected!.batch.events)).toContain(
      '### 2/2\n\nsecond',
    );
  });

  it('splits user batches by UTF-8 byte budget without mixing watch reports', () => {
    const firstUser: OperatorDispatchEvent = {
      type: 'user',
      text: '1234',
      arrival: 0,
      readyAt: 0,
    };
    const watchedReport = report('session-1', 'open_question', 'watch report', 1);
    const secondUser: OperatorDispatchEvent = {
      type: 'user',
      text: '56',
      arrival: 2,
      readyAt: 0,
    };

    const first = selectOperatorDispatchBatch(
      [firstUser, watchedReport, secondUser],
      { continuationConsumed: false },
      0,
      5,
    );
    expect(first?.batch.events).toEqual([firstUser]);
    expect(first?.remaining).toEqual([watchedReport, secondUser]);

    const second = selectOperatorDispatchBatch(
      first!.remaining,
      { continuationConsumed: false },
      0,
      5,
    );
    expect(second?.batch.events).toEqual([secondUser]);
    expect(second?.remaining).toEqual([watchedReport]);

    const reportBatch = selectOperatorDispatchBatch(
      second!.remaining,
      { continuationConsumed: false },
      0,
      5,
    );
    expect(reportBatch?.batch.events).toEqual([watchedReport]);
  });

  it('rejects user input above the recovery admission limit before enqueue', () => {
    const queue = createOperatorDispatchQueue();
    const oversized = 'x'.repeat(CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT + 1);

    expect(queue.enqueueUser(oversized)).toBe(false);
    expect(queue.pendingUserCount).toBe(0);
    expect(queue.enqueueUser('within limit')).toBe(true);
    expect(queue.pendingUserCount).toBe(1);
  });

  it('preserves user whitespace while rejecting whitespace-only input', () => {
    const queue = createOperatorDispatchQueue();
    const message = '  first line\n    second line  ';

    expect(queue.enqueueUser(' \n\t ')).toBe(false);
    expect(queue.enqueueUser(message)).toBe(true);

    const batch = queue.selectBatch({ continuationConsumed: false });
    expect(batch?.events).toMatchObject([{ type: 'user', text: message }]);
    expect(formatOperatorDispatchBatch(batch!.events)).toBe(message);
  });

  it('labels Open Question additions and keeps simultaneous sessions distinct', () => {
    const one = report('session-1', 'open_question', 'Issue 1 / inq-1');
    const two = report('session-2', 'open_question', 'Issue 2 / inq-1', 1);
    const first = selectOperatorDispatchBatch(
      [one, two],
      { continuationConsumed: false },
      0,
    );
    expect(first?.batch.sourceKey).toBe('session:session-1');
    expect(formatOperatorDispatchBatch(first!.batch.events)).toContain(
      '## Open Question 追加',
    );
    expect(formatOperatorDispatchBatch(first!.batch.events)).toContain(
      'Issue 1 / inq-1',
    );
    const second = selectOperatorDispatchBatch(
      first!.remaining,
      { continuationConsumed: false },
      0,
    );
    expect(second?.batch.sourceKey).toBe('session:session-2');
    expect(formatOperatorDispatchBatch(second!.batch.events)).toContain(
      'Issue 2 / inq-1',
    );
  });

  it('keeps distinct reports while grouping oversized-message warnings in a mixed batch', () => {
    const queue = createOperatorDispatchQueue();
    queue.enqueueReports(
      [
        {
          type: 'report',
          reportType: 'open_question',
          reportId: 'question-report',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: '解決: inq-1 / operator の回答',
        },
        {
          type: 'report',
          reportType: 'conductor_message',
          reportId: 'oversized-3',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'oversized sendCount 3',
          sendCount: 3,
          oversizedSendCounts: [3],
        },
        {
          type: 'report',
          reportType: 'conductor_message',
          reportId: 'oversized-4',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'oversized sendCount 4',
          sendCount: 4,
          oversizedSendCounts: [4],
        },
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'status-report',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: '状態: 完了',
        },
      ],
      0,
    );

    const batch = queue.takeBatch(
      { continuationConsumed: false },
      Date.now(),
    )!;
    expect(batch.events.map((event) => event.reportId)).toEqual([
      'question-report',
      'oversized-3',
      'oversized-4',
      'status-report',
    ]);
    const formatted = formatOperatorDispatchBatch(batch.events);
    expect(formatted.match(/⚠/g)).toHaveLength(1);
    expect(formatted).toContain('2件の発言');
    expect(formatted).toContain('sendCount: 3, 4');
    expect(formatted).toContain('解決: inq-1');
    expect(formatted).toContain('状態: 完了');
  });

  it('does not move grouped oversized warnings across intervening messages or reports', () => {
    const queue = createOperatorDispatchQueue();
    queue.enqueueReports(
      [
        {
          type: 'report',
          reportType: 'open_question',
          reportId: 'question-report',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: '解決: inq-1 / operator の回答',
        },
        {
          type: 'report',
          reportType: 'conductor_message',
          reportId: 'oversized-3',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: '⚠ oversized sendCount: 3',
          sendCount: 3,
          oversizedSendCounts: [3],
        },
        {
          type: 'report',
          reportType: 'conductor_message',
          reportId: 'message-4',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'readable message 4',
          sendCount: 4,
        },
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'status-report',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: '状態: 完了',
        },
        {
          type: 'report',
          reportType: 'conductor_message',
          reportId: 'oversized-5',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: '⚠ oversized sendCount: 5',
          sendCount: 5,
          oversizedSendCounts: [5],
        },
      ],
      0,
    );

    const batch = queue.takeBatch(
      { continuationConsumed: false },
      Date.now(),
    )!;
    expect(batch.events).toHaveLength(5);
    expect(queue.pendingEventCount).toBe(0);
    const formatted = formatOperatorDispatchBatch(batch.events);
    const warningThree = formatted.indexOf('sendCount: 3');
    const readableFour = formatted.indexOf('readable message 4');
    const warningFive = formatted.indexOf('sendCount: 5');
    expect(warningThree).toBeGreaterThanOrEqual(0);
    expect(readableFour).toBeGreaterThan(warningThree);
    expect(warningFive).toBeGreaterThan(readableFour);
    expect(formatted.match(/⚠/g)).toHaveLength(2);
  });

  it('gives reports from one observation a shared debounce deadline', () => {
    const queue = createOperatorDispatchQueue();
    queue.enqueueReports(
      [
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'first update',
        },
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'second update',
        },
      ],
      10_000,
    );

    const batch = queue.takeBatch(
      { continuationConsumed: false },
      queue.nextReadyAt(),
    );
    expect(batch?.events.map((event) => event.text)).toEqual([
      'first update',
      'second update',
    ]);
  });

  it('extends conductor-message debounce and formats a window by sendCount', () => {
    const queue = createOperatorDispatchQueue();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(9_000);
    queue.enqueueDebouncedReports(
      [
        {
          type: 'report',
          reportType: 'conductor_message',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'send 12\n#### inbound\ncontext 12\n#### response\nreply 12',
          sendCount: 12,
        },
      ],
      10_000,
    );
    queue.enqueueDebouncedReports(
      [
        {
          type: 'report',
          reportType: 'conductor_message',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'send 11\n#### inbound\ncontext 11\n#### response\nreply 11',
          sendCount: 11,
        },
      ],
      10_000,
    );

    try {
      expect(
        queue.takeBatch({ continuationConsumed: false }, 10_999),
      ).toBeUndefined();
      const batch = queue.takeBatch(
        { continuationConsumed: false },
        19_000,
      )!;
      expect(batch.events.map((event) => event.sendCount)).toEqual([12, 11]);
      expect(formatOperatorDispatchBatch(batch.events)).toBe(
        [
          '## Conductor の発言（2 件）',
          '',
          '### 1/2',
          '',
          'send 12\n#### inbound\ncontext 12\n#### response\nreply 12',
          '',
          '### 2/2',
          '',
          'send 11\n#### inbound\ncontext 11\n#### response\nreply 11',
        ].join('\n'),
      );
    } finally {
      now.mockRestore();
    }
  });

  it('holds related watch reports for the message-listen window and extends it on new messages', () => {
    const queue = createOperatorDispatchQueue();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    queue.enqueueReports(
      [
        {
          type: 'report',
          reportType: 'open_question',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'question answered',
        },
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'session-1',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'status updated',
        },
      ],
      10_000,
    );
    expect(queue.deferWatchReports).toBeTypeOf('function');
    queue.deferWatchReports?.('session-1', 10_000);
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        conductorAgentId: 'session-2',
        issueUrl: 'https://github.com/example/repo/issues/2',
        text: 'independent session',
      },
      0,
    );

    try {
      const independent = queue.takeBatch(
        { continuationConsumed: false },
        1_000,
      )!;
      expect(independent.sourceKey).toBe('session:session-2');

      now.mockReturnValue(2_000);
      queue.enqueueDebouncedReports(
        [
          {
            type: 'report',
            reportType: 'conductor_message',
            conductorAgentId: 'session-1',
            issueUrl: 'https://github.com/example/repo/issues/1',
            text: 'first conductor reply',
            sendCount: 1,
          },
        ],
        10_000,
      );
      now.mockReturnValue(9_000);
      queue.enqueueDebouncedReports(
        [
          {
            type: 'report',
            reportType: 'conductor_message',
            conductorAgentId: 'session-1',
            issueUrl: 'https://github.com/example/repo/issues/1',
            text: 'second conductor reply',
            sendCount: 2,
          },
        ],
        10_000,
      );

      expect(
        queue.takeBatch({ continuationConsumed: false }, 18_999),
      ).toBeUndefined();
      const combined = queue.takeBatch(
        { continuationConsumed: false },
        19_000,
      )!;
      expect(combined.sourceKey).toBe('session:session-1');
      expect(combined.events.map((event) =>
        event.type === 'report' ? event.reportType : event.type,
      )).toEqual([
        'open_question',
        'session_state',
        'conductor_message',
        'conductor_message',
      ]);
      expect(combined.events.map((event) => event.text)).toContain(
        'question answered',
      );
      expect(combined.events.map((event) => event.text)).toContain(
        'status updated',
      );
    } finally {
      now.mockRestore();
    }
  });

  it('schedules wake-up at the latest deadline for a blocked session batch', () => {
    const queue = createOperatorDispatchQueue();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'open_question',
        conductorAgentId: 'session-1',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'early report',
      },
      0,
    );
    now.mockReturnValue(2_000);
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'conductor_message',
        conductorAgentId: 'session-1',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'later report',
      },
      5_000,
    );
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        conductorAgentId: 'session-2',
        issueUrl: 'https://github.com/example/repo/issues/2',
        text: 'independent report',
      },
      0,
    );

    try {
      expect(queue.nextReadyAt()).toBe(7_000);
      expect(
        queue.takeBatch({ continuationConsumed: false }, 2_000)?.sourceKey,
      ).toBe('session:session-2');
      expect(queue.nextReadyAt()).toBe(7_000);
      expect(
        queue.takeBatch({ continuationConsumed: false }, 6_999),
      ).toBeUndefined();
      expect(
        queue.takeBatch({ continuationConsumed: false }, 7_000)?.events.map(
          (event) => event.text,
        ),
      ).toEqual(['early report', 'later report']);
    } finally {
      now.mockRestore();
    }
  });

  it('requeues an unconfirmed report with its stable report id', () => {
    const queue = createOperatorDispatchQueue();
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'open_question',
        reportId: 'report-1',
        conductorAgentId: 'session-1',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'Review the release?',
      },
      0,
    );

    const firstAttempt = queue.takeBatch(
      { continuationConsumed: false },
      Date.now(),
    )!;
    expect(firstAttempt.events[0]).toMatchObject({ reportId: 'report-1' });
    queue.requeue(firstAttempt.events[0]!, 5_000);

    expect(queue.pendingEventCount).toBe(1);
    expect(
      queue.takeBatch({ continuationConsumed: false }, Date.now()),
    ).toBeUndefined();
    const retry = queue.takeBatch(
      { continuationConsumed: false },
      queue.nextReadyAt()!,
    );
    expect(retry?.events[0]).toMatchObject({
      type: 'report',
      reportId: 'report-1',
      text: 'Review the release?',
    });
  });

  it('holds automatic reports, lets user speech through, and releases held reports together', () => {
    const queue = createOperatorDispatchQueue();
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'open_question',
        conductorAgentId: 'one',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'already queued report',
      },
      0,
    );
    queue.setHold(true);
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'open_question',
        conductorAgentId: 'one',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'held report',
      },
      0,
    );
    queue.enqueueUser('urgent user input');

    expect(queue.heldEventCount).toBe(2);
    expect(
      queue.takeBatch({ continuationConsumed: false }, Date.now())?.events[0],
    ).toMatchObject({ type: 'user', text: 'urgent user input' });

    expect(queue.setHold(false)).toEqual({
      heldEventCount: 0,
      releasedEventCount: 2,
    });
    expect(
      queue
        .takeBatch({ continuationConsumed: false }, Date.now())
        ?.events.map((event) => event.text),
    ).toEqual(['already queued report', 'held report']);
  });

  it('composes conversation and manual holds with OR semantics', () => {
    const queue = createOperatorDispatchQueue();
    queue.setConversationHold(true);
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        conductorAgentId: 'one',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'first report',
      },
      0,
    );
    queue.setHold(true);
    expect(queue).toMatchObject({
      conversationHold: true,
      reportHold: true,
      hold: true,
      heldEventCount: 1,
    });

    const releasedConversation = queue.setConversationHold(false);
    expect(releasedConversation).toEqual({
      heldEventCount: 1,
      releasedEventCount: 0,
    });
    expect(queue.hold).toBe(true);
    expect(queue.pendingEventCount).toBe(0);

    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        conductorAgentId: 'one',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'second report',
      },
      0,
    );
    const releasedManual = queue.setHold(false);
    expect(releasedManual).toEqual({
      heldEventCount: 0,
      releasedEventCount: 2,
    });
    expect(queue.hold).toBe(false);
    expect(
      queue.takeBatch({ continuationConsumed: false }, Date.now())?.events.map(
        (event) => event.text,
      ),
    ).toEqual(['first report', 'second report']);
  });

  it('batches related report types from one session after both holds release', () => {
    const queue = createOperatorDispatchQueue();
    queue.setConversationHold(true);
    queue.setHold(true);
    queue.enqueueReports(
      [
        {
          type: 'report',
          reportType: 'open_question',
          reportId: 'question-report',
          conductorAgentId: 'session-one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: '解決: inq-1 / operator の回答',
        },
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'status-report',
          conductorAgentId: 'session-one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: '状態 (2026-11-16T00:00:00.000Z): CI 待ち',
        },
      ],
      0,
    );
    queue.enqueueDebouncedReports(
      [
        {
          type: 'report',
          reportType: 'conductor_message',
          reportId: 'message-report',
          conductorAgentId: 'session-one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'sendCount: 12\n#### inbound\n回答確認\n#### response\n対応します',
          sendCount: 12,
        },
      ],
      0,
    );
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        reportId: 'other-session-report',
        conductorAgentId: 'session-two',
        issueUrl: 'https://github.com/example/repo/issues/2',
        text: '状態 (2026-11-16T00:00:01.000Z): 別 Issue',
      },
      0,
    );

    expect(queue.setHold(false)).toEqual({
      heldEventCount: 4,
      releasedEventCount: 0,
    });
    expect(queue.conversationHold).toBe(true);
    expect(queue.pendingEventCount).toBe(0);
    expect(queue.setConversationHold(false)).toEqual({
      heldEventCount: 0,
      releasedEventCount: 4,
    });

    const first = queue.takeBatch(
      { continuationConsumed: false },
      Date.now(),
    )!;
    expect(first.sourceKey).toBe('session:session-one');
    expect(first.events.map((event) => event.reportId)).toEqual([
      'question-report',
      'status-report',
      'message-report',
    ]);
    const formatted = formatOperatorDispatchBatch(first.events);
    expect(formatted).toContain('解決: inq-1');
    expect(formatted).toContain('状態 (2026-11-16T00:00:00.000Z)');
    expect(formatted).toContain('sendCount: 12');
    expect(formatted.indexOf('解決: inq-1')).toBeLessThan(
      formatted.indexOf('sendCount: 12'),
    );

    for (const event of first.events) queue.requeue(event, 5_000);
    const retry = queue.takeBatch(
      { lastDispatchedSourceKey: first.sourceKey, continuationConsumed: false },
      Math.max(...first.events.map(() => Date.now() + 5_000)),
    )!;
    expect(retry.events.map((event) => event.reportId)).toEqual([
      'question-report',
      'status-report',
      'message-report',
    ]);

    const second = queue.takeBatch(
      { lastDispatchedSourceKey: retry.sourceKey, continuationConsumed: true },
      Date.now() + 5_000,
    )!;
    expect(second.events.map((event) => event.reportId)).toEqual([
      'other-session-report',
    ]);
  });

  it('keeps reports held when conversation hold starts during manual hold', () => {
    const queue = createOperatorDispatchQueue();
    queue.setHold(true);
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        conductorAgentId: 'one',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'held report',
      },
      0,
    );

    queue.setConversationHold(true);
    const manualRelease = queue.setHold(false);
    expect(manualRelease).toEqual({
      heldEventCount: 1,
      releasedEventCount: 0,
    });
    expect(queue).toMatchObject({
      conversationHold: true,
      reportHold: false,
      hold: true,
      heldEventCount: 1,
    });
    expect(queue.pendingEventCount).toBe(0);

    expect(queue.setConversationHold(false)).toEqual({
      heldEventCount: 0,
      releasedEventCount: 1,
    });
    expect(queue.pendingEventCount).toBe(1);
  });

  it('does not dispatch reports before their configured debounce deadline', () => {
    const queue = createOperatorDispatchQueue();
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        conductorAgentId: 'one',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'report',
      },
      5_000,
    );
    expect(queue.takeBatch({ continuationConsumed: false }, Date.now())).toBeUndefined();
    expect(queue.nextReadyAt()).toBeGreaterThan(Date.now());
  });

  it('uses the earlier quiet deadline or first-report batch cap', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const queue = createOperatorDispatchQueue({
      ...DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
      batchMaxWaitMs: 30_000,
    });
    try {
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'first',
          conductorAgentId: 'one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'first',
        },
        120_000,
      );
      now.mockReturnValue(20_000);
      queue.enqueueDebouncedReports(
        [
          {
            type: 'report',
            reportType: 'session_state',
            reportId: 'second',
            conductorAgentId: 'one',
            issueUrl: 'https://github.com/example/repo/issues/1',
            text: 'second',
          },
        ],
        120_000,
      );

      expect(queue.nextReadyAt()).toBe(31_000);
      expect(
        queue.selectBatch({ continuationConsumed: false }, 30_999),
      ).toBeUndefined();
      expect(
        queue.selectBatch({ continuationConsumed: false }, 31_000)?.events.map(
          (event) => event.reportId,
        ),
      ).toEqual(['first', 'second']);
      expect(
        queue.selectBatch({ continuationConsumed: false }, 31_000)?.events.map(
          (event) =>
            event.type === 'report' ? event.firstQueuedAt : undefined,
        ),
      ).toEqual([1_000, 20_000]);
    } finally {
      now.mockRestore();
    }
  });

  it('appends same-session reports through commit and freezes one payload', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const queue = createOperatorDispatchQueue();
    try {
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'first',
          conductorAgentId: 'one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'first',
        },
        0,
      );
      const batch = queue.selectBatch({ continuationConsumed: false }, 1_000)!;
      now.mockReturnValue(2_000);
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'open_question',
          reportId: 'question',
          conductorAgentId: 'one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'question',
        },
        90_000,
      );
      expect(queue.commitBatch(batch)).toBe(true);
      expect(batch.events.map((event) => event.reportId)).toEqual([
        'first',
        'question',
      ]);
      expect(batch.priority).toBe('open_question');
      expect(batch.payload).toContain('first');
      expect(batch.payload).toContain('question');
      expect(queue.pendingEventCount).toBe(0);

      for (const event of batch.events) queue.requeue(event, 5_000);
      expect(
        queue.selectBatch({ continuationConsumed: false }, 6_999),
      ).toBeUndefined();
      const retry = queue.selectBatch(
        { continuationConsumed: false },
        7_000,
      )!;
      expect(retry.events.map((event) => event.reportId)).toEqual([
        'first',
        'question',
      ]);
      expect(retry.batchId).toBe(batch.batchId);
      expect(retry.payload).toBe(batch.payload);
    } finally {
      now.mockRestore();
    }
  });

  it('restores a captured batch after durable commit failure without losing arrival order', () => {
    const queue = createOperatorDispatchQueue();
    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'session_state',
        reportId: 'first',
        conductorAgentId: 'one',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'first',
      },
      0,
    );
    const batch = queue.selectBatch({ continuationConsumed: false })!;
    expect(queue.commitBatch(batch)).toBe(true);

    queue.enqueueReport(
      {
        type: 'report',
        reportType: 'open_question',
        reportId: 'arrived-during-persist',
        conductorAgentId: 'one',
        issueUrl: 'https://github.com/example/repo/issues/1',
        text: 'later arrival',
      },
      0,
    );
    queue.rollbackBatchCommit(batch);

    expect(batch.batchId).toBeUndefined();
    expect(batch.payload).toBeUndefined();
    expect(queue.pendingEventCount).toBe(2);
    const retry = queue.selectBatch({ continuationConsumed: false })!;
    expect(retry.events.map((event) =>
      event.type === 'report' ? event.reportId : undefined,
    )).toEqual(['first', 'arrived-during-persist']);
    expect(retry.events.every(
      (event) => event.type !== 'report' || event.frozenBatchId === undefined,
    )).toBe(true);
  });

  it('keeps a frozen batch ahead of later reports on retry and after ack', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const queue = createOperatorDispatchQueue();
    try {
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          reportId: 'frozen',
          conductorAgentId: 'one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'frozen payload member',
        },
        0,
      );
      const initial = queue.selectBatch({ continuationConsumed: false }, 1_000)!;
      queue.commitBatch(initial);
      const frozenPayload = initial.payload;
      now.mockReturnValue(2_000);
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'open_question',
          reportId: 'later',
          conductorAgentId: 'one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'later batch',
        },
        0,
      );
      queue.requeue(initial.events[0]!, 5_000);
      expect(
        queue.selectBatch({ continuationConsumed: false }, 6_999),
      ).toBeUndefined();
      const retry = queue.selectBatch(
        { continuationConsumed: false },
        7_000,
      )!;
      expect(retry.events.map((event) => event.reportId)).toEqual(['frozen']);
      expect(retry.payload).toBe(frozenPayload);
      queue.commitBatch(retry);
      queue.discardQueuedReports?.(['frozen']);
      expect(
        queue.selectBatch({ continuationConsumed: false }, 7_000)?.events.map(
          (event) => event.reportId,
        ),
      ).toEqual(['later']);
    } finally {
      now.mockRestore();
    }
  });

  it('replays a frozen batch without waiting for member quiet deadlines', () => {
    const event = {
      type: 'report' as const,
      reportType: 'session_state' as const,
      reportId: 'frozen',
      conductorAgentId: 'one',
      issueUrl: 'https://github.com/example/repo/issues/1',
      text: 'frozen payload',
      arrivalOrder: 1,
      firstQueuedAt: 1_000,
      frozenBatchId: 'batch-1',
      frozenPayload: 'frozen payload',
      arrival: 0,
      readyAt: 120_000,
    };

    const selected = selectOperatorDispatchBatch(
      [event],
      { continuationConsumed: false },
      2_000,
    );

    expect(selected?.batch).toMatchObject({
      batchId: 'batch-1',
      payload: 'frozen payload',
      events: [event],
    });
  });

  it('uses highest member priority without changing same-session order', () => {
    const queue = createOperatorDispatchQueue();
    queue.enqueueReports(
      [
        {
          type: 'report',
          reportType: 'idle_candidate',
          reportId: 'idle',
          conductorAgentId: 'one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'idle evidence',
          priority: 'idle',
          eligibleAt: Date.now(),
        },
        {
          type: 'report',
          reportType: 'open_question',
          reportId: 'question',
          conductorAgentId: 'one',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'OQ',
          priority: 'open_question',
        },
      ],
      0,
    );
    const batch = queue.takeBatch({ continuationConsumed: false })!;
    expect(batch.priority).toBe('open_question');
    expect(batch.events.map((event) => event.reportId)).toEqual([
      'idle',
      'question',
    ]);
    expect(batch.payload).toContain('稼働 session の確認候補');
  });

  it('prefers every focused-session batch over outside OQ and expires only on human inactivity', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const queue = createOperatorDispatchQueue({
      ...DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
      focusInactivityTimeoutMs: 10_000,
    });
    try {
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'focus',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'focused report',
        },
        0,
      );
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'open_question',
          conductorAgentId: 'outside',
          issueUrl: 'https://github.com/example/repo/issues/2',
          text: 'outside OQ',
        },
        0,
      );
      queue.setFocus('focus', 1_000);
      queue.noteOperatorInput(5_000);
      now.mockReturnValue(8_000);
      // A tool invocation may set the same focus, but it is not a human input
      // event and therefore must not move the sliding deadline.
      queue.setFocus('focus', 8_000);
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'automated',
          issueUrl: 'https://github.com/example/repo/issues/3',
          text: 'automatic watch update',
        },
        0,
      );
      expect(
        queue.selectBatch({ continuationConsumed: false }, 14_999)?.sourceKey,
      ).toBe('session:focus');
      expect(queue.focusSessionId).toBe('focus');
      expect(
        queue.selectBatch({ continuationConsumed: false }, 15_000)?.sourceKey,
      ).toBe('session:outside');
      expect(queue.focusSessionId).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('starts a TTY-selected focus from the preceding human input timestamp', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const queue = createOperatorDispatchQueue({
      ...DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
      focusInactivityTimeoutMs: 10_000,
    });
    try {
      queue.noteOperatorInput();
      now.mockReturnValue(1_500);
      queue.setFocus('focus');
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'session_state',
          conductorAgentId: 'focus',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'focused',
        },
        0,
      );
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'open_question',
          conductorAgentId: 'outside',
          issueUrl: 'https://github.com/example/repo/issues/2',
          text: 'outside OQ',
        },
        0,
      );

      expect(
        queue.selectBatch({ continuationConsumed: false }, 10_999)?.sourceKey,
      ).toBe('session:focus');
      expect(
        queue.selectBatch({ continuationConsumed: false }, 11_000)?.sourceKey,
      ).toBe('session:outside');
      expect(queue.focusSessionId).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('does not let caller-supplied stale eligibility predate queue admission', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);
    const queue = createOperatorDispatchQueue({
      ...DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
      idleAgingMs: 5_000,
    });
    try {
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'idle_candidate',
          conductorAgentId: 'idle',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'idle candidate',
          priority: 'idle',
          eligibleAt: 1_000,
        },
        0,
      );

      const batch = queue.selectBatch({ continuationConsumed: false }, 50_000)!;
      expect(batch.events[0]).toMatchObject({
        type: 'report',
        eligibleAt: 50_000,
      });
      expect(queue.selectBatch({ continuationConsumed: false }, 54_999)?.priority)
        .toBe('idle');
      expect(queue.selectBatch({ continuationConsumed: false }, 55_000)?.priority)
        .toBe('normal');
    } finally {
      now.mockRestore();
    }
  });

  it('promotes only idle-only batches after aging and carries the age across holds', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const queue = createOperatorDispatchQueue({
      ...DEFAULT_OPERATOR_DISPATCH_SCHEDULING,
      idleAgingMs: 5_000,
    });
    try {
      queue.setHold(true);
      queue.enqueueReport(
        {
          type: 'report',
          reportType: 'idle_candidate',
          reportId: 'idle',
          conductorAgentId: 'idle-session',
          issueUrl: 'https://github.com/example/repo/issues/1',
          text: 'idle only',
          priority: 'idle',
          eligibleAt: 1_000,
        },
        0,
      );
      now.mockReturnValue(7_000);
      queue.setConversationHold(true);
      queue.setHold(false);
      expect(
        queue.selectBatch({ continuationConsumed: false }, 7_000),
      ).toBeUndefined();
      queue.setConversationHold(false);
      expect(queue.nextReadyAt()).toBeUndefined();
      const batch = queue.selectBatch(
        { continuationConsumed: false },
        7_000,
      )!;
      expect(batch.events.map((event) => event.reportId)).toEqual(['idle']);
      expect(batch.priority).toBe('normal');
      expect(batch.events[0]).toMatchObject({ eligibleAt: 1_000, priority: 'idle' });
    } finally {
      now.mockRestore();
    }
  });
});
