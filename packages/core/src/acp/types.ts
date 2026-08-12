/** ACP session / prompt types (minimal set for Stage 1). */

export interface AcpTextPromptBlock {
  type: 'text';
  text: string;
}

export type AcpPromptBlock = AcpTextPromptBlock;

export interface SessionUpdateNotification {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    content?: { type?: string; text?: string };
  };
}

export interface LlmUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface PromptResult {
  stopReason: string;
  /** session/update から集約した agent 応答テキスト。 */
  responseText?: string;
  /** ACP `session/prompt` 応答に含まれる場合のみ。 */
  usage?: LlmUsageSnapshot;
}

export interface PermissionDecision {
  outcome: {
    outcome: 'selected';
    optionId: string;
  };
}

export type PermissionHandler = (
  params: unknown,
) => PermissionDecision | Promise<PermissionDecision>;

export const DEFAULT_PERMISSION_DECISION: PermissionDecision = {
  outcome: { outcome: 'selected', optionId: 'allow-once' },
};
