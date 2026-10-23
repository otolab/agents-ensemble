import { describe, expect, it, vi } from 'vitest';
import {
  createOperatorDispatchQueue,
  formatOperatorDispatchBatch,
  selectOperatorDispatchBatch,
  type OperatorDispatchEvent,
} from './operator-dispatch.js';

function report(
  conductorAgentId: string,
  reportType: 'session_state' | 'open_question' | 'conductor_message' =
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
    expect(first?.batch.sourceKey).toBe('open_question:one');

    const user: OperatorDispatchEvent = {
      type: 'user',
      text: 'please summarize',
      arrival: 4,
      readyAt: 0,
    };
    const userFirst = selectOperatorDispatchBatch(
      [...queue, user],
      { lastDispatchedSourceKey: 'session:one', continuationConsumed: false },
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

  it('labels Open Question additions and keeps simultaneous sessions distinct', () => {
    const one = report('session-1', 'open_question', 'Issue 1 / inq-1');
    const two = report('session-2', 'open_question', 'Issue 2 / inq-1', 1);
    const first = selectOperatorDispatchBatch(
      [one, two],
      { continuationConsumed: false },
      0,
    );
    expect(first?.batch.sourceKey).toBe('open_question:session-1');
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
    expect(second?.batch.sourceKey).toBe('open_question:session-2');
    expect(formatOperatorDispatchBatch(second!.batch.events)).toContain(
      'Issue 2 / inq-1',
    );
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
          'send 11\n#### inbound\ncontext 11\n#### response\nreply 11',
          '',
          '### 2/2',
          '',
          'send 12\n#### inbound\ncontext 12\n#### response\nreply 12',
        ].join('\n'),
      );
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
});
