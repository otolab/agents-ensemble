import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  ONE_TIME_SECRET_INPUT_MAX_BYTES,
  ONE_TIME_SECRET_REQUEST_TTL_MS,
  sendOneTimeSecretControlRequest,
  validateOneTimeSecretBytes,
  escapeTerminalControlCharacters,
  type OneTimeSecretRequestInfo,
  type SecretPushOutcome,
} from '@agents-ensemble/core';

const SECRET_INPUT_TIMEOUT_MS = 30_000;
const SECRET_REQUEST_WAIT_TIMEOUT_MS = ONE_TIME_SECRET_REQUEST_TTL_MS + 5_000;
const GENERIC_SECRET_ERROR = 'One-time secret operation failed.';
const SECRET_EXEC_UNAVAILABLE =
  'One-time secret exec is unavailable in this worker session.';
const UNKNOWN_SUBMISSION_OUTCOME =
  'Secret submission outcome is unknown; do not resubmit until you inspect the target.';
const TARGET_DID_NOT_START =
  'The target command did not start; this request has been consumed.';

interface SecretControlEnvironment {
  ENSEMBLE_SECRET_ACTIVE?: string;
  ENSEMBLE_SECRET_SOCKET?: string;
  ENSEMBLE_SECRET_WORKER?: string;
  ENSEMBLE_SECRET_TOKEN?: string;
  ENSEMBLE_SECRET_NODE?: string;
  ENSEMBLE_SECRET_CLI?: string;
  [key: string]: string | undefined;
}

export interface SecretExecInput {
  label: string;
  envName: string;
  command: string;
  args: string[];
}

export interface SecretExecDependencies {
  env?: SecretControlEnvironment;
  cwd?: string;
  request?: typeof sendOneTimeSecretControlRequest;
  spawn?: typeof spawn;
  writeStderr?: (message: string) => void;
}

export interface SecretPushDependencies {
  stdin?: Readable;
  request?: typeof sendOneTimeSecretControlRequest;
  confirm?: (request: OneTimeSecretRequestInfo) => boolean;
  /** Injectable cancellation signal for callers and phase-specific tests. */
  signal?: AbortSignal;
  writeStdout?: (message: string) => void;
  writeStderr?: (message: string) => void;
}

/** Run a target command with one operator-submitted value in its child env. */
export async function runSecretExec(
  input: SecretExecInput,
  dependencies: SecretExecDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? (process.env as SecretControlEnvironment);
  const request = dependencies.request ?? sendOneTimeSecretControlRequest;
  const writeStderr =
    dependencies.writeStderr ?? ((message) => process.stderr.write(`${message}\n`));
  if (env.ENSEMBLE_SECRET_ACTIVE !== '1') {
    writeStderr(SECRET_EXEC_UNAVAILABLE);
    return 1;
  }
  if (
    !isAbsoluteValue(env.ENSEMBLE_SECRET_SOCKET) ||
    !env.ENSEMBLE_SECRET_WORKER ||
    !env.ENSEMBLE_SECRET_TOKEN ||
    !isAbsoluteValue(env.ENSEMBLE_SECRET_NODE) ||
    !isAbsoluteValue(env.ENSEMBLE_SECRET_CLI) ||
    !isValidEnvName(input.envName) ||
    !input.label.trim() ||
    !input.command ||
    input.command.includes('\0') ||
    input.args.some((argument) => argument.includes('\0'))
  ) {
    writeStderr(GENERIC_SECRET_ERROR);
    return 1;
  }

  let response:
    | { requestId: string; secretBase64: string }
    | undefined;
  let secretBytes: Buffer | undefined;
  let envValue = '';
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  let targetSpawnReturned = false;
  try {
    response = await request<{
      requestId: string;
      secretBase64: string;
    }>(
      env.ENSEMBLE_SECRET_SOCKET,
      {
        action: 'request',
        workerName: env.ENSEMBLE_SECRET_WORKER,
        workerToken: env.ENSEMBLE_SECRET_TOKEN,
        label: input.label,
        envName: input.envName,
        command: input.command,
        args: input.args,
        cwd: dependencies.cwd ?? process.cwd(),
      },
      { timeoutMs: SECRET_REQUEST_WAIT_TIMEOUT_MS },
    );
    if (!/^[A-Za-z0-9_-]{43}$/.test(response.requestId)) {
      response.secretBase64 = '';
      throw new Error(GENERIC_SECRET_ERROR);
    }
    let encodedSecret = response.secretBase64;
    secretBytes = Buffer.from(encodedSecret, 'base64');
    const isCanonicalBase64 =
      secretBytes.toString('base64') === encodedSecret;
    response.secretBase64 = '';
    if (!isCanonicalBase64 || secretBytes.byteLength === 0) {
      encodedSecret = '';
      throw new Error(GENERIC_SECRET_ERROR);
    }
    encodedSecret = '';
    validateOneTimeSecretBytes(secretBytes);
    envValue = new TextDecoder('utf-8', { fatal: true }).decode(secretBytes);
    secretBytes.fill(0);
    secretBytes = undefined;

    childEnvironment = sanitizedTargetEnvironment(env);
    childEnvironment[input.envName] = envValue;
    let child: ChildProcess;
    try {
      child = (dependencies.spawn ?? spawn)(input.command, input.args, {
        cwd: dependencies.cwd ?? process.cwd(),
        env: childEnvironment,
        shell: false,
        stdio: 'inherit',
      });
      targetSpawnReturned = true;
    } catch {
      throw new Error(GENERIC_SECRET_ERROR);
    }
    childEnvironment[input.envName] = '';
    envValue = '';

    return await waitForTargetExit({
      child,
      request,
      socketPath: env.ENSEMBLE_SECRET_SOCKET,
      workerName: env.ENSEMBLE_SECRET_WORKER,
      workerToken: env.ENSEMBLE_SECRET_TOKEN,
      requestId: response.requestId,
      writeStderr,
    });
  } catch {
    if (response && !targetSpawnReturned) {
      await request(env.ENSEMBLE_SECRET_SOCKET!, {
        action: 'failed',
        requestId: response.requestId,
        workerName: env.ENSEMBLE_SECRET_WORKER,
        workerToken: env.ENSEMBLE_SECRET_TOKEN,
      }).catch(() => {});
    }
    secretBytes?.fill(0);
    if (childEnvironment && input.envName in childEnvironment) {
      childEnvironment[input.envName] = '';
    }
    envValue = '';
    writeStderr(GENERIC_SECRET_ERROR);
    return 1;
  }
}

/** Inspect and explicitly approve a pending request before reading stdin. */
export async function runSecretPush(
  socketPath: string,
  requestId: string,
  dependencies: SecretPushDependencies = {},
): Promise<number> {
  const request = dependencies.request ?? sendOneTimeSecretControlRequest;
  const stdin = dependencies.stdin ?? process.stdin;
  const writeStdout =
    dependencies.writeStdout ?? ((message) => process.stdout.write(`${message}\n`));
  const writeStderr =
    dependencies.writeStderr ?? ((message) => process.stderr.write(`${message}\n`));
  let reservationToken: string | undefined;
  let inputBytes: Buffer | undefined;
  const abortController = new AbortController();
  let secretBase64 = '';
  let cancellationSignal: NodeJS.Signals | undefined;
  let signalHandlers: Array<{
    signal: NodeJS.Signals;
    handler: () => void;
  }> = [];
  const externalSignal = dependencies.signal;
  const onExternalAbort = () => {
    cancellationSignal ??= 'SIGINT';
    abortController.abort();
  };
  let submitStarted = false;

  if (
    !isAbsoluteValue(socketPath) ||
    !/^[A-Za-z0-9_-]{43}$/.test(requestId) ||
    (stdin as typeof process.stdin).isTTY
  ) {
    writeStderr(GENERIC_SECRET_ERROR);
    return 1;
  }

  signalHandlers = registerCancellationSignals(abortController, (signal) => {
    cancellationSignal = signal;
  });
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    if (abortController.signal.aborted) throw new SecretPushCancelledError();
    const pending = await request<OneTimeSecretRequestInfo>(socketPath, {
      action: 'inspect',
      requestId,
    });
    if (abortController.signal.aborted) throw new SecretPushCancelledError();
    if (!isMatchingRequest(pending, socketPath, requestId)) {
      writeStderr(GENERIC_SECRET_ERROR);
      return 1;
    }

    const reservation = await request<{
      requestId: string;
      reservationToken: string;
    }>(socketPath, { action: 'reserve', requestId });
    if (
      reservation.requestId !== requestId ||
      typeof reservation.reservationToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(reservation.reservationToken)
    ) {
      writeStderr(GENERIC_SECRET_ERROR);
      return 1;
    }
    reservationToken = reservation.reservationToken;
    if (abortController.signal.aborted) throw new SecretPushCancelledError();

    const approved =
      dependencies.confirm?.(pending) ??
      confirmOnControllingTerminal(pending, abortController.signal);
    if (abortController.signal.aborted) throw new SecretPushCancelledError();
    if (!approved) {
      const cancelled = await abortSecretReservation(
        request,
        socketPath,
        requestId,
        reservationToken,
      );
      reservationToken = undefined;
      writeStderr(
        cancelled
          ? 'One-time secret request cancelled.'
          : 'Cancellation could not be confirmed; the request will expire automatically.',
      );
      return 1;
    }

    inputBytes = await readSecretStdin(stdin, {
      maxBytes: ONE_TIME_SECRET_INPUT_MAX_BYTES,
      timeoutMs: SECRET_INPUT_TIMEOUT_MS,
      signal: abortController.signal,
    });
    validateOneTimeSecretBytes(inputBytes);

    secretBase64 = inputBytes.toString('base64');
    submitStarted = true;
    const outcome = await request<SecretPushOutcome>(
      socketPath,
      {
        action: 'submit',
        requestId,
        reservationToken,
        secretBase64,
      },
      {
        timeoutMs: WORKER_START_ACK_TIMEOUT_MS + 5_000,
        signal: abortController.signal,
      },
    );
    reservationToken = undefined;
    if (outcome.status !== 'started') {
      writeStderr(
        outcome.status === 'failed'
          ? TARGET_DID_NOT_START
          : UNKNOWN_SUBMISSION_OUTCOME,
      );
      return 1;
    }
    writeStdout('Secret accepted; the target command started.');
    return 0;
  } catch (error) {
    const cancelledBeforeSubmit =
      !submitStarted &&
      (abortController.signal.aborted ||
        error instanceof SecretPushCancelledError);
    let reservationCancelled = true;
    if (reservationToken && !submitStarted) {
      reservationCancelled = await abortSecretReservation(
        request,
        socketPath,
        requestId,
        reservationToken,
      );
      reservationToken = undefined;
    }
    if (submitStarted) {
      writeStderr(UNKNOWN_SUBMISSION_OUTCOME);
      return 1;
    }
    if (cancelledBeforeSubmit) {
      writeStderr(
        reservationCancelled
          ? 'One-time secret request cancelled.'
          : 'Cancellation could not be confirmed; the request will expire automatically.',
      );
      return cancellationSignal === 'SIGTERM' ? 143 : 130;
    }
    writeStderr(GENERIC_SECRET_ERROR);
    return 1;
  } finally {
    secretBase64 = '';
    inputBytes?.fill(0);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    removeCancellationSignals(signalHandlers);
    abortController.abort();
  }
}

const WORKER_START_ACK_TIMEOUT_MS = 10_000;

class SecretPushCancelledError extends Error {}

async function abortSecretReservation(
  request: typeof sendOneTimeSecretControlRequest,
  socketPath: string,
  requestId: string,
  reservationToken: string,
): Promise<boolean> {
  try {
    await request(socketPath, {
      action: 'abort',
      requestId,
      reservationToken,
    });
    return true;
  } catch {
    return false;
  }
}

function waitForTargetExit(input: {
  child: ChildProcess;
  request: typeof sendOneTimeSecretControlRequest;
  socketPath: string;
  workerName: string;
  workerToken: string;
  requestId: string;
  writeStderr: (message: string) => void;
}): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    let spawned = false;
    let launchFailureReported = false;
    let outcomeAcknowledged = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const reportLaunchFailure = () => {
      if (launchFailureReported) return;
      launchFailureReported = true;
      acknowledge('failed');
      input.writeStderr(GENERIC_SECRET_ERROR);
      finish(1);
    };
    const acknowledge = (action: 'started' | 'failed') => {
      if (outcomeAcknowledged) return;
      outcomeAcknowledged = true;
      void input
        .request(
          input.socketPath,
          {
            action,
            requestId: input.requestId,
            workerName: input.workerName,
            workerToken: input.workerToken,
          },
        )
        .catch(() => {});
    };

    input.child.once('spawn', () => {
      spawned = true;
      acknowledge('started');
    });
    input.child.once('error', () => {
      if (!spawned) reportLaunchFailure();
    });
    input.child.once('close', (code, signal) => {
      if (!spawned) {
        reportLaunchFailure();
        return;
      }
      finish(signal ? 1 : (code ?? 1));
    });
  });
}

function sanitizedTargetEnvironment(
  source: SecretControlEnvironment,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('ENSEMBLE_SECRET_')) delete environment[name];
  }
  return environment;
}

function readSecretStdin(
  input: Readable,
  options: {
    maxBytes: number;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      options.signal.removeEventListener('abort', onAbort);
    };
    const clearChunks = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      clearChunks();
      input.pause();
      reject(new Error(GENERIC_SECRET_ERROR));
    };
    const onData = (chunk: Buffer | string) => {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
        fail();
        return;
      }
      const chunkBytes = Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : Buffer.byteLength(chunk);
      if (totalBytes + chunkBytes > options.maxBytes) {
        fail();
        return;
      }
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const value = Buffer.concat(chunks, totalBytes);
      clearChunks();
      resolve(value);
    };
    const onError = () => fail();
    const onAbort = () => fail();
    const timeout = setTimeout(fail, options.timeoutMs);

    if (options.signal.aborted) {
      fail();
      return;
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

export function formatSecretApprovalSummary(
  request: OneTimeSecretRequestInfo,
): string {
  const escapeJson = (value: unknown) =>
    escapeTerminalControlCharacters(JSON.stringify(value));
  return [
    '',
    'Secret request approval',
    `  worker:  ${escapeJson(request.workerName)}`,
    `  secret:  ${escapeJson(request.label)}`,
    `  env:     ${escapeJson(request.envName)}`,
    `  command: ${escapeJson([request.command, ...request.args])}`,
    `  cwd:     ${escapeJson(request.cwd)}`,
    `  expires: ${new Date(request.expiresAt).toISOString()}`,
    'Type y to approve this exact request; anything else cancels: ',
  ].join('\n');
}

function confirmOnControllingTerminal(
  request: OneTimeSecretRequestInfo,
  signal: AbortSignal,
): boolean {
  let ttyFd: number;
  try {
    ttyFd = openSync('/dev/tty', 'r+');
  } catch {
    throw new Error(GENERIC_SECRET_ERROR);
  }

  try {
    if (signal.aborted) throw new SecretPushCancelledError();
    writeSync(ttyFd, formatSecretApprovalSummary(request));

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let ended = false;
    let answer: Buffer | undefined;
    try {
      while (!ended && totalBytes <= 256) {
        if (signal.aborted) throw new SecretPushCancelledError();
        const chunk = Buffer.alloc(64);
        try {
          let bytesRead: number;
          try {
            bytesRead = readSync(ttyFd, chunk, 0, chunk.byteLength, null);
          } catch (error) {
            if (isInterruptedSystemCall(error)) {
              throw new SecretPushCancelledError();
            }
            throw error;
          }
          if (bytesRead === 0) break;
          const lineEnding = chunk.subarray(0, bytesRead).indexOf(0x0a);
          const length = lineEnding >= 0 ? lineEnding + 1 : bytesRead;
          chunks.push(Buffer.from(chunk.subarray(0, length)));
          totalBytes += length;
          ended = lineEnding >= 0;
        } finally {
          chunk.fill(0);
        }
      }
      answer = Buffer.concat(chunks, totalBytes);
      return (
        ended &&
        answer.toString('utf8').trim().toLowerCase() === 'y' &&
        totalBytes <= 256
      );
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      answer?.fill(0);
    }
  } finally {
    closeSync(ttyFd);
  }
}

function registerCancellationSignals(
  controller: AbortController,
  onSignal: (signal: NodeJS.Signals) => void,
): Array<{ signal: NodeJS.Signals; handler: () => void }> {
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => {
      onSignal(signal);
      controller.abort();
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  return [...handlers];
}

function removeCancellationSignals(
  handlers: Array<{ signal: NodeJS.Signals; handler: () => void }>,
): void {
  for (const { signal, handler } of handlers) {
    process.off(signal, handler);
  }
}

function isMatchingRequest(
  value: OneTimeSecretRequestInfo,
  socketPath: string,
  requestId: string,
): value is OneTimeSecretRequestInfo {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.requestId === requestId &&
    value.socketPath === socketPath &&
    typeof value.workerName === 'string' &&
    typeof value.label === 'string' &&
    typeof value.envName === 'string' &&
    typeof value.command === 'string' &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === 'string') &&
    typeof value.cwd === 'string' &&
    Number.isSafeInteger(value.expiresAt)
  );
}

function isValidEnvName(value: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    !value.startsWith('ENSEMBLE_SECRET_')
  );
}

function isAbsoluteValue(value: string | undefined): value is string {
  return Boolean(value && value.startsWith('/'));
}

function isInterruptedSystemCall(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'EINTR'
  );
}
