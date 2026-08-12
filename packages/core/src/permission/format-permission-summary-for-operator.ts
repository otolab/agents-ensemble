import type { PendingPermission } from './pending-permission.js';
import type { PermissionRequest } from './permission-request.js';

const MAX_SUMMARY_VALUE_LENGTH = 120;

export interface FormatPermissionSummaryForOperatorOptions {
  /** worker kind など、オペレータ向けの短い worker ラベル。未指定時は pending.workerId を使う。 */
  workerLabel?: string;
}

/** permission 保留 1 件のオペレータ向け 1 行要約（prefix なし）。 */
export function formatPermissionSummaryForOperator(
  pending: PendingPermission,
  options: FormatPermissionSummaryForOperatorOptions = {},
): string {
  const worker = options.workerLabel ?? pending.workerId;
  const tool = pending.request.toolName;
  const parts = [
    'permission.pending',
    `worker=${formatLogValue(worker)}`,
    `tool=${formatLogValue(tool)}`,
  ];

  const operation = extractPermissionOperationSummary(pending.request);
  if (operation) {
    parts.push(`${operation.field}=${formatLogValue(operation.value)}`);
  }

  parts.push(`id=${formatLogValue(shortPermissionId(pending.id))}`);
  return parts.join(' ');
}

export interface PermissionOperationSummary {
  field: string;
  value: string;
}

/** ツール名に応じて raw から操作概要を抜き出す。 */
export function extractPermissionOperationSummary(
  request: PermissionRequest,
): PermissionOperationSummary | undefined {
  const raw = asRecord(request.raw) ?? {};
  const toolCall = asRecord(raw.toolCall) ?? asRecord(raw.tool_call);
  const toolCallArgs = toolCall ? asRecord(toolCall.args) : undefined;
  const input =
    asRecord(raw.input) ??
    asRecord(raw.arguments) ??
    toolCallArgs ??
    raw;
  const tool = request.toolName.trim().toLowerCase();

  if (tool === 'shell' || tool === 'bash') {
    const command =
      readString(input, 'command', 'cmd') ??
      readString(raw, 'command', 'cmd') ??
      readString(input, 'description', 'working_directory') ??
      readString(raw, 'description');
    if (command) {
      return { field: 'cmd', value: sanitizeSummaryValue(command) };
    }
  }

  if (tool === 'write' || tool === 'delete' || tool === 'read' || tool === 'edit') {
    const path =
      readString(input, 'path', 'file_path', 'filePath', 'target_file') ??
      readString(raw, 'path', 'file_path', 'filePath', 'target_file');
    if (path) {
      return { field: 'path', value: sanitizeSummaryValue(path) };
    }
  }

  const fallback = sanitizeSummaryValue(safeShortenRaw(request.raw));
  if (fallback) {
    return { field: 'detail', value: fallback };
  }

  return undefined;
}

function shortPermissionId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}...`;
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

function sanitizeSummaryValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_VALUE_LENGTH);
}

function safeShortenRaw(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return '';
  }

  try {
    return sanitizeSummaryValue(JSON.stringify(raw));
  } catch {
    return sanitizeSummaryValue(String(raw));
  }
}

function formatLogValue(value: string): string {
  if (/^[A-Za-z0-9._:/+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
