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
  error?: string;
}

export interface ConductorAutomaticRetryInfo {
  /** 同一 prompt の自動 retry は1回だけ。 */
  attempt: 1;
  reason: 'auth' | 'transport';
}

export interface ConductorReconnectCallbacks {
  onReconnectAttempt?: (input: { agentId: string }) => void;
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
  onReconnectAttempt?: (input: { agentId: string }) => void;
  onAuthReconnectAttempt?: (input: { agentId: string }) => void;
  onTransportReconnectAttempt?: (input: { agentId: string }) => void;
  onAuthReconnectComplete?: (input: ConductorReconnectCompleteInfo) => void;
  onTransportReconnectComplete?: (input: ConductorReconnectCompleteInfo) => void;
  /** 自動 retry を行う場合、その直前に一度だけ呼び出す。 */
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
  options.onReconnectAttempt?.({ agentId });
  let conductorOptions: ConductorAgentCreateOptions;
  const conductorAgentFactory = options.conductorAgentFactory;
  if ('conductorOptions' in options) {
    conductorOptions = options.conductorOptions;
  } else {
    const {
      onReconnectAttempt,
      onReconnectComplete,
      conductorAgentFactory: _conductorAgentFactory,
      ...sdkOptions
    } = options;
    void onReconnectAttempt;
    void onReconnectComplete;
    void _conductorAgentFactory;
    conductorOptions = sdkOptions;
  }

  try {
    if (!closedForReconnect.has(handle)) {
      await handle.conductor.close();
      closedForReconnect.add(handle);
    }
    handle.conductor = await conductorAgentFactory.resume(
      agentId,
      conductorOptions,
    );
    closedForReconnect.delete(handle);
    options.onReconnectComplete?.({ agentId, success: true });
    return agentId;
  } catch (error) {
    const message = formatReconnectError(error);
    options.onReconnectComplete?.({
      agentId,
      success: false,
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
 * tool 開始通知がなければ同じ prompt を 1 回だけ再試行する。tool が始まっていた場合は
 * 副作用の重複を避けて再送せず、元の error 結果を返す。
 */
export async function sendConductorWithReconnect(
  handle: ConductorAgentHandle,
  message: string,
  options: ConductorSendReconnectOptions & ConductorSendCallbacks,
): Promise<ConductorSendResult> {
  let toolCallStarted = false;
  const sendCallbacks: ConductorSendCallbacks = {
    onToolCallStarted: (info) => {
      toolCallStarted = true;
      options.onToolCallStarted?.(info);
    },
    history: options.history,
  };
  const result = await handle.conductor.send(message, sendCallbacks);
  const reconnectReason = isConductorSendAuthError(result)
    ? 'auth'
    : isConductorSendTransportError(result)
      ? 'transport'
      : undefined;
  if (
    !reconnectReason ||
    options.signal?.aborted ||
    options.retrySuppressionSignal?.aborted
  ) {
    return result;
  }

  try {
    await reconnectConductorAgent(handle, {
      conductorAgentFactory: options.conductorAgentFactory,
      conductorOptions: options.conductorOptions,
      onReconnectAttempt: resolveReconnectAttempt(options, reconnectReason),
      onReconnectComplete: resolveReconnectComplete(options, reconnectReason),
    });
  } catch {
    return result;
  }

  if (
    options.signal?.aborted ||
    options.retrySuppressionSignal?.aborted ||
    toolCallStarted
  ) {
    return result;
  }

  options.onAutomaticRetry?.({
    attempt: 1,
    reason: reconnectReason,
  });
  return handle.conductor.send(message, sendCallbacks);
}

function resolveReconnectAttempt(
  options: ConductorSendReconnectOptions,
  reason: 'auth' | 'transport',
): ((input: { agentId: string }) => void) | undefined {
  if (reason === 'auth') {
    return options.onAuthReconnectAttempt ?? options.onReconnectAttempt;
  }
  return options.onTransportReconnectAttempt ?? options.onReconnectAttempt;
}

function resolveReconnectComplete(
  options: ConductorSendReconnectOptions,
  reason: 'auth' | 'transport',
): ((input: ConductorReconnectCompleteInfo) => void) | undefined {
  if (reason === 'auth') {
    return options.onAuthReconnectComplete;
  }
  return options.onTransportReconnectComplete;
}

function normalizeTransportSignal(signal: string): string {
  return signal.toLowerCase().replace(/[_-]+/g, ' ');
}

function formatReconnectError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
