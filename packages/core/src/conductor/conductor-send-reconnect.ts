import {
  ConductorAgent,
  type ConductorAgentOptions,
  type ConductorSendResult,
} from './conductor-agent.js';
import {
  isConductorSendAuthError,
  loginConductor,
  logoutConductor,
} from './conductor-auth.js';

export type ConductorAuthReconnectPhase = 'resume' | 'reauth';

/** セッション中に `ConductorAgent` インスタンスを差し替え可能にする holder。 */
export interface ConductorAgentHandle {
  conductor: ConductorAgent;
}

export interface ConductorSendReconnectOptions {
  conductorOptions: ConductorAgentOptions;
  /** TTY 時のみ `logout → login → resume` フォールバックを試す。 */
  enableTtyReauth: boolean;
  onReconnectAttempt?: (input: {
    phase: ConductorAuthReconnectPhase;
    agentId: string;
  }) => void;
}

/**
 * send 経路の auth-like error 時に同一 agentId で in-process 再接続し、失敗 prompt を再試行する。
 * 方式 1: close → resume(sameId) → retry（1 回）
 * 方式 2（TTY のみ）: 方式 1 失敗後 logout → login → resume → retry（1 回）
 */
export async function sendConductorWithReconnect(
  handle: ConductorAgentHandle,
  message: string,
  options: ConductorSendReconnectOptions,
): Promise<ConductorSendResult> {
  let result = await handle.conductor.send(message);
  if (!isConductorSendAuthError(result)) {
    return result;
  }

  result = await reconnectConductorAndRetrySend(handle, message, options, 'resume');
  if (!isConductorSendAuthError(result) || !options.enableTtyReauth) {
    return result;
  }

  await logoutConductor();
  await loginConductor();
  return reconnectConductorAndRetrySend(handle, message, options, 'reauth');
}

async function reconnectConductorAndRetrySend(
  handle: ConductorAgentHandle,
  message: string,
  options: ConductorSendReconnectOptions,
  phase: ConductorAuthReconnectPhase,
): Promise<ConductorSendResult> {
  const agentId = handle.conductor.agentId;
  options.onReconnectAttempt?.({ phase, agentId });
  await handle.conductor.close();
  handle.conductor = await ConductorAgent.resume(agentId, options.conductorOptions);
  return handle.conductor.send(message);
}
