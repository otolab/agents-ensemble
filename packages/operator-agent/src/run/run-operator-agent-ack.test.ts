import { readSchedulingStats } from '../../../cli/src/session-scheduling-stats.js';
import { createFakeAgent, createOutput, writeOperatorSettings } from '../../test/support/operator-fixtures.js';
import { waitForNotification } from '../../test/support/wait.js';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { createInteractiveInput } from '../../test/support/interactive-input.js';
import xterm from '@xterm/headless';
import { PiConductorAgent } from '../../../core/src/conductor/pi-conductor-agent.js';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startOpenQuestionControlServer,
  resolveEnsemblePaths,
  type SessionObservationSnapshot,
} from '@agents-ensemble/core';
import {
  MCP_CONFIG_FILE,
  listUserLocatedSessionResumeStoresPage,
} from '@agents-ensemble/core/operator-runtime';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
} from '@agents-ensemble/core/operator-runtime';
import {
  runOperatorAgent,
  type OperatorAgentInput,
} from '../run-operator-agent.js';
import {
  OPERATOR_WATCH_ACK_MAX_RETRIES,
  OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
  retryOperatorWatchAcknowledgement,
} from '../watch/operator-watch-ack.js';
import { createOperatorDispatchQueue } from '../dispatch/operator-dispatch.js';
import { withOperatorWorkspaceLock } from '../workspace/operator-workspace-lock.js';
import {
  createOperatorWatchPool,
  operatorWatchStatePath,
} from '../watch/operator-watch-pool.js';
import {
  loadOperatorAgentState,
  listOperatorAgentStates,
  operatorAgentStatePath,
  operatorPiSessionDirectory,
  saveOperatorAgentState,
  type OperatorAgentState,
} from './operator-agent-state.js';

const watchPollHarness = vi.hoisted(() => ({
  pending: new Set<Promise<unknown>>(),
  onCompleted: undefined as ((id: string, count: number) => void) | undefined,
  onAcknowledged: undefined as (() => void) | undefined,
}));

vi.mock('../watch/operator-watch-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../watch/operator-watch-pool.js')>();
  return {
    ...actual,
    createOperatorWatchPool: async (...args: Parameters<typeof actual.createOperatorWatchPool>) => {
      const pool = await actual.createOperatorWatchPool(...args);
      const track = <T>(operation: Promise<T>): Promise<T> => {
        watchPollHarness.pending.add(operation);
        void operation.then(
          () => watchPollHarness.pending.delete(operation),
          () => watchPollHarness.pending.delete(operation),
        );
        return operation;
      };
      const pollOnce = pool.pollOnce.bind(pool);
      const polling = new Set<string>();
      pool.pollOnce = (id) => track((async () => {
        if (polling.has(id)) return pollOnce(id);
        polling.add(id);
        try {
          const count = await pollOnce(id);
          watchPollHarness.onCompleted?.(id, count);
          return count;
        } finally {
          polling.delete(id);
        }
      })());
      const acknowledge = pool.acknowledge.bind(pool);
      pool.acknowledge = async (...args) => {
        const result = await acknowledge(...args);
        if (args[0].some((event) => event.type === 'report' && event.reportId)) {
          watchPollHarness.onAcknowledged?.();
        }
        return result;
      };
      return pool;
    },
  };
});

function nextWatchPoll(minimumReports = 0): Promise<void> {
  return new Promise((resolve) => {
    watchPollHarness.onCompleted = (id, count) => {
      if (id !== 'conductor-one' || count < minimumReports) return;
      watchPollHarness.onCompleted = undefined;
      resolve();
    };
  });
}

describe('retryOperatorWatchAcknowledgement', () => {
  it('retries only the ack at five-second intervals and resolves after repeated failures', async () => {
    const delays: number[] = [];
    const acknowledge = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first lock contention'))
      .mockRejectedValueOnce(new Error('second lock contention'))
      .mockResolvedValueOnce(undefined);
    const onRetry = vi.fn();

    const result = await retryOperatorWatchAcknowledgement(
      acknowledge,
      async (delayMs) => {
        delays.push(delayMs);
        return false;
      },
      onRetry,
    );

    expect(result).toEqual({
      status: 'acknowledged',
      attempts: 3,
      retries: 2,
    });
    expect(acknowledge).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([
      OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
      OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
    ]);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2);
  });

  it('stops after the retry budget and returns the error without a hot loop', async () => {
    const delays: number[] = [];
    const failure = new Error('profile lock remains unavailable');
    const acknowledge = vi.fn<() => Promise<void>>().mockRejectedValue(failure);

    const result = await retryOperatorWatchAcknowledgement(
      acknowledge,
      async (delayMs) => {
        delays.push(delayMs);
        return false;
      },
    );

    expect(result).toEqual({
      status: 'exhausted',
      attempts: OPERATOR_WATCH_ACK_MAX_RETRIES + 1,
      retries: OPERATOR_WATCH_ACK_MAX_RETRIES,
      error: failure,
    });
    expect(acknowledge).toHaveBeenCalledTimes(OPERATOR_WATCH_ACK_MAX_RETRIES + 1);
    expect(delays).toEqual(
      Array(OPERATOR_WATCH_ACK_MAX_RETRIES).fill(
        OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
      ),
    );
  });

  it('does not start another ack attempt when shutdown interrupts the retry delay', async () => {
    const acknowledge = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('profile lock contention'));

    const result = await retryOperatorWatchAcknowledgement(
      acknowledge,
      async (delayMs) => {
        expect(delayMs).toBe(OPERATOR_WATCH_ACK_RETRY_DELAY_MS);
        return true;
      },
    );

    expect(result).toEqual({ status: 'stopped', attempts: 1, retries: 1 });
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});
