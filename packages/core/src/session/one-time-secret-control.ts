import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import net from 'node:net';
import type { Server, Socket } from 'node:net';

export const ONE_TIME_SECRET_REQUEST_TTL_MS = 120_000;
export const ONE_TIME_SECRET_INPUT_MAX_BYTES = 64 * 1024;
export const ONE_TIME_SECRET_MAX_PENDING_REQUESTS = 8;
export const ONE_TIME_SECRET_ENV = {
  active: 'ENSEMBLE_SECRET_ACTIVE',
  socket: 'ENSEMBLE_SECRET_SOCKET',
  worker: 'ENSEMBLE_SECRET_WORKER',
  token: 'ENSEMBLE_SECRET_TOKEN',
  node: 'ENSEMBLE_SECRET_NODE',
  cli: 'ENSEMBLE_SECRET_CLI',
} as const;

const MAX_CONTROL_MESSAGE_BYTES = 128 * 1024;
const WORKER_START_ACK_TIMEOUT_MS = 10_000;
const SOCKET_REQUEST_TIMEOUT_MS = 10_000;

export function isOneTimeSecretPlatformSupported(
  platform: string = process.platform,
): boolean {
  return platform === 'darwin' || platform === 'linux';
}

export interface OneTimeSecretRequestInfo {
  requestId: string;
  socketPath: string;
  workerName: string;
  label: string;
  envName: string;
  command: string;
  args: string[];
  cwd: string;
  expiresAt: number;
}

export interface OneTimeSecretControlServerOptions {
  /** A per-worker bearer token. Tokens are generated for the live session only. */
  workerTokens: ReadonlyMap<string, string>;
  onRequest: (request: OneTimeSecretRequestInfo) => void;
  /** Injectable only to test expiry boundaries. */
  now?: () => number;
}

export interface OneTimeSecretControlServer {
  socketPath: string;
  close: () => Promise<void>;
}

interface SecretRecord {
  info: OneTimeSecretRequestInfo;
  workerToken: string;
  state: 'pending' | 'reserved' | 'delivering';
  reservationToken?: string;
  resolveDelivery: (value: {
    requestId: string;
    secretBase64: string;
  }) => void;
  rejectDelivery: () => void;
  resolveOutcome: (outcome: SecretPushOutcome) => void;
  outcome: Promise<SecretPushOutcome>;
  expiryTimer?: NodeJS.Timeout;
  acknowledgementTimer?: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

export type SecretPushOutcome =
  | { status: 'started' }
  | { status: 'failed' }
  | { status: 'unknown' };

class OneTimeSecretRequestError extends Error {}

/**
 * Keeps one-shot requests in memory for the lifetime of a live harness only.
 * Request payloads and secrets are never written to disk or logged here.
 */
class OneTimeSecretBroker {
  private readonly records = new Map<string, SecretRecord>();
  private closed = false;

  constructor(
    private readonly options: OneTimeSecretControlServerOptions,
    private readonly socketPath: string,
  ) {}

  async handle(
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.closed || !isRecord(input) || typeof input.action !== 'string') {
      throw new OneTimeSecretRequestError();
    }

    switch (input.action) {
      case 'request':
        return this.createRequest(input, signal);
      case 'inspect':
        return this.inspect(input.requestId);
      case 'reserve':
        return this.reserve(input.requestId);
      case 'abort':
        return this.abortReservation(input.requestId, input.reservationToken);
      case 'submit': {
        let secretBase64 = input.secretBase64;
        input.secretBase64 = '';
        const submitted = this.submit(
          input.requestId,
          input.reservationToken,
          secretBase64,
        );
        secretBase64 = '';
        return submitted;
      }
      case 'started':
        return this.acknowledge(input, 'started');
      case 'failed':
        return this.acknowledge(input, 'failed');
      default:
        throw new OneTimeSecretRequestError();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.records.values()) {
      this.consume(record, { status: 'unknown' });
    }
  }

  private async createRequest(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ requestId: string; secretBase64: string }> {
    const workerName = input.workerName;
    const workerToken = input.workerToken;
    if (
      typeof workerName !== 'string' ||
      typeof workerToken !== 'string' ||
      !this.isAuthorizedWorker(workerName, workerToken)
    ) {
      throw new OneTimeSecretRequestError();
    }

    const metadata = parseRequestMetadata(input);
    if (!metadata) throw new OneTimeSecretRequestError();

    const workerRequestCount = [...this.records.values()].filter(
      (record) => record.info.workerName === workerName,
    ).length;
    if (
      workerRequestCount > 0 ||
      this.records.size >= ONE_TIME_SECRET_MAX_PENDING_REQUESTS
    ) {
      throw new OneTimeSecretRequestError();
    }

    let resolveDelivery!: SecretRecord['resolveDelivery'];
    let rejectDelivery!: SecretRecord['rejectDelivery'];
    const delivery = new Promise<{
      requestId: string;
      secretBase64: string;
    }>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    // The pending worker request is awaited by the server handler. This
    // rejection is consumed there and intentionally carries no detail.
    void delivery.catch(() => {});

    let resolveOutcome!: SecretRecord['resolveOutcome'];
    const outcome = new Promise<SecretPushOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const requestId = randomBytes(32).toString('base64url');
    const info: OneTimeSecretRequestInfo = {
      requestId,
      socketPath: this.socketPath,
      workerName,
      ...metadata,
      expiresAt:
        (this.options.now ?? Date.now)() + ONE_TIME_SECRET_REQUEST_TTL_MS,
    };
    const record: SecretRecord = {
      info,
      workerToken,
      state: 'pending',
      resolveDelivery,
      rejectDelivery,
      resolveOutcome,
      outcome,
    };

    const onAbort = () => {
      if (record.state !== 'delivering') {
        this.consume(record, { status: 'failed' });
      }
    };
    if (signal.aborted) {
      onAbort();
      throw new OneTimeSecretRequestError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    record.removeAbortListener = () =>
      signal.removeEventListener('abort', onAbort);
    record.expiryTimer = setTimeout(() => {
      if (record.state !== 'delivering') {
        this.consume(record, { status: 'failed' });
      }
    }, ONE_TIME_SECRET_REQUEST_TTL_MS);
    this.records.set(requestId, record);

    try {
      this.options.onRequest({ ...info, args: [...info.args] });
    } catch {
      this.consume(record, { status: 'failed' });
      throw new OneTimeSecretRequestError();
    }

    return delivery;
  }

  private inspect(requestId: unknown): OneTimeSecretRequestInfo {
    const record = this.findLivePendingRecord(requestId);
    if (record.state !== 'pending') throw new OneTimeSecretRequestError();
    return { ...record.info, args: [...record.info.args] };
  }

  private reserve(requestId: unknown): {
    requestId: string;
    reservationToken: string;
  } {
    const record = this.findLivePendingRecord(requestId);
    if (record.state !== 'pending') throw new OneTimeSecretRequestError();
    record.state = 'reserved';
    record.reservationToken = randomBytes(32).toString('base64url');
    return {
      requestId: record.info.requestId,
      reservationToken: record.reservationToken,
    };
  }

  private abortReservation(
    requestId: unknown,
    reservationToken: unknown,
  ): { cancelled: true } {
    const record = this.findReservation(requestId, reservationToken);
    this.consume(record, { status: 'failed' });
    return { cancelled: true };
  }

  private async submit(
    requestId: unknown,
    reservationToken: unknown,
    secretBase64: unknown,
  ): Promise<SecretPushOutcome> {
    const record = this.findReservation(requestId, reservationToken);
    const secret = decodeSecret(secretBase64);
    secretBase64 = '';
    record.state = 'delivering';
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.removeAbortListener?.();
    record.acknowledgementTimer = setTimeout(() => {
      this.consume(record, { status: 'unknown' });
    }, WORKER_START_ACK_TIMEOUT_MS);

    const encodedSecret = secret.toString('base64');
    secret.fill(0);
    const resolveDelivery = record.resolveDelivery;
    record.resolveDelivery = () => {};
    resolveDelivery({
      requestId: record.info.requestId,
      secretBase64: encodedSecret,
    });
    return record.outcome;
  }

  private acknowledge(
    input: Record<string, unknown>,
    outcome: 'started' | 'failed',
  ): { acknowledged: true } {
    const requestId = input.requestId;
    const workerName = input.workerName;
    const workerToken = input.workerToken;
    if (
      typeof requestId !== 'string' ||
      typeof workerName !== 'string' ||
      typeof workerToken !== 'string'
    ) {
      throw new OneTimeSecretRequestError();
    }
    const record = this.records.get(requestId);
    if (
      !record ||
      record.state !== 'delivering' ||
      record.info.workerName !== workerName ||
      !this.matchesToken(record.workerToken, workerToken)
    ) {
      throw new OneTimeSecretRequestError();
    }
    this.consume(record, { status: outcome });
    return { acknowledged: true };
  }

  private findLivePendingRecord(requestId: unknown): SecretRecord {
    if (typeof requestId !== 'string') throw new OneTimeSecretRequestError();
    const record = this.records.get(requestId);
    if (!record) throw new OneTimeSecretRequestError();
    if (record.state === 'delivering') throw new OneTimeSecretRequestError();
    if (record.info.expiresAt <= (this.options.now ?? Date.now)()) {
      this.consume(record, { status: 'failed' });
      throw new OneTimeSecretRequestError();
    }
    return record;
  }

  private findReservation(
    requestId: unknown,
    reservationToken: unknown,
  ): SecretRecord {
    const record = this.findLivePendingRecord(requestId);
    if (
      record.state !== 'reserved' ||
      typeof reservationToken !== 'string' ||
      !record.reservationToken ||
      !this.matchesToken(record.reservationToken, reservationToken)
    ) {
      throw new OneTimeSecretRequestError();
    }
    return record;
  }

  private isAuthorizedWorker(name: string, token: string): boolean {
    const expected = this.options.workerTokens.get(name);
    return expected !== undefined && this.matchesToken(expected, token);
  }

  private matchesToken(expected: string, received: string): boolean {
    const expectedBytes = Buffer.from(expected);
    const receivedBytes = Buffer.from(received);
    return (
      expectedBytes.byteLength === receivedBytes.byteLength &&
      timingSafeEqual(expectedBytes, receivedBytes)
    );
  }

  private consume(record: SecretRecord, outcome: SecretPushOutcome): void {
    if (this.records.get(record.info.requestId) !== record) return;
    this.records.delete(record.info.requestId);
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    if (record.acknowledgementTimer) {
      clearTimeout(record.acknowledgementTimer);
    }
    record.removeAbortListener?.();
    record.reservationToken = undefined;
    record.rejectDelivery();
    record.rejectDelivery = () => {};
    record.resolveOutcome(outcome);
    record.resolveOutcome = () => {};
  }
}

/**
 * Start an in-memory one-shot broker on a private Unix-domain socket.
 * Unix peer credentials are not available through Node's portable net API;
 * access is therefore limited by the socket directory/socket mode and
 * per-worker bearer tokens, with same-user processes inside the trust boundary.
 */
export async function startOneTimeSecretControlServer(
  options: OneTimeSecretControlServerOptions,
): Promise<OneTimeSecretControlServer> {
  if (!isOneTimeSecretPlatformSupported()) {
    throw new Error('One-time secret IPC requires macOS or Linux.');
  }

  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'ens-secret-'));
  const socketPath = join(runtimeDirectory, 's.sock');
  const sockets = new Set<Socket>();
  const activeRequests = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let server: Server | undefined;
  const broker = new OneTimeSecretBroker(options, socketPath);

  try {
    await chmod(runtimeDirectory, 0o700);
    server = net.createServer((socket) => {
      if (closing || sockets.size >= 32) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      const controller = new AbortController();
      socket.setTimeout(SOCKET_REQUEST_TIMEOUT_MS, () => socket.destroy());
      socket.on('close', () => {
        sockets.delete(socket);
        controller.abort();
      });
      socket.on('error', () => {});

      let buffer = Buffer.alloc(0);
      let handled = false;
      socket.on('data', (chunk: Buffer) => {
        if (handled) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
          handled = true;
          buffer.fill(0);
          buffer = Buffer.alloc(0);
          void writeControlResponse(socket, {
            ok: false,
            error: 'Secret control request failed.',
          });
          return;
        }
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex < 0) return;
        handled = true;
        socket.setTimeout(0);
        let rawLine = buffer.subarray(0, newlineIndex).toString('utf8');
        const hasInvalidTrailing = buffer
          .subarray(newlineIndex + 1)
          .some((byte) => !isJsonWhitespace(byte));
        buffer.fill(0);
        buffer = Buffer.alloc(0);
        if (hasInvalidTrailing) {
          void writeControlResponse(socket, {
            ok: false,
            error: 'Secret control request failed.',
          });
          return;
        }

        let request: unknown;
        try {
          request = JSON.parse(rawLine);
        } catch {
          rawLine = '';
          void writeControlResponse(socket, {
            ok: false,
            error: 'Secret control request failed.',
          });
          return;
        }
        rawLine = '';

        const activeRequest = Promise.resolve()
          .then(() => broker.handle(request, controller.signal))
          .then(
            (result) =>
              writeControlResponse(socket, { ok: true, result }),
            () =>
              writeControlResponse(socket, {
                ok: false,
                error: 'Secret control request failed.',
              }),
          )
          .finally(() => {
            activeRequests.delete(activeRequest);
          });
        activeRequests.add(activeRequest);
      });
    });

    await listen(server, socketPath);
    await chmod(socketPath, 0o600);
  } catch (error) {
    broker.close();
    if (server?.listening) {
      await closeServer(server, sockets).catch(() => {});
    }
    await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const activeServer = server!;
  return {
    socketPath,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        broker.close();
        for (const socket of sockets) socket.destroy();
        try {
          await closeServer(activeServer, sockets);
          await Promise.allSettled([...activeRequests]);
        } finally {
          await rm(runtimeDirectory, { recursive: true, force: true });
        }
      })();
      return closePromise;
    },
  };
}

export function sendOneTimeSecretControlRequest<T>(
  socketPath: string,
  request: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  let serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > MAX_CONTROL_MESSAGE_BYTES) {
    serialized = '';
    return Promise.reject(new Error('One-time secret control request failed.'));
  }
  const timeoutMs = options.timeoutMs ?? SOCKET_REQUEST_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer: Buffer = Buffer.alloc(0);
    let requestBody = '';
    const clearBuffer = () => {
      buffer.fill(0);
      buffer = Buffer.alloc(0);
    };
    const cleanup = () => {
      socket.setTimeout(0);
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      socket.off('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
      serialized = '';
      requestBody = '';
      clearBuffer();
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
      socket.destroy();
    };
    const fail = () =>
      settle(() => reject(new Error('One-time secret control request failed.')));
    const onConnect = () => {
      requestBody = `${serialized}\n`;
      serialized = '';
      socket.write(requestBody, (error) => {
        requestBody = '';
        if (error) fail();
      });
    };
    const onData = (chunk: Buffer) => {
      buffer = appendAndWipeBuffer(buffer, chunk);
      if (buffer.byteLength > MAX_CONTROL_MESSAGE_BYTES) {
        fail();
        return;
      }
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex < 0) return;
      const line = buffer.subarray(0, newlineIndex).toString('utf8');
      try {
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response.ok !== true || !Object.hasOwn(response, 'result')) {
          fail();
          return;
        }
        settle(() => resolve(response.result as T));
      } catch {
        fail();
      }
    };
    const onEnd = () => fail();
    const onClose = () => {
      if (!settled) fail();
    };
    const onError = () => fail();
    const onAbort = () => fail();

    socket.setTimeout(timeoutMs, fail);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('connect', onConnect);
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onClose);
    socket.on('error', onError);
    if (options.signal?.aborted) fail();
  });
}

export function validateOneTimeSecretBytes(value: Buffer): void {
  if (
    value.byteLength === 0 ||
    value.byteLength > ONE_TIME_SECRET_INPUT_MAX_BYTES ||
    value.includes(0)
  ) {
    throw new Error('Secret input is invalid.');
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error('Secret input is invalid.');
  }
}

function parseRequestMetadata(
  input: Record<string, unknown>,
): Pick<
  OneTimeSecretRequestInfo,
  'label' | 'envName' | 'command' | 'args' | 'cwd'
> | undefined {
  const { label, envName, command, args, cwd } = input;
  if (
    typeof label !== 'string' ||
    label.trim().length === 0 ||
    Buffer.byteLength(label) > 128 ||
    typeof envName !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName) ||
    envName.startsWith('ENSEMBLE_SECRET_') ||
    typeof command !== 'string' ||
    command.length === 0 ||
    Buffer.byteLength(command) > 4096 ||
    command.includes('\0') ||
    !Array.isArray(args) ||
    args.length > 128 ||
    !args.every(
      (argument) =>
        typeof argument === 'string' &&
        !argument.includes('\0') &&
        Buffer.byteLength(argument) <= 4096,
    ) ||
    Buffer.byteLength(JSON.stringify(args)) > 16 * 1024 ||
    typeof cwd !== 'string' ||
    !isAbsolute(cwd) ||
    Buffer.byteLength(cwd) > 4096 ||
    cwd.includes('\0')
  ) {
    return undefined;
  }
  return {
    label,
    envName,
    command,
    args: [...args] as string[],
    cwd,
  };
}

function decodeSecret(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil(ONE_TIME_SECRET_INPUT_MAX_BYTES / 3) * 4
  ) {
    throw new OneTimeSecretRequestError();
  }
  const decoded = Buffer.from(value, 'base64');
  try {
    if (decoded.toString('base64') !== value) {
      throw new OneTimeSecretRequestError();
    }
    validateOneTimeSecretBytes(decoded);
    return decoded;
  } catch {
    decoded.fill(0);
    throw new OneTimeSecretRequestError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  for (const socket of sockets) socket.destroy();
  return closed;
}

async function writeControlResponse(
  socket: Socket,
  response: { ok: true; result: unknown } | { ok: false; error: string },
): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  let serialized = JSON.stringify(response);
  let body = Buffer.from(`${serialized}\n`);
  serialized = '';
  if (Buffer.byteLength(body) > MAX_CONTROL_MESSAGE_BYTES) {
    body.fill(0);
    body = Buffer.from(
      '{"ok":false,"error":"Secret control response failed."}\n',
    );
  }
  try {
    await endSocket(socket, body);
  } finally {
    body.fill(0);
  }
}

function endSocket(socket: Socket, body: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.off('close', finish);
      socket.off('error', finish);
      resolve();
    };
    socket.once('close', finish);
    socket.once('error', finish);
    socket.setTimeout(SOCKET_REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      finish();
    });
    try {
      socket.end(body, finish);
    } catch {
      finish();
    }
  });
}

/**
 * Append a socket fragment while clearing the two application-owned input
 * buffers. Node's socket-provided chunk is left untouched; `fragment` is the
 * private copy whose contents we own and can overwrite.
 */
function appendAndWipeBuffer(current: Buffer, chunk: Buffer): Buffer {
  const fragment = Buffer.from(chunk);
  try {
    return Buffer.concat([current, fragment]);
  } finally {
    current.fill(0);
    fragment.fill(0);
  }
}
