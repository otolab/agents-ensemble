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

export interface ConductorSendReconnectOptions {
  conductorOptions: ConductorAgentOptions;
  onReconnectAttempt?: (input: { agentId: string }) => void;
}

/**
 * send 経路の auth-like error 時に同一 agentId で in-process 再接続し、失敗 prompt を再試行する。
 * close → resume(sameId) → retry（1 回）。まだ失敗なら呼び出し元が [auth] ヒントへフォールバックする。
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
  if (!isConductorSendAuthError(result)) {
    return result;
  }

  const agentId = handle.conductor.agentId;
  options.onReconnectAttempt?.({ agentId });
  await handle.conductor.close();
  handle.conductor = await ConductorAgent.resume(agentId, options.conductorOptions);
  return handle.conductor.send(message, sendCallbacks);
}
