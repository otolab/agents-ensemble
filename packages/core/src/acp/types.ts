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

export interface PromptResult {
  stopReason: string;
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
