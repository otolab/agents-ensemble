import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  ONE_TIME_SECRET_INPUT_MAX_BYTES,
  ONE_TIME_SECRET_ENV,
  sendOneTimeSecretControlRequest,
  startOneTimeSecretControlServer,
  type OneTimeSecretRequestInfo,
} from '@agents-ensemble/core';
import {
  runSecretExec,
  runSecretPush,
  formatSecretApprovalSummary,
} from './secret-command.js';

const requestId = 'r'.repeat(43);
const workerToken = 'w'.repeat(43);
const socketPath = '/tmp/ens-secret/s.sock';
const controlEnvironment = {
  [ONE_TIME_SECRET_ENV.active]: '1',
  [ONE_TIME_SECRET_ENV.socket]: socketPath,
  [ONE_TIME_SECRET_ENV.worker]: 'implementer',
  [ONE_TIME_SECRET_ENV.token]: workerToken,
  [ONE_TIME_SECRET_ENV.node]: '/usr/bin/node',
  [ONE_TIME_SECRET_ENV.cli]: '/opt/ensemble/dist/index.js',
  PATH: '/usr/bin:/bin',
  HOME: '/tmp/home',
};

describe('one-time secret CLI commands', () => {
  it('escapes terminal and bidi controls in the approval summary without changing field order', () => {
    const summary = formatSecretApprovalSummary({
      requestId,
      socketPath,
      workerName: 'worker\u202e: forged',
      label: 'label\u001b[2J\u2066hidden',
      envName: 'API_TOKEN',
      command: 'curl\u009b2J',
      args: ['first', '\u202e--forged', 'last'],
      cwd: '/tmp/worktree\u2029forged',
      expiresAt: 1_800_000_000_000,
    });

    expect(summary).not.toContain('\u202e');
    expect(summary).not.toContain('\u2066');
    expect(summary).not.toContain('\u2029');
    expect(summary).not.toContain('\u001b');
    expect(summary).not.toContain('\u009b');
    expect(summary).toContain('worker\\u202e: forged');
    expect(summary).toContain('label\\u001b[2J\\u2066hidden');
    expect(summary).toContain('\\u009b2J');
    expect(summary).toContain('\\u202e--forged');
    expect(summary).toContain('worktree\\u2029forged');
    expect(summary.indexOf('  worker:')).toBeLessThan(
      summary.indexOf('  secret:'),
    );
    expect(summary.indexOf('  secret:')).toBeLessThan(summary.indexOf('  env:'));
    expect(summary.indexOf('  env:')).toBeLessThan(
      summary.indexOf('  command:'),
    );
    expect(summary.indexOf('  command:')).toBeLessThan(
      summary.indexOf('  cwd:'),
    );
    expect(summary.indexOf('  cwd:')).toBeLessThan(
      summary.indexOf('  expires:'),
    );
  });

  it('waits for a value and injects it only into the target child env', async () => {
    const secret = 'operator-only-token\n';
    const child = new EventEmitter() as ChildProcess;
    let targetEnv: NodeJS.ProcessEnv | undefined;
    const spawnTarget = vi.fn(
      (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        targetEnv = { ...options.env };
        setImmediate(() => {
          child.emit('spawn');
          child.emit('close', 0, null);
        });
        return child;
      },
    ) as unknown as typeof spawn;
    const controlRequest = vi.fn(
      async (_path: string, input: Record<string, unknown>) => {
        if (input.action === 'request') {
          return {
            requestId,
            secretBase64: Buffer.from(secret).toString('base64'),
          };
        }
        return { acknowledged: true };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;
    const stderr = vi.fn();

    await expect(
      runSecretExec(
        {
          label: 'staging API',
          envName: 'API_TOKEN',
          command: 'curl',
          args: ['https://example.test'],
        },
        {
          env: controlEnvironment,
          cwd: '/tmp/worktree',
          request: controlRequest,
          spawn: spawnTarget,
          writeStderr: stderr,
        },
      ),
    ).resolves.toBe(0);

    expect(spawnTarget).toHaveBeenCalledWith(
      'curl',
      ['https://example.test'],
      expect.objectContaining({
        cwd: '/tmp/worktree',
        shell: false,
        stdio: 'inherit',
      }),
    );
    expect(targetEnv).toMatchObject({ API_TOKEN: secret, PATH: '/usr/bin:/bin' });
    for (const name of Object.values(ONE_TIME_SECRET_ENV)) {
      expect(targetEnv).not.toHaveProperty(name);
    }
    expect(JSON.stringify(controlRequest.mock.calls)).not.toContain(secret);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('fails closed when target process creation fails and reports no secret', async () => {
    const secret = 'do-not-print-this-value';
    const controlRequest = vi.fn(
      async (_path: string, input: Record<string, unknown>) => {
        if (input.action === 'request') {
          return {
            requestId,
            secretBase64: Buffer.from(secret).toString('base64'),
          };
        }
        return { acknowledged: true };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;
    const stderr: string[] = [];
    const spawnTarget = vi.fn(() => {
      throw new Error(secret);
    }) as unknown as typeof spawn;

    await expect(
      runSecretExec(
        {
          label: 'staging API',
          envName: 'API_TOKEN',
          command: 'missing-command',
          args: [],
        },
        {
          env: controlEnvironment,
          request: controlRequest,
          spawn: spawnTarget,
          writeStderr: (message) => stderr.push(message),
        },
      ),
    ).resolves.toBe(1);

    expect(controlRequest).toHaveBeenCalledWith(
      socketPath,
      expect.objectContaining({
        action: 'failed',
        requestId,
        workerName: 'implementer',
        workerToken,
      }),
    );
    expect(stderr.join('\n')).not.toContain(secret);
  });

  it('consumes the request when spawn reports an asynchronous launch error', async () => {
    const secret = 'not-for-errors';
    const child = new EventEmitter() as ChildProcess;
    const failed = vi.fn();
    const controlRequest = vi.fn(
      async (_path: string, payload: Record<string, unknown>) => {
        if (payload.action === 'request') {
          return {
            requestId,
            secretBase64: Buffer.from(secret).toString('base64'),
          };
        }
        if (payload.action === 'failed') failed();
        return { acknowledged: true };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;
    const stderr: string[] = [];
    const spawnTarget = vi.fn(() => {
      setImmediate(() => {
        child.emit('error', new Error(secret));
        child.emit('close', -2, null);
      });
      return child;
    }) as unknown as typeof spawn;

    await expect(
      runSecretExec(
        {
          label: 'staging API',
          envName: 'API_TOKEN',
          command: 'missing-command',
          args: [],
        },
        {
          env: controlEnvironment,
          request: controlRequest,
          spawn: spawnTarget,
          writeStderr: (message) => stderr.push(message),
        },
      ),
    ).resolves.toBe(1);
    expect(failed).toHaveBeenCalledOnce();
    expect(stderr).toEqual(['One-time secret operation failed.']);
    expect(stderr.join('\n')).not.toContain(secret);
  });

  it('rejects an unsupported backend before contacting the secret socket', async () => {
    const controlRequest = vi.fn() as unknown as typeof sendOneTimeSecretControlRequest;
    const spawnTarget = vi.fn() as unknown as typeof spawn;
    const stderr = vi.fn();
    await expect(
      runSecretExec(
        {
          label: 'staging API',
          envName: 'API_TOKEN',
          command: 'curl',
          args: [],
        },
        {
          env: {
            ...controlEnvironment,
            [ONE_TIME_SECRET_ENV.active]: undefined,
          },
          request: controlRequest,
          spawn: spawnTarget,
          writeStderr: stderr,
        },
      ),
    ).resolves.toBe(1);
    expect(controlRequest).not.toHaveBeenCalled();
    expect(spawnTarget).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'One-time secret exec is unavailable in this worker session.',
    );
  });

  it('confirms before reading stdin and preserves input bytes exactly', async () => {
    const input = new PassThrough();
    input.end(Buffer.from('line one\nline two\n'));
    const actions: string[] = [];
    const controlRequest = vi.fn(
      async (_path: string, payload: Record<string, unknown>) => {
        actions.push(String(payload.action));
        if (payload.action === 'inspect') {
          expect(input.readableFlowing).toBeNull();
          return {
            requestId,
            socketPath,
            workerName: 'implementer',
            label: 'staging API',
            envName: 'API_TOKEN',
            command: 'curl',
            args: ['https://example.test'],
            cwd: '/tmp/worktree',
            expiresAt: Date.now() + 60_000,
          };
        }
        if (payload.action === 'reserve') {
          return { requestId, reservationToken: 'p'.repeat(43) };
        }
        if (payload.action === 'submit') {
          expect(
            Buffer.from(String(payload.secretBase64), 'base64').toString('utf8'),
          ).toBe('line one\nline two\n');
          return { status: 'started' };
        }
        return { cancelled: true };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runSecretPush(socketPath, requestId, {
        stdin: input,
        request: controlRequest,
        confirm: () => true,
        writeStdout: (message) => stdout.push(message),
        writeStderr: (message) => stderr.push(message),
      }),
    ).resolves.toBe(0);

    expect(actions).toEqual(['inspect', 'reserve', 'submit']);
    expect(stdout).toEqual(['Secret accepted; the target command started.']);
    expect(stderr).toEqual([]);
    expect(JSON.stringify(controlRequest.mock.calls)).not.toContain(
      'line one\nline two\n',
    );
  });

  it('round trips one approved value through the live harness socket', async () => {
    const requestInfo = deferred<OneTimeSecretRequestInfo>();
    const server = await startOneTimeSecretControlServer({
      workerTokens: new Map([['implementer', workerToken]]),
      onRequest: requestInfo.resolve,
    });
    try {
      const secret = 'integration-only-value\n';
      const target = new EventEmitter() as ChildProcess;
      let targetEnvironment: NodeJS.ProcessEnv | undefined;
      const spawnTarget = vi.fn(
        (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          targetEnvironment = { ...options.env };
          setImmediate(() => {
            target.emit('spawn');
            target.emit('close', 0, null);
          });
          return target;
        },
      ) as unknown as typeof spawn;
      const workerExecution = runSecretExec(
        {
          label: 'integration credential',
          envName: 'API_TOKEN',
          command: 'fake-target',
          args: ['--request'],
        },
        {
          env: {
            ...controlEnvironment,
            [ONE_TIME_SECRET_ENV.socket]: server.socketPath,
          },
          cwd: '/tmp/worktree',
          spawn: spawnTarget,
        },
      );
      const pending = await requestInfo.promise;
      const stdin = new PassThrough();
      stdin.end(Buffer.from(secret));
      const approval = vi.fn(() => true);
      const push = await runSecretPush(
        server.socketPath,
        pending.requestId,
        { stdin, confirm: approval },
      );

      await expect(workerExecution).resolves.toBe(0);
      expect(push).toBe(0);
      expect(approval).toHaveBeenCalledWith(
        expect.objectContaining({
          workerName: 'implementer',
          label: 'integration credential',
          envName: 'API_TOKEN',
          command: 'fake-target',
          args: ['--request'],
          cwd: '/tmp/worktree',
        }),
      );
      expect(targetEnvironment?.API_TOKEN).toBe(secret);
      for (const name of Object.values(ONE_TIME_SECRET_ENV)) {
        expect(targetEnvironment).not.toHaveProperty(name);
      }
      expect(JSON.stringify(approval.mock.calls)).not.toContain(secret);
    } finally {
      await server.close();
    }
  });

  it('does not read stdin for an invalid request ID and consumes invalid input', async () => {
    const input = new PassThrough();
    input.end(Buffer.from('secret'));
    const request = vi.fn() as unknown as typeof sendOneTimeSecretControlRequest;
    const confirm = vi.fn();
    await expect(
      runSecretPush(socketPath, 'invalid', {
        stdin: input,
        request,
        confirm,
      }),
    ).resolves.toBe(1);
    expect(request).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(input.readableFlowing).toBeNull();

    const invalidInput = new PassThrough();
    invalidInput.end(Buffer.from([0x61, 0x00, 0x62]));
    const actions: string[] = [];
    const validId = 'i'.repeat(43);
    const controlRequest = vi.fn(
      async (_path: string, payload: Record<string, unknown>) => {
        actions.push(String(payload.action));
        if (payload.action === 'inspect') {
          return {
            requestId: validId,
            socketPath,
            workerName: 'implementer',
            label: 'target',
            envName: 'TOKEN',
            command: 'program',
            args: [],
            cwd: '/tmp/worktree',
            expiresAt: Date.now() + 60_000,
          };
        }
        if (payload.action === 'reserve') {
          return { requestId: validId, reservationToken: 'p'.repeat(43) };
        }
        return { cancelled: true };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;
    await expect(
      runSecretPush(socketPath, validId, {
        stdin: invalidInput,
        request: controlRequest,
        confirm: () => true,
      }),
    ).resolves.toBe(1);
    expect(actions).toEqual(['inspect', 'reserve', 'abort']);
  });

  it('does not read stdin and cancels the request when the operator rejects it', async () => {
    const input = new PassThrough();
    input.end(Buffer.from('value'));
    const actions: string[] = [];
    const request = vi.fn(
      async (_path: string, payload: Record<string, unknown>) => {
        actions.push(String(payload.action));
        if (payload.action === 'reserve') {
          return { requestId, reservationToken: 'p'.repeat(43) };
        }
        return {
          requestId,
          socketPath,
          workerName: 'implementer',
          label: 'staging API',
          envName: 'API_TOKEN',
          command: 'curl',
          args: [],
          cwd: '/tmp/worktree',
          expiresAt: Date.now() + 60_000,
        };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;

    await expect(
      runSecretPush(socketPath, requestId, {
        stdin: input,
        request,
        confirm: () => false,
      }),
    ).resolves.toBe(1);
    expect(actions).toEqual(['inspect', 'reserve', 'abort']);
    expect(input.readableFlowing).toBeNull();
  });

  it('does not read stdin when the reservation token is malformed', async () => {
    const input = new PassThrough();
    input.end(Buffer.from('value'));
    const actions: string[] = [];
    const request = vi.fn(
      async (_path: string, payload: Record<string, unknown>) => {
        actions.push(String(payload.action));
        if (payload.action === 'inspect') {
          return {
            requestId,
            socketPath,
            workerName: 'implementer',
            label: 'staging API',
            envName: 'API_TOKEN',
            command: 'curl',
            args: [],
            cwd: '/tmp/worktree',
            expiresAt: Date.now() + 60_000,
          };
        }
        return { requestId, reservationToken: 'bad' };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;
    const confirm = vi.fn();

    await expect(
      runSecretPush(socketPath, requestId, {
        stdin: input,
        request,
        confirm,
      }),
    ).resolves.toBe(1);
    expect(actions).toEqual(['inspect', 'reserve']);
    expect(confirm).not.toHaveBeenCalled();
    expect(input.readableFlowing).toBeNull();
  });

  it('rejects oversized stdin before submission and consumes the request', async () => {
    const input = new PassThrough();
    input.end(Buffer.alloc(ONE_TIME_SECRET_INPUT_MAX_BYTES + 1, 0x61));
    const actions: string[] = [];
    const controlRequest = vi.fn(
      async (_path: string, payload: Record<string, unknown>) => {
        actions.push(String(payload.action));
        if (payload.action === 'inspect') {
          return {
            requestId,
            socketPath,
            workerName: 'implementer',
            label: 'staging API',
            envName: 'API_TOKEN',
            command: 'curl',
            args: [],
            cwd: '/tmp/worktree',
            expiresAt: Date.now() + 60_000,
          };
        }
        if (payload.action === 'reserve') {
          return { requestId, reservationToken: 'p'.repeat(43) };
        }
        return { cancelled: true };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;

    await expect(
      runSecretPush(socketPath, requestId, {
        stdin: input,
        request: controlRequest,
        confirm: () => true,
      }),
    ).resolves.toBe(1);
    expect(actions).toEqual(['inspect', 'reserve', 'abort']);
  });

  it('tells the operator not to retry when delivery outcome is unknown', async () => {
    const input = new PassThrough();
    input.end(Buffer.from('value'));
    const stderr: string[] = [];
    const controlRequest = vi.fn(
      async (_path: string, payload: Record<string, unknown>) => {
        if (payload.action === 'inspect') {
          return {
            requestId,
            socketPath,
            workerName: 'implementer',
            label: 'staging API',
            envName: 'API_TOKEN',
            command: 'curl',
            args: [],
            cwd: '/tmp/worktree',
            expiresAt: Date.now() + 60_000,
          };
        }
        if (payload.action === 'reserve') {
          return { requestId, reservationToken: 'p'.repeat(43) };
        }
        if (payload.action === 'submit') return { status: 'unknown' };
        return { cancelled: true };
      },
    ) as unknown as typeof sendOneTimeSecretControlRequest;

    await expect(
      runSecretPush(socketPath, requestId, {
        stdin: input,
        request: controlRequest,
        confirm: () => true,
        writeStderr: (message) => stderr.push(message),
      }),
    ).resolves.toBe(1);
    expect(stderr).toEqual([
      'Secret submission outcome is unknown; do not resubmit until you inspect the target.',
    ]);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
