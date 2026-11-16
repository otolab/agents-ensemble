import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  ONE_TIME_SECRET_INPUT_MAX_BYTES,
  ONE_TIME_SECRET_REQUEST_TTL_MS,
  sendOneTimeSecretControlRequest,
  validateOneTimeSecretBytes,
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
  let abortController: AbortController | undefined;
  let secretBase64 = '';
  let signalHandlers: Array<{
    signal: NodeJS.Signals;
    handler: () => void;
  }> = [];
  let submitStarted = false;

  if (
    !isAbsoluteValue(socketPath) ||
    !/^[A-Za-z0-9_-]{43}$/.test(requestId) ||
    (stdin as typeof process.stdin).isTTY
  ) {
    writeStderr(GENERIC_SECRET_ERROR);
    return 1;
  }

  try {
    const pending = await request<OneTimeSecretRequestInfo>(socketPath, {
      action: 'inspect',
      requestId,
    });
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

    const approved =
      dependencies.confirm?.(pending) ?? confirmOnControllingTerminal(pending);
    if (!approved) {
      await request(socketPath, {
        action: 'abort',
        requestId,
        reservationToken,
      }).catch(() => {});
      reservationToken = undefined;
      writeStderr('One-time secret request cancelled.');
      return 1;
    }

    abortController = new AbortController();
    signalHandlers = registerCancellationSignals(abortController);
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
      { timeoutMs: WORKER_START_ACK_TIMEOUT_MS + 5_000 },
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
  } catch {
    if (reservationToken && !submitStarted) {
      await request(socketPath, {
        action: 'abort',
        requestId,
        reservationToken,
      }).catch(() => {});
    }
    writeStderr(
      submitStarted ? UNKNOWN_SUBMISSION_OUTCOME : GENERIC_SECRET_ERROR,
    );
    return abortController?.signal.aborted ? 130 : 1;
  } finally {
    secretBase64 = '';
    inputBytes?.fill(0);
    abortController?.abort();
    removeCancellationSignals(signalHandlers);
  }
}

const WORKER_START_ACK_TIMEOUT_MS = 10_000;

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

function confirmOnControllingTerminal(
  request: OneTimeSecretRequestInfo,
): boolean {
  let ttyFd: number;
  try {
    ttyFd = openSync('/dev/tty', 'r+');
  } catch {
    throw new Error(GENERIC_SECRET_ERROR);
  }

  try {
    const summary = [
      '',
      'Secret request approval',
      `  worker:  ${JSON.stringify(request.workerName)}`,
      `  secret:  ${JSON.stringify(request.label)}`,
      `  env:     ${JSON.stringify(request.envName)}`,
      `  command: ${JSON.stringify([request.command, ...request.args])}`,
      `  cwd:     ${JSON.stringify(request.cwd)}`,
      `  expires: ${new Date(request.expiresAt).toISOString()}`,
      'Type y to approve this exact request; anything else cancels: ',
    ].join('\n');
    writeSync(ttyFd, summary);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let ended = false;
    while (!ended && totalBytes <= 256) {
      const chunk = Buffer.alloc(64);
      const bytesRead = readSync(ttyFd, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      const lineEnding = chunk.subarray(0, bytesRead).indexOf(0x0a);
      const length = lineEnding >= 0 ? lineEnding + 1 : bytesRead;
      chunks.push(Buffer.from(chunk.subarray(0, length)));
      totalBytes += length;
      ended = lineEnding >= 0;
      chunk.fill(0);
    }
    const answer = Buffer.concat(chunks, totalBytes);
    for (const chunk of chunks) chunk.fill(0);
    const approved =
      ended &&
      answer.toString('utf8').trim().toLowerCase() === 'y' &&
      totalBytes <= 256;
    answer.fill(0);
    return approved;
  } finally {
    closeSync(ttyFd);
  }
}

function registerCancellationSignals(
  controller: AbortController,
): Array<{ signal: NodeJS.Signals; handler: () => void }> {
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => controller.abort();
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
