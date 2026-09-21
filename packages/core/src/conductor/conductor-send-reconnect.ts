import {
  ConductorAgent,
  type ConductorAgentOptions,
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

export interface ConductorReconnectCallbacks {
  onReconnectAttempt?: (input: { agentId: string }) => void;
  onReconnectComplete?: (input: ConductorReconnectCompleteInfo) => void;
}

/** Direct な SDK options と既存の wrapper の両方を受け付ける。 */
export type ConductorReconnectOptions =
  | (ConductorAgentOptions & ConductorReconnectCallbacks)
  | ({ conductorOptions: ConductorAgentOptions } & ConductorReconnectCallbacks);

export interface ConductorSendReconnectOptions
  extends ConductorReconnectCallbacks {
  conductorOptions: ConductorAgentOptions;
  /** 後方互換用。指定時は auth/transport 両方の attempt に使う。 */
  onReconnectAttempt?: (input: { agentId: string }) => void;
  onAuthReconnectAttempt?: (input: { agentId: string }) => void;
  onTransportReconnectAttempt?: (input: { agentId: string }) => void;
  onAuthReconnectComplete?: (input: ConductorReconnectCompleteInfo) => void;
  onTransportReconnectComplete?: (input: ConductorReconnectCompleteInfo) => void;
}

/** close → ConductorAgent.resume(sameId) で in-process の agent を差し替える。 */
export async function reconnectConductorAgent(
  handle: ConductorAgentHandle,
  options: ConductorReconnectOptions,
): Promise<string> {
  const agentId = handle.conductor.agentId;
  options.onReconnectAttempt?.({ agentId });
  let conductorOptions: ConductorAgentOptions;
  if ('conductorOptions' in options) {
    conductorOptions = options.conductorOptions;
  } else {
    const {
      onReconnectAttempt,
      onReconnectComplete,
      ...sdkOptions
    } = options;
    void onReconnectAttempt;
    void onReconnectComplete;
    conductorOptions = sdkOptions;
  }

  try {
    await handle.conductor.close();
    handle.conductor = await ConductorAgent.resume(agentId, conductorOptions);
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
 * send 経路の auth/transport error 時に同一 agentId で in-process 再接続し、prompt を再試行する。
 * close → resume(sameId) → retry（各 send につき 1 回）。resume に失敗した場合は元の
 * error 結果を返し、呼び出し元の continueOnConductorError 契約を維持する。
 */
export async function sendConductorWithReconnect(
  handle: ConductorAgentHandle,
  message: string,
  options: ConductorSendReconnectOptions & ConductorSendCallbacks,
): Promise<ConductorSendResult> {
  const sendCallbacks: ConductorSendCallbacks = {
    onToolCallStarted: options.onToolCallStarted,
  };
  const result = await handle.conductor.send(message, sendCallbacks);
  const reconnectReason = isConductorSendAuthError(result)
    ? 'auth'
    : isConductorSendTransportError(result)
      ? 'transport'
      : undefined;
  if (!reconnectReason) {
    return result;
  }

  try {
    await reconnectConductorAgent(handle, {
      conductorOptions: options.conductorOptions,
      onReconnectAttempt: resolveReconnectAttempt(options, reconnectReason),
      onReconnectComplete: resolveReconnectComplete(options, reconnectReason),
    });
  } catch {
    return result;
  }

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
