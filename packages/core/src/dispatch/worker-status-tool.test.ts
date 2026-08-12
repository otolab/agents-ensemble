import { describe, expect, it, vi } from 'vitest';
import { ConductorInbox } from '../runtime/conductor-inbox.js';
import { WorkerRuntime } from '../runtime/worker-runtime.js';
import { createWorkerStatusTools } from './worker-status-tool.js';

const TEST_WORKTREE = {
  path: '/tmp/wt',
  branch: 'ensemble/issue-1',
  issue: {
    owner: 'org',
    repo: 'repo',
    number: 1,
    url: 'https://github.com/org/repo/issues/1',
  },
};

function toolText(result: { content: Array<{ text?: string }> }): string {
  return String(result.content[0]?.text ?? '');
}

describe('createWorkerStatusTools', () => {
  it('list_workers returns YAML summary aligned with runtime', async () => {
    const inbox = new ConductorInbox();
    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession: vi.fn().mockResolvedValue({
            stopReason: 'end_turn',
            responseText: 'pong',
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }) as never,
    });

    runtime.start({
      name: 'implementer',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'implementer',
      systemPrompt: 'work',
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
      },
    });

    await runtime.waitForIdle();

    const tools = createWorkerStatusTools({
      runtime,
      workerNames: ['implementer', 'reviewer'],
      getWorkerFailures: () => [],
    });

    const result = await tools.list_workers.execute({});
    const text = toolText(result);

    expect(text).toContain('```yaml');
    expect(text).toContain('# list_workers');
    expect(text).toContain('runningCount: 0');
    expect(text).toContain('attachedCount: 1');
    expect(text).toContain('workerFailureCount: 0');
    expect(text).toContain('state: idle');
    expect(text).toContain('name: implementer');
    expect(result.structuredContent).toMatchObject({
      runningCount: 0,
      attachedCount: 1,
      workerFailureCount: 0,
    });
  });

  it('get_worker_status returns queue preview and flags', async () => {
    const inbox = new ConductorInbox();
    let resolveFirstInstruction: (() => void) | undefined;
    const firstInstruction = new Promise<void>((resolve) => {
      resolveFirstInstruction = resolve;
    });

    let promptCount = 0;
    const promptSession = vi.fn(async () => {
      promptCount += 1;
      if (promptCount === 1) {
        return { stopReason: 'end_turn', responseText: 'ready' };
      }
      await firstInstruction;
      return { stopReason: 'end_turn', responseText: 'done' };
    });

    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () =>
        ({
          newSession: vi.fn().mockResolvedValue('sess-1'),
          loadSession: vi.fn().mockResolvedValue(undefined),
          promptSession,
          close: vi.fn().mockResolvedValue(undefined),
        }) as never,
    });

    runtime.start({
      name: 'implementer',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'implementer',
      systemPrompt: 'work',
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'implementer', kind: 'implementer' }],
        kinds: ['implementer'],
      },
    });

    await runtime.waitForIdle();

    runtime.sendWorkerMessage('implementer', 'in-flight task');
    await vi.waitFor(() => {
      expect(runtime.runningCount).toBe(1);
    });

    runtime.sendWorkerMessage('implementer', 'queued task one');

    const tools = createWorkerStatusTools({
      runtime,
      workerNames: ['implementer'],
      getWorkerFailures: () => [],
    });

    const busy = await tools.get_worker_status.execute({ worker: 'implementer' });
    expect(toolText(busy)).toContain('state: prompting');
    expect(toolText(busy)).toContain('queueDepth: 1');
    expect(toolText(busy)).toContain('queued task one');

    const listed = await tools.list_workers.execute({});
    expect(listed.structuredContent).toMatchObject({ runningCount: 1 });

    resolveFirstInstruction!();
    await runtime.waitForIdle();
    await runtime.shutdown();
  });

  it('reports failed workers and failure count', async () => {
    const inbox = new ConductorInbox();
    const failures: Array<{ name: string; error: string }> = [];
    inbox.subscribe((message) => {
      if (message.type === 'worker.failed') {
        failures.push({ name: message.name, error: message.error });
      }
    });

    const runtime = new WorkerRuntime({
      inbox,
      connectAcp: async () => {
        throw new Error('attach failed');
      },
    });

    runtime.start({
      name: 'reviewer',
      issueUrl: TEST_WORKTREE.issue.url,
      kind: 'reviewer',
      systemPrompt: 'review',
      worktree: TEST_WORKTREE,
      sessionState: {
        workers: [{ name: 'reviewer', kind: 'reviewer' }],
        kinds: ['reviewer'],
      },
    });

    await runtime.waitForIdle();
    await inbox.drain();

    const tools = createWorkerStatusTools({
      runtime,
      workerNames: ['reviewer'],
      getWorkerFailures: () =>
        failures.map((failure, index) => ({
          workerId: `wid-${index}`,
          name: failure.name,
          error: failure.error,
          issueUrl: TEST_WORKTREE.issue.url,
          kind: 'reviewer',
        })),
    });

    const result = await tools.list_workers.execute({});
    expect(toolText(result)).toContain('state: failed');
    expect(toolText(result)).toContain('attach failed');
    expect(toolText(result)).toContain('workerFailureCount: 1');
    expect(runtime.attachedCount).toBe(0);
  });

  it('throws when worker is unknown', async () => {
    const runtime = new WorkerRuntime({ inbox: new ConductorInbox() });
    const tools = createWorkerStatusTools({
      runtime,
      workerNames: ['implementer'],
      getWorkerFailures: () => [],
    });

    await expect(
      tools.get_worker_status.execute({ worker: 'missing' }),
    ).rejects.toThrow('not found');
  });
});
