import type { ToolCall } from '@cursor/sdk';
import { formatConductorToolName } from '../conductor/conductor-tool-name.js';

/** Parsed `session/request_permission` params from ACP. */
export interface PermissionOption {
  /** Backend-defined identifier returned in the ACP response. */
  optionId: string;
  /** ACP semantic kind (for example `allow_once` or `reject_once`). */
  kind: string;
  name?: string;
}

export interface PermissionRequest {
  sessionId?: string;
  toolName: string;
  /** Options advertised by the ACP backend, when they are well-formed. */
  options?: PermissionOption[];
  raw: unknown;
}

export function parsePermissionRequest(params: unknown): PermissionRequest {
  const record =
    params && typeof params === 'object'
      ? (params as Record<string, unknown>)
      : {};

  const toolCallRecord = readToolCallPayload(record);
  const toolCall = readToolCallRecord(record);
  const toolFromCall = toolCall ? formatConductorToolName(toolCall) : undefined;

  const explicitTool =
    readNonEmptyString(record.toolName) ?? readNonEmptyString(record.tool_name);

  const inferredTool =
    inferAcpToolName(toolCallRecord) ??
    inferToolNameFromToolCallId(
      readNonEmptyString(toolCallRecord?.toolCallId) ??
        readNonEmptyString(toolCallRecord?.tool_call_id) ??
        readNonEmptyString(record.toolCallId) ??
        readNonEmptyString(record.tool_call_id),
    ) ??
    inferToolNameFromInput(record, toolCallRecord);

  const toolName =
    (explicitTool && !isUnknownToolName(explicitTool) ? explicitTool : undefined) ??
    toolFromCall ??
    inferredTool ??
    explicitTool ??
    'unknown';
  const options = parsePermissionOptions(record.options);

  return {
    sessionId:
      typeof record.sessionId === 'string'
        ? record.sessionId
        : typeof record.session_id === 'string'
          ? record.session_id
          : undefined,
    toolName,
    ...(options ? { options } : {}),
    raw: params,
  };
}

function parsePermissionOptions(value: unknown): PermissionOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const options = value.flatMap((candidate): PermissionOption[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return [];
    }

    const option = candidate as Record<string, unknown>;
    const optionId = readNonEmptyString(option.optionId);
    const kind = readNonEmptyString(option.kind);
    if (!optionId || !kind) {
      return [];
    }

    const name = readNonEmptyString(option.name);
    return [{ optionId, kind, ...(name ? { name } : {}) }];
  });

  return options.length > 0 ? options : undefined;
}

function readToolCallRecord(
  record: Record<string, unknown>,
): ToolCall | undefined {
  const candidate = readToolCallPayload(record);
  if (!candidate) {
    return undefined;
  }

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

function readToolCallPayload(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const toolCall = record.toolCall ?? record.tool_call;
  return asRecordOrJson(toolCall);
}

function inferAcpToolName(
  toolCall: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolCall) {
    return undefined;
  }

  const explicitName =
    readNonEmptyString(toolCall.toolName) ?? readNonEmptyString(toolCall.name);
  if (explicitName && !isUnknownToolName(explicitName)) {
    return explicitName;
  }

  const kind = readNonEmptyString(toolCall.kind)?.toLowerCase();
  if (kind) {
    const nameByKind: Record<string, string> = {
      execute: 'Shell',
      read: 'Read',
      edit: 'Edit',
      delete: 'Delete',
      move: 'Move',
      search: 'Search',
      fetch: 'Fetch',
      think: 'Think',
    };
    const name = nameByKind[kind];
    if (name) {
      return name;
    }
  }

  return undefined;
}

function inferToolNameFromToolCallId(toolCallId: string | undefined): string | undefined {
  if (!toolCallId) {
    return undefined;
  }

  const prefix = toolCallId.split('-', 1)[0]?.toLowerCase();
  const nameByPrefix: Record<string, string> = {
    exec: 'Shell',
    shell: 'Shell',
    bash: 'Shell',
    write: 'Write',
    edit: 'Edit',
    delete: 'Delete',
    read: 'Read',
  };
  return prefix ? nameByPrefix[prefix] : undefined;
}

function inferToolNameFromInput(
  record: Record<string, unknown>,
  toolCall: Record<string, unknown> | undefined,
): string | undefined {
  const candidates = [
    record.input,
    record.arguments,
    record.rawInput,
    record.raw_input,
    toolCall?.args,
    toolCall?.rawInput,
    toolCall?.raw_input,
  ];

  for (const candidate of candidates) {
    const input = asRecordOrJson(candidate);
    if (!input) {
      continue;
    }

    if (readString(input, 'command', 'cmd', 'commandLine', 'shellCommand')) {
      return 'Shell';
    }

    const provider = readNonEmptyString(
      input.providerIdentifier ?? input.provider_id ?? input.provider,
    );
    const tool = readNonEmptyString(input.toolName ?? input.tool_name);
    if (provider && tool) {
      return `mcp:${provider}/${tool}`;
    }
  }

  return undefined;
}

function asRecordOrJson(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record) {
    return record;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function isUnknownToolName(value: string): boolean {
  return value.trim().toLowerCase() === 'unknown';
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return value.trim();
}
