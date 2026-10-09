import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
} from '../../src/conductor/conductor-agent.js';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import type { OperatorInputBindingApi } from '../../src/conductor/operator-input-binding.js';
import {
  SessionLogger,
  type SessionLogEvent,
} from '../../src/conductor/session/session-logger.js';
import { DEFAULT_ENSEMBLE_CONFIG } from '../../src/config/defaults.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import * as resolveGitHubAuthTokenModule from '../../src/github/resolve-github-auth-token.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import type { Profile } from '../../src/profile/types.js';
import { createInProcessAcpBridge } from './helpers/in-process-acp-bridge.js';

const TEST_ISSUE = {
  owner: 'org',
  repo: 'repo',
  number: 416,
  url: 'https://github.com/org/repo/issues/416',
} as const;

const PERMISSION_PROFILE: Profile = {
  acp: {
    preset: 'custom',
    command: process.execPath,
  },
  workers: [
    { name: 'completed-worker', kind: 'implementer' },
    { name: 'permission-worker', kind: 'implementer' },
  ],
};

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFakeConductorFactory(input: {
  onSend: (message: string) => Promise<void>;
  onTools: (options: ConductorAgentCreateOptions) => void;
}): ConductorAgentFactory {
  let sendCount = 0;
  const conductor: ConductorAgent = {
    agentId: 'fake-conductor',
    async send(message) {
      sendCount += 1;
      await input.onSend(message);
      return {
        runId: `fake-run-${sendCount}`,
        status: 'finished',
        result: `fake conductor send ${sendCount}`,
      };
    },
    async reload() {},
    async getUsage() {
      return {};
    },
    async setSystemPrompt() {},
    async close() {},
  };

  return {
    async create(options) {
      input.onTools(options);
      return conductor;
    },
    async resume(_agentId, options) {
      input.onTools(options);
      return conductor;
    },
  };
}

describe('permission stall session integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wires a fake worker permission stall through monitor, queue, sinks, hold, and max-turn recovery', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-permission-stall-'));
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Permission stall integration',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(
      resolveGitHubAuthTokenModule,
      'resolveGitHubAuthToken',
    ).mockResolvedValue({
      token: 'test-github-token',
      source: 'GITHUB_TOKEN',
    });

    const createWorkerBridge = () =>
      createInProcessAcpBridge(async ({ notify, sessionId }) => {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'fake worker completed' },
          },
        });
        return { stopReason: 'end_turn' };
      });
    const completedBridge = await createWorkerBridge();
    const permissionBridge = await createInProcessAcpBridge(
      async ({ notify, sessionId }) => {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'fake worker completed' },
          },
        });
        return { stopReason: 'end_turn' };
      },
      { requestPermissionOnPrompt: true },
    );

    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    const emitted: SessionLogEvent[] = [];
    const operatorWarnings: SessionLogEvent[] = [];
    const pendingEvents: Array<
      Extract<SessionLogEvent, { type: 'permission.pending' }>
    > = [];
    const inboundSources: string[][] = [];
    const holdEvents: Array<
      Extract<SessionLogEvent, { type: 'conductor.dispatch_hold' }>
    > = [];
    let conductorTools: ConductorAgentCreateOptions['customTools'];
    let operatorApi: OperatorInputBindingApi | undefined;
    let pendingResolved = false;
    const sentMessages: string[] = [];
    const releaseCompleted = createDeferred<void>();
    let warningSeen = false;
    let completedWorkerRoundSeen = false;
    let releaseScheduled = false;

    const scheduleRelease = () => {
      if (!warningSeen || !completedWorkerRoundSeen || releaseScheduled) {
        return;
      }
      releaseScheduled = true;
      // Let the monitor finish onStall and the Driver buffer it first so both
      // permission events plus the max-turn-blocked worker event are held.
      setTimeout(() => {
        void conductorTools!.set_dispatch_hold!
          .execute({ hold: false })
          .then(() => releaseCompleted.resolve())
          .catch((error: unknown) => releaseCompleted.reject(error));
      }, 0);
    };

    const operatorSink = (event: SessionLogEvent) => {
      if (event.type !== 'harness.warning') return;
      operatorWarnings.push(event);
      warningSeen = true;
      scheduleRelease();
    };
    sessionLogger.subscribe(operatorSink);
    sessionLogger.subscribe((event) => {
      emitted.push(event);
      if (event.type === 'permission.pending') {
        pendingEvents.push(event);
      }
      if (
        event.type === 'worker.round' &&
        event.dispatch.name === 'completed-worker'
      ) {
        completedWorkerRoundSeen = true;
        scheduleRelease();
      }
      if (event.type === 'conductor.inbound') {
        inboundSources.push(event.sources);
      }
      if (event.type === 'conductor.dispatch_hold') {
        holdEvents.push(event);
      }
    });

    const conductorAgentFactory = createFakeConductorFactory({
      onTools: (options) => {
        conductorTools = options.customTools;
      },
      onSend: async (message) => {
        sentMessages.push(message);

        if (sentMessages.length === 1) {
          await conductorTools!.set_dispatch_hold!.execute({ hold: true });
          await releaseCompleted.promise;
          return;
        }

        if (message.includes('## permission 判断待ち')) {
          const pending = pendingEvents[0];
          expect(pending).toBeDefined();
          await conductorTools!.resolve_permission!.execute({
            requestId: pending!.permission.id,
            decision: 'allow',
          });
          pendingResolved = true;
          return;
        }

        if (message.includes('## permission 停滞警告')) {
          expect(pendingResolved).toBe(true);
          setTimeout(() => operatorApi?.submit('/exit'), 0);
        }
      },
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      ensembleConfig: DEFAULT_ENSEMBLE_CONFIG,
      profile: PERMISSION_PROFILE,
      workerWorktree: {
        path: repoRoot,
        branch: 'main',
        issue: TEST_ISSUE,
        inRepo: true,
      },
      conductorAgentFactory,
      connectAcp: async (options) =>
        options.spawn?.workerName === 'permission-worker'
          ? permissionBridge
          : completedBridge,
      permissionPipeline: new PermissionPipeline({}),
      ownsWorkerAcpConnections: true,
      disableGitHubMonitor: true,
      permissionDeadlockStallMs: 1_000,
      permissionDeadlockPollMs: 10,
      maxTurns: 1,
      waitForOperatorExit: false,
      registerProcessSignalHandlers: false,
      sessionLogger,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
    });

    await releaseCompleted.promise;

    expect(result.stopReason).toBe('completed');
    expect(operatorWarnings).toHaveLength(1);
    expect(operatorWarnings[0]).toMatchObject({
      type: 'harness.warning',
      message: expect.stringContaining('1s'),
    });
    expect(pendingEvents).toHaveLength(1);
    const eventMessages = sentMessages.slice(1);
    expect(
      eventMessages.filter((message) => message.includes('## permission 判断待ち')),
    ).toHaveLength(1);
    expect(
      eventMessages.filter((message) => message.includes('## permission 停滞警告')),
    ).toHaveLength(1);
    expect(
      eventMessages.find((message) => message.includes('## permission 判断待ち')),
    ).not.toContain('## permission 停滞警告');
    expect(
      eventMessages.find((message) => message.includes('## permission 停滞警告')),
    ).not.toContain('## permission 判断待ち');
    expect(pendingResolved).toBe(true);
    expect(completedWorkerRoundSeen).toBe(true);

    expect(inboundSources).toEqual(
      expect.arrayContaining([
        ['permission'],
        ['permission.stall'],
      ]),
    );
    expect(
      inboundSources.some((sources) =>
        sources.some((source) => source.startsWith('worker:')),
      ),
    ).toBe(false);

    expect(holdEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'enabled', hold: true }),
        expect.objectContaining({
          status: 'released',
          hold: false,
          flushedEventCount: 3,
        }),
      ]),
    );
    expect(
      emitted.filter((event) => event.type === 'harness.warning'),
    ).toHaveLength(1);
  }, 20_000);
});
