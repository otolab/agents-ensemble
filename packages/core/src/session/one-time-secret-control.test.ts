import { access, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ONE_TIME_SECRET_INPUT_MAX_BYTES,
  ONE_TIME_SECRET_REQUEST_TTL_MS,
  isOneTimeSecretPlatformSupported,
  sendOneTimeSecretControlRequest,
  startOneTimeSecretControlServer,
  validateOneTimeSecretBytes,
  type OneTimeSecretControlServer,
  type OneTimeSecretRequestInfo,
} from './one-time-secret-control.js';

const workerName = 'implementer';
const workerToken = 'w'.repeat(43);
const requestInput = {
  action: 'request',
  workerName,
  workerToken,
  label: 'staging API',
  envName: 'API_TOKEN',
  command: 'curl',
  args: ['--fail', 'https://example.test'],
  cwd: '/tmp/issue-worktree',
};

describe('one-time secret control', () => {
  let server: OneTimeSecretControlServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('supports only macOS and Linux IPC runtimes', () => {
    expect(isOneTimeSecretPlatformSupported('darwin')).toBe(true);
    expect(isOneTimeSecretPlatformSupported('linux')).toBe(true);
    expect(isOneTimeSecretPlatformSupported('win32')).toBe(false);
    expect(isOneTimeSecretPlatformSupported('freebsd')).toBe(false);
  });

  it('binds one high-entropy request to its worker and consumes it once', async () => {
    const pendingEvent = deferred<OneTimeSecretRequestInfo>();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: pendingEvent.resolve,
    });
    const [directory, socket] = await Promise.all([
      stat(dirname(server.socketPath)),
      stat(server.socketPath),
    ]);
    expect(directory.mode & 0o777).toBe(0o700);
    expect(socket.mode & 0o777).toBe(0o600);

    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        ...requestInput,
        workerToken: 'x'.repeat(43),
      }),
    ).rejects.toThrow();

    const workerWait = sendOneTimeSecretControlRequest<{
      requestId: string;
      secretBase64: string;
    }>(server.socketPath, requestInput, { timeoutMs: 2_000 });
    const pending = await pendingEvent.promise;
    expect(pending.requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.requestId).not.toBe(workerToken);

    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'inspect',
        requestId: 'guess',
      }),
    ).rejects.toThrow();
    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'submit',
        requestId: pending.requestId,
        reservationToken: 'not-reserved',
        secretBase64: Buffer.from('must-not-run').toString('base64'),
      }),
    ).rejects.toThrow();

    const inspected = await sendOneTimeSecretControlRequest<
      OneTimeSecretRequestInfo
    >(server.socketPath, {
      action: 'inspect',
      requestId: pending.requestId,
    });
    expect(inspected).toMatchObject({
      workerName,
      label: 'staging API',
      envName: 'API_TOKEN',
      command: 'curl',
      args: ['--fail', 'https://example.test'],
      cwd: '/tmp/issue-worktree',
    });

    const reservations = await Promise.allSettled([
      sendOneTimeSecretControlRequest<{
        requestId: string;
        reservationToken: string;
      }>(server.socketPath, {
        action: 'reserve',
        requestId: pending.requestId,
      }),
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'reserve',
        requestId: pending.requestId,
      }),
    ]);
    expect(reservations.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(reservations.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const reservation = reservations.find(
      (result): result is PromiseFulfilledResult<{
        requestId: string;
        reservationToken: string;
      }> => result.status === 'fulfilled',
    )!.value;

    const secret = Buffer.from('line one\nline two\n', 'utf8');
    const push = sendOneTimeSecretControlRequest<{ status: string }>(
      server.socketPath,
      {
        action: 'submit',
        requestId: pending.requestId,
        reservationToken: reservation.reservationToken,
        secretBase64: secret.toString('base64'),
      },
      { timeoutMs: 2_000 },
    );
    const received = await workerWait;
    expect(Buffer.from(received.secretBase64, 'base64')).toEqual(secret);
    expect(received.requestId).toBe(pending.requestId);

    // A stale inspect must not turn a delivered request into a reported failure.
    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'inspect',
        requestId: pending.requestId,
      }),
    ).rejects.toThrow();
    await sendOneTimeSecretControlRequest(server.socketPath, {
      action: 'started',
      requestId: pending.requestId,
      workerName,
      workerToken,
    });
    await expect(push).resolves.toEqual({ status: 'started' });
    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'started',
        requestId: pending.requestId,
        workerName,
        workerToken,
      }),
    ).rejects.toThrow();
    secret.fill(0);
  });

  it('allows only one waiting request per worker', async () => {
    const pendingEvent = deferred<OneTimeSecretRequestInfo>();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: pendingEvent.resolve,
    });
    const workerWait = sendOneTimeSecretControlRequest(
      server.socketPath,
      requestInput,
      { timeoutMs: 2_000 },
    );
    const workerWaitRejected = expect(workerWait).rejects.toThrow();
    await pendingEvent.promise;

    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, requestInput),
    ).rejects.toThrow();
    await server.close();
    await workerWaitRejected;
  });

  it('cancels without execution when the waiting worker disconnects', async () => {
    const pendingEvent = deferred<OneTimeSecretRequestInfo>();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: pendingEvent.resolve,
    });
    const socket = net.createConnection(server.socketPath);
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(`${JSON.stringify(requestInput)}\n`);
    const pending = await pendingEvent.promise;
    socket.destroy();

    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'inspect',
        requestId: pending.requestId,
      }),
    ).rejects.toThrow();
  });

  it('expires a waiting request and rejects a late push', async () => {
    const pendingEvent = deferred<OneTimeSecretRequestInfo>();
    let now = 10_000;
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: pendingEvent.resolve,
      now: () => now,
    });
    const workerWait = sendOneTimeSecretControlRequest(
      server.socketPath,
      requestInput,
      { timeoutMs: 2_000 },
    );
    const pending = await pendingEvent.promise;
    now += ONE_TIME_SECRET_REQUEST_TTL_MS + 1;

    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'inspect',
        requestId: pending.requestId,
      }),
    ).rejects.toThrow();
    await expect(workerWait).rejects.toThrow();
    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'reserve',
        requestId: pending.requestId,
      }),
    ).rejects.toThrow();
  });

  it('consumes a request when command startup fails', async () => {
    const pendingEvent = deferred<OneTimeSecretRequestInfo>();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: pendingEvent.resolve,
    });
    const workerWait = sendOneTimeSecretControlRequest<{
      requestId: string;
      secretBase64: string;
    }>(server.socketPath, requestInput, { timeoutMs: 2_000 });
    const pending = await pendingEvent.promise;
    const reservation = await sendOneTimeSecretControlRequest<{
      requestId: string;
      reservationToken: string;
    }>(server.socketPath, {
      action: 'reserve',
      requestId: pending.requestId,
    });
    const push = sendOneTimeSecretControlRequest<{ status: string }>(
      server.socketPath,
      {
        action: 'submit',
        requestId: pending.requestId,
        reservationToken: reservation.reservationToken,
        secretBase64: Buffer.from('value').toString('base64'),
      },
      { timeoutMs: 2_000 },
    );
    await workerWait;
    await sendOneTimeSecretControlRequest(server.socketPath, {
      action: 'failed',
      requestId: pending.requestId,
      workerName,
      workerToken,
    });
    await expect(push).resolves.toEqual({ status: 'failed' });
    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'reserve',
        requestId: pending.requestId,
      }),
    ).rejects.toThrow();
  });

  it('does not retain a request across harness restart', async () => {
    const pendingEvent = deferred<OneTimeSecretRequestInfo>();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: pendingEvent.resolve,
    });
    const workerWait = sendOneTimeSecretControlRequest(
      server.socketPath,
      requestInput,
      { timeoutMs: 2_000 },
    );
    const workerWaitRejected = expect(workerWait).rejects.toThrow();
    const pending = await pendingEvent.promise;
    const oldServer = server;
    await oldServer.close();
    await expect(access(dirname(oldServer.socketPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: () => {},
    });
    await expect(
      sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'inspect',
        requestId: pending.requestId,
      }),
    ).rejects.toThrow();
    await workerWaitRejected;
  });

  it('rejects empty, oversized, NUL-containing, and invalid UTF-8 values', () => {
    expect(() => validateOneTimeSecretBytes(Buffer.alloc(0))).toThrow();
    expect(() =>
      validateOneTimeSecretBytes(Buffer.alloc(ONE_TIME_SECRET_INPUT_MAX_BYTES + 1, 1)),
    ).toThrow();
    expect(() => validateOneTimeSecretBytes(Buffer.from([0x61, 0x00, 0x62]))).toThrow();
    expect(() => validateOneTimeSecretBytes(Buffer.from([0xc3, 0x28]))).toThrow();
    expect(() => validateOneTimeSecretBytes(Buffer.from('first\nsecond\n'))).not.toThrow();
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
