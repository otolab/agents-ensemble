import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('clears owned request fragments and the accumulator when a client disconnects mid-message', async () => {
    const secretMarker = 'c2VjcmV0';
    const watched = watchSecretConcats(secretMarker);
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: () => {},
    });
    const socket = net.createConnection(server.socketPath);
    socket.on('error', () => {});
    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(`{"action":"submit","secretBase64":"${secretMarker}`);
      await watched.seen;
      socket.destroy();
      await server.close();
      server = undefined;

      expectBuffersCleared(watched.buffers);
    } finally {
      socket.destroy();
      watched.restore();
    }
  });

  it('clears server request fragments when the receive timeout fires', async () => {
    const secretMarker = 'c2VjcmV0';
    const watched = watchSecretConcats(secretMarker);
    const accepted = captureAcceptedSocket();
    const timeout = shortenServerSocketTimeouts();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: () => {},
    });
    const socket = net.createConnection(server.socketPath);
    socket.on('error', () => {});

    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(`{"action":"submit","secretBase64":"${secretMarker}`);
      await watched.seen;
      const acceptedSocket = await accepted.socket;
      await timeout.waitFor(acceptedSocket);

      expect(timeout.firedTimeouts).toContainEqual({
        socket: acceptedSocket,
        registration: 1,
      });
      expectBuffersCleared(watched.buffers);
    } finally {
      socket.destroy();
      await server.close();
      server = undefined;
      accepted.restore();
      timeout.restore();
      watched.restore();
    }
  });

  it('clears server request fragments when the receiving socket emits an error', async () => {
    const secretMarker = 'c2VjcmV0';
    const watched = watchSecretConcats(secretMarker);
    const accepted = captureAcceptedSocket();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: () => {},
    });
    const client = net.createConnection(server.socketPath);
    client.on('error', () => {});

    try {
      await new Promise<void>((resolve) => client.once('connect', resolve));
      client.write(`{"action":"submit","secretBase64":"${secretMarker}`);
      await watched.seen;
      const acceptedSocket = await accepted.socket;
      const error = deferred<Error>();
      acceptedSocket.once('error', error.resolve);
      acceptedSocket.destroy(new Error('test server receive socket error'));

      expect(await error.promise).toBeInstanceOf(Error);
      expectBuffersCleared(watched.buffers);
    } finally {
      client.destroy();
      await server.close();
      server = undefined;
      accepted.restore();
      watched.restore();
    }
  });

  it('clears client response fragments when the receiving socket emits an error', async () => {
    const secretMarker = 'c2VjcmV0';
    const watched = watchSecretConcats(secretMarker);
    const client = captureClientSocket();
    const fakeServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => {
        socket.write(
          `{"ok":true,"result":{"secretBase64":"${secretMarker}`,
        );
      });
    });
    const directory = await mkdtemp(join(tmpdir(), 'ens-secret-client-error-'));
    const socketPath = join(directory, 's.sock');

    try {
      await new Promise<void>((resolve, reject) => {
        fakeServer.once('error', reject);
        fakeServer.listen(socketPath, resolve);
      });
      const pending = sendOneTimeSecretControlRequest(
        socketPath,
        { action: 'inspect' },
        { timeoutMs: 2_000 },
      );
      const clientSocket = await client.socket;
      const error = deferred<Error>();
      clientSocket.once('error', error.resolve);
      await watched.seen;
      clientSocket.destroy(new Error('test client receive socket error'));

      expect(await error.promise).toBeInstanceOf(Error);
      await expect(pending).rejects.toThrow();
      expectBuffersCleared(watched.buffers);
    } finally {
      await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
      client.restore();
      watched.restore();
    }
  });

  it('clears a secret response body when its socket send times out', async () => {
    const pendingEvent = deferred<OneTimeSecretRequestInfo>();
    const secretBase64 = Buffer.from('timeout-response-secret').toString('base64');
    const markerBytes = Buffer.from(secretBase64);
    const responseBodies: Buffer[] = [];
    const responseSockets: net.Socket[] = [];
    const responseWriteStarted = deferred<void>();
    const timeout = shortenServerSocketTimeouts();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: pendingEvent.resolve,
    });
    const originalEnd = net.Socket.prototype.end;
    const endSpy = vi
      .spyOn(net.Socket.prototype, 'end')
      .mockImplementation(function (
        this: net.Socket,
        ...args: Parameters<net.Socket['end']>
      ) {
        const body = args[0];
        if (Buffer.isBuffer(body) && body.includes(markerBytes)) {
          responseBodies.push(body);
          responseSockets.push(this);
          responseWriteStarted.resolve();
          // Leave this owned body queued at the IPC layer until the real
          // socket timeout fires. Do not call Node's write path.
          return this;
        }
        return originalEnd.apply(this, args);
      });

    let workerWaitRejected: Promise<boolean> | undefined;
    let submitSettled: Promise<void> | undefined;
    try {
      const workerWait = sendOneTimeSecretControlRequest<{
        requestId: string;
        secretBase64: string;
      }>(server.socketPath, requestInput, { timeoutMs: 2_000 });
      workerWaitRejected = workerWait.then(
        () => false,
        () => true,
      );
      const pending = await pendingEvent.promise;
      const reservation = await sendOneTimeSecretControlRequest<{
        requestId: string;
        reservationToken: string;
      }>(server.socketPath, {
        action: 'reserve',
        requestId: pending.requestId,
      });
      const submit = sendOneTimeSecretControlRequest<{ status: string }>(
        server.socketPath,
        {
          action: 'submit',
          requestId: pending.requestId,
          reservationToken: reservation.reservationToken,
          secretBase64,
        },
        { timeoutMs: 2_000 },
      );
      submitSettled = submit.then(
        () => {},
        () => {},
      );

      await responseWriteStarted.promise;
      expect(responseSockets).toHaveLength(1);
      await timeout.waitFor(responseSockets[0]!);
      expect(await workerWaitRejected).toBe(true);
      expect(responseBodies).toHaveLength(1);
      expect(timeout.firedTimeouts).toContainEqual({
        socket: responseSockets[0],
        registration: 2,
      });
      expectBuffersCleared(responseBodies);
    } finally {
      endSpy.mockRestore();
      await server.close();
      server = undefined;
      await submitSettled;
      timeout.restore();
    }
  });

  it.each(['disconnect', 'timeout', 'abort'] as const)(
    'clears partial response buffers after client %s',
    async (failureMode) => {
      const secretMarker = 'c2VjcmV0';
      const watched = watchSecretConcats(secretMarker);
      const directory = await mkdtemp(join(tmpdir(), 'ens-secret-client-'));
      const socketPath = join(directory, 's.sock');
      const cancellation = new AbortController();
      const fakeServer = net.createServer((socket) => {
        socket.once('data', () => {
          socket.write(
            `{"ok":true,"result":{"secretBase64":"${secretMarker}`,
            () => {
              if (failureMode === 'disconnect') socket.destroy();
            },
          );
        });
      });

      try {
        await new Promise<void>((resolve, reject) => {
          fakeServer.once('error', reject);
          fakeServer.listen(socketPath, resolve);
        });
        const pending = sendOneTimeSecretControlRequest(
          socketPath,
          { action: 'submit', secretBase64: secretMarker },
          {
            timeoutMs: failureMode === 'timeout' ? 50 : 1_000,
            signal: cancellation.signal,
          },
        );
        await watched.seen;
        if (failureMode === 'abort') cancellation.abort();
        await expect(pending).rejects.toThrow();

        expectBuffersCleared(watched.buffers);
      } finally {
        await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
        watched.restore();
      }
    },
  );

  it('clears the secret-bearing response body Buffer after a successful write', async () => {
    const pendingEvent = deferred<OneTimeSecretRequestInfo>();
    server = await startOneTimeSecretControlServer({
      workerTokens: new Map([[workerName, workerToken]]),
      onRequest: pendingEvent.resolve,
    });
    const secretBase64 = Buffer.from('response-only-secret').toString('base64');
    const responseBuffers: Buffer[] = [];
    const originalEnd = net.Socket.prototype.end;
    const endSpy = vi
      .spyOn(net.Socket.prototype, 'end')
      .mockImplementation(function (
        this: net.Socket,
        ...args: Parameters<net.Socket['end']>
      ) {
        const body = args[0];
        if (
          Buffer.isBuffer(body) &&
          body.toString('utf8').includes(secretBase64)
        ) {
          responseBuffers.push(body);
        }
        return originalEnd.apply(this, args);
      });

    try {
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
      const submit = sendOneTimeSecretControlRequest<{ status: string }>(
        server.socketPath,
        {
          action: 'submit',
          requestId: pending.requestId,
          reservationToken: reservation.reservationToken,
          secretBase64,
        },
        { timeoutMs: 2_000 },
      );
      await expect(workerWait).resolves.toMatchObject({ secretBase64 });
      await sendOneTimeSecretControlRequest(server.socketPath, {
        action: 'started',
        requestId: pending.requestId,
        workerName,
        workerToken,
      });
      await expect(submit).resolves.toEqual({ status: 'started' });

      expect(responseBuffers).toHaveLength(1);
      expectBuffersCleared(responseBuffers);
    } finally {
      endSpy.mockRestore();
    }
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

function watchSecretConcats(marker: string): {
  buffers: Buffer[];
  seen: Promise<void>;
  restore: () => void;
} {
  const markerBytes = Buffer.from(marker);
  const buffers: Buffer[] = [];
  let markSeen!: () => void;
  const seen = new Promise<void>((resolve) => {
    markSeen = resolve;
  });
  const originalConcat = Buffer.concat.bind(Buffer);
  const spy = vi.spyOn(Buffer, 'concat').mockImplementation((list, totalLength) => {
    const result = originalConcat(list, totalLength);
    if (result.includes(markerBytes)) {
      for (const part of list) {
        if (Buffer.isBuffer(part)) buffers.push(part);
      }
      buffers.push(result);
      markSeen();
    }
    return result;
  });
  return { buffers, seen, restore: () => spy.mockRestore() };
}

function captureAcceptedSocket(): {
  socket: Promise<net.Socket>;
  restore: () => void;
} {
  const accepted = deferred<net.Socket>();
  const originalCreateServer = net.createServer;
  const spy = vi.spyOn(net, 'createServer').mockImplementation(
    ((...args: Parameters<typeof net.createServer>) => {
      const created = Reflect.apply(originalCreateServer, net, args) as net.Server;
      created.once('connection', (socket) => accepted.resolve(socket));
      return created;
    }) as typeof net.createServer,
  );
  return { socket: accepted.promise, restore: () => spy.mockRestore() };
}

function captureClientSocket(): {
  socket: Promise<net.Socket>;
  restore: () => void;
} {
  const connected = deferred<net.Socket>();
  const originalCreateConnection = net.createConnection;
  const spy = vi.spyOn(net, 'createConnection').mockImplementation(
    ((...args: Parameters<typeof net.createConnection>) => {
      const socket = Reflect.apply(
        originalCreateConnection,
        net,
        args,
      ) as net.Socket;
      connected.resolve(socket);
      return socket;
    }) as typeof net.createConnection,
  );
  return { socket: connected.promise, restore: () => spy.mockRestore() };
}

function shortenServerSocketTimeouts(): {
  waitFor: (socket: net.Socket) => Promise<void>;
  firedTimeouts: Array<{ socket: net.Socket; registration: number }>;
  restore: () => void;
} {
  const firedTimeouts: Array<{ socket: net.Socket; registration: number }> = [];
  const registrationCounts = new Map<net.Socket, number>();
  const waiting = new Map<net.Socket, Array<() => void>>();
  const originalSetTimeout = net.Socket.prototype.setTimeout;
  const spy = vi
    .spyOn(net.Socket.prototype, 'setTimeout')
    .mockImplementation(function (
      this: net.Socket,
      timeout?: number,
      callback?: () => void,
    ) {
      if (timeout === 10_000 && !this.connecting) {
        const registration = (registrationCounts.get(this) ?? 0) + 1;
        registrationCounts.set(this, registration);
        return originalSetTimeout.call(this, 25, () => {
          firedTimeouts.push({ socket: this, registration });
          callback?.();
          for (const resolve of waiting.get(this) ?? []) resolve();
          waiting.delete(this);
        });
      }
      return originalSetTimeout.call(this, timeout, callback);
    });
  return {
    waitFor: (socket) => {
      if (firedTimeouts.some((event) => event.socket === socket)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const socketWaiters = waiting.get(socket) ?? [];
        socketWaiters.push(resolve);
        waiting.set(socket, socketWaiters);
      });
    },
    firedTimeouts,
    restore: () => spy.mockRestore(),
  };
}

function expectBuffersCleared(buffers: Buffer[]): void {
  expect(buffers.length).toBeGreaterThan(0);
  expect(
    buffers.every((buffer) => buffer.every((byte) => byte === 0)),
  ).toBe(true);
}
