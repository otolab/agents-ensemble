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

  const toolName = String(record.toolName ?? record.tool_name ?? 'unknown');

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
