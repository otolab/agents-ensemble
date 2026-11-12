import {
  type ConductorAgent,
  type ConductorAgentCreateOptions,
  type ConductorAgentFactory,
  type ConductorSendCallbacks,
  type ConductorSendResult,
} from './conductor-agent.js';
import { isConductorSendAuthError } from './conductor-auth.js';

/** セッション中に `ConductorAgent` インスタンスを差し替え可能にする holder。 */
export interface ConductorAgentHandle {
  conductor: ConductorAgent;
}

export interface ConductorReconnectCompleteInfo {
  agentId: string;
  success: boolean;
  source?: 'automatic' | 'manual';
  error?: string;
}

export interface ConductorAutomaticRetryInfo {
  /** @deprecated Same-prompt automatic retry is disabled; this callback is not invoked. */
  attempt: 1;
  reason: 'auth' | 'transport';
}

export interface ConductorReconnectCallbacks {
  source?: 'automatic' | 'manual';
  signal?: AbortSignal;
  onReconnectAttempt?: (input: {
    agentId: string;
    source?: 'automatic' | 'manual';
  }) => void;
  onReconnectComplete?: (input: ConductorReconnectCompleteInfo) => void;
}

/** Direct な options と `conductorOptions` wrapper の両方を受け付ける。 */
export type ConductorReconnectOptions =
  | (ConductorAgentCreateOptions &
      ConductorReconnectCallbacks & {
        conductorAgentFactory: ConductorAgentFactory;
      })
  | ({
      conductorOptions: ConductorAgentCreateOptions;
      conductorAgentFactory: ConductorAgentFactory;
    } & ConductorReconnectCallbacks);

export interface ConductorSendReconnectOptions
  extends ConductorReconnectCallbacks {
  conductorOptions: ConductorAgentCreateOptions;
  conductorAgentFactory: ConductorAgentFactory;
  signal?: AbortSignal;
  /** Prevent reconnect/retry as soon as session shutdown is requested. */
  retrySuppressionSignal?: AbortSignal;
  /** 後方互換用。指定時は auth/transport 両方の attempt に使う。 */
  onReconnectAttempt?: (input: {
    agentId: string;
    source?: 'automatic' | 'manual';
  }) => void;
  onAuthReconnectAttempt?: (input: {
    agentId: string;
    source?: 'automatic' | 'manual';
  }) => void;
  onTransportReconnectAttempt?: (input: {
    agentId: string;
    source?: 'automatic' | 'manual';
  }) => void;
  onAuthReconnectComplete?: (input: ConductorReconnectCompleteInfo) => void;
  onTransportReconnectComplete?: (input: ConductorReconnectCompleteInfo) => void;
  /** @deprecated Same-prompt automatic retry is disabled. */
  onAutomaticRetry?: (input: ConductorAutomaticRetryInfo) => void;
}

// resume に失敗した時点で旧 agent は close 済み。次の operator reconnect では
// 同じ handle を再度 close せず、resume を再試行する。
const closedForReconnect = new WeakSet<ConductorAgentHandle>();

/** close → factory.resume(sameId) で in-process の agent を差し替える。 */
export async function reconnectConductorAgent(
  handle: ConductorAgentHandle,
  options: ConductorReconnectOptions,
): Promise<string> {
  const agentId = handle.conductor.agentId;
  const source = options.source ?? 'manual';
  throwIfReconnectAborted(options.signal);
  options.onReconnectAttempt?.({ agentId, source });
  let conductorOptions: ConductorAgentCreateOptions;
  const conductorAgentFactory = options.conductorAgentFactory;
  if ('conductorOptions' in options) {
    conductorOptions = options.conductorOptions;
  } else {
    const {
      onReconnectAttempt,
      onReconnectComplete,
      source: _source,
      signal: _signal,
      conductorAgentFactory: _conductorAgentFactory,
      ...sdkOptions
    } = options;
    void onReconnectAttempt;
    void onReconnectComplete;
    void _source;
    void _signal;
    void _conductorAgentFactory;
    conductorOptions = sdkOptions;
  }

  try {
    if (!closedForReconnect.has(handle)) {
      await handle.conductor.close();
      closedForReconnect.add(handle);
    }
    throwIfReconnectAborted(options.signal);
    const resumedAgent = await conductorAgentFactory.resume(
      agentId,
      conductorOptions,
    );
    if (options.signal?.aborted) {
      await resumedAgent.close();
      throwIfReconnectAborted(options.signal);
    }
    handle.conductor = resumedAgent;
    closedForReconnect.delete(handle);
    options.onReconnectComplete?.({ agentId, success: true, source });
    return agentId;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    const message = formatReconnectError(error);
    options.onReconnectComplete?.({
      agentId,
      success: false,
      source,
      error: message,
    });
    throw error;
  }
}

/**
 * SDK の RetriableError / transport stall 相当の send 結果かを保守的に判定する。
 * auth-like error は呼び出し側で先に判定するため、ここでは扱わない。
 */
export function isConductorSendTransportError(
  result: ConductorSendResult,
): boolean {
  if (result.status !== 'error') {
    return false;
  }

  const signal = normalizeTransportSignal(
    `${result.error?.message ?? ''} ${result.error?.code ?? ''}`,
  );
  return /connection stalled(?: repeatedly)?|network error|transport error|socket error|connection (?:reset|refused|closed|timed out)|(?:request|operation) timed out|deadline exceeded|service unavailable|retriableerror|econnreset|econnrefused|etimedout|enetunreach|eai again/.test(
    signal,
  );
}

/**
 * send 経路の auth/transport error 時に同一 agentId で in-process 再接続する。
 * send 結果だけでは request 未受理を証明できないため、prompt は再送しない。
 */
export async function sendConductorWithReconnect(
  handle: ConductorAgentHandle,
  message: string,
  options: ConductorSendReconnectOptions & ConductorSendCallbacks,
): Promise<ConductorSendResult> {
  const sendCallbacks: ConductorSendCallbacks = {
    onToolCallStarted: options.onToolCallStarted,
    history: options.history,
  };
  const result = await handle.conductor.send(message, sendCallbacks);
  const reconnectReason = isConductorSendAuthError(result)
    ? 'auth'
    : isConductorSendTransportError(result)
      ? 'transport'
      : undefined;
  const reconnectSignal =
    options.signal && options.retrySuppressionSignal
      ? AbortSignal.any([options.signal, options.retrySuppressionSignal])
      : options.signal ?? options.retrySuppressionSignal;
  if (
    !reconnectReason ||
    reconnectSignal?.aborted
  ) {
    return result;
  }

  try {
    await reconnectConductorAgent(handle, {
      conductorAgentFactory: options.conductorAgentFactory,
      conductorOptions: options.conductorOptions,
      source: 'automatic',
      signal: reconnectSignal,
      onReconnectAttempt: resolveReconnectAttempt(options, reconnectReason),
      onReconnectComplete: resolveReconnectComplete(options, reconnectReason),
    });
  } catch {
    return result;
  }

  return result;
}

function throwIfReconnectAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('Conductor reconnect was aborted.');
  error.name = 'AbortError';
  throw error;
}

function resolveReconnectAttempt(
  options: ConductorSendReconnectOptions,
  reason: 'auth' | 'transport',
): ((input: { agentId: string }) => void) | undefined {
  const callback =
    reason === 'auth'
      ? options.onAuthReconnectAttempt ?? options.onReconnectAttempt
      : options.onTransportReconnectAttempt ?? options.onReconnectAttempt;
  return callback;
}

function resolveReconnectComplete(
  options: ConductorSendReconnectOptions,
  reason: 'auth' | 'transport',
): ((input: ConductorReconnectCompleteInfo) => void) | undefined {
  const callback =
    reason === 'auth'
      ? options.onAuthReconnectComplete
      : options.onTransportReconnectComplete;
  return callback;
}

function normalizeTransportSignal(signal: string): string {
  return signal.toLowerCase().replace(/[_-]+/g, ' ');
}

function formatReconnectError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
