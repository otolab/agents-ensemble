import type { ToolCall } from '@cursor/sdk';
import { formatConductorToolName } from '../conductor/conductor-tool-name.js';

/** Parsed `session/request_permission` params from ACP. */
export interface PermissionRequest {
  sessionId?: string;
  toolName: string;
  raw: unknown;
}

export function parsePermissionRequest(params: unknown): PermissionRequest {
  const record =
    params && typeof params === 'object'
      ? (params as Record<string, unknown>)
      : {};

  const toolCall = readToolCallRecord(record);
  const toolFromCall = toolCall ? formatConductorToolName(toolCall) : undefined;

  const explicitTool =
    readNonEmptyString(record.toolName) ?? readNonEmptyString(record.tool_name);

  const toolName = explicitTool ?? toolFromCall ?? 'unknown';

  return {
    sessionId:
      typeof record.sessionId === 'string'
        ? record.sessionId
        : typeof record.session_id === 'string'
          ? record.session_id
          : undefined,
    toolName,
    raw: params,
  };
}

function readToolCallRecord(
  record: Record<string, unknown>,
): ToolCall | undefined {
  const toolCall = record.toolCall ?? record.tool_call;
  if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
    return undefined;
  }

  const candidate = toolCall as Record<string, unknown>;
  const type = readNonEmptyString(candidate.type);
  if (!type) {
    return undefined;
  }

  const args =
    candidate.args && typeof candidate.args === 'object' && !Array.isArray(candidate.args)
      ? (candidate.args as Record<string, unknown>)
      : {};

  return { type, args } as ToolCall;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return value.trim();
}
