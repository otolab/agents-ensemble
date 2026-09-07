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

/** ACP payload の構造化フィールドから、ツールに依存しない操作概要を抜き出す。 */
export function extractPermissionOperationSummary(
  request: PermissionRequest,
): PermissionOperationSummary | undefined {
  const raw = asRecord(request.raw) ?? {};
  const toolCall =
    asRecordOrJson(raw.toolCall) ?? asRecordOrJson(raw.tool_call);
  const inputs = [
    asRecordOrJson(raw.input),
    asRecordOrJson(raw.arguments),
    asRecordOrJson(raw.rawInput),
    asRecordOrJson(raw.raw_input),
    asRecordOrJson(toolCall?.args),
    asRecordOrJson(toolCall?.rawInput),
    asRecordOrJson(toolCall?.raw_input),
    raw,
  ].filter((input): input is Record<string, unknown> => input !== undefined);

  const command = inputs
    .map((input) =>
      readString(input, 'command', 'cmd', 'commandLine', 'shellCommand', 'script'),
    )
    .find((value): value is string => value !== undefined);
  if (command) {
    return { field: 'cmd', value: sanitizeSummaryValue(command) };
  }

  const tool = request.toolName.trim().toLowerCase();
  if (tool === 'shell' || tool === 'bash') {
    const description = inputs
      .map((input) => readString(input, 'description', 'working_directory'))
      .find((value): value is string => value !== undefined);
    if (description) {
      return { field: 'cmd', value: sanitizeSummaryValue(description) };
    }

    const rawInputText = readString(toolCall, 'rawInput', 'raw_input');
    if (rawInputText && !asRecordOrJson(rawInputText)) {
      return { field: 'cmd', value: sanitizeSummaryValue(rawInputText) };
    }
  }

  const path = inputs
    .map((input) =>
      readString(input, 'path', 'file_path', 'filePath', 'target_file', 'filename'),
    )
    .find((value): value is string => value !== undefined);
  if (path) {
    return { field: 'path', value: sanitizeSummaryValue(path) };
  }

  const locationPath = readLocationPath(raw, toolCall);
  if (locationPath) {
    return { field: 'path', value: sanitizeSummaryValue(locationPath) };
  }

  const toolCallId =
    readString(toolCall, 'toolCallId', 'tool_call_id') ??
    readString(raw, 'toolCallId', 'tool_call_id');
  if (toolCallId) {
    return { field: 'toolCallId', value: sanitizeSummaryValue(toolCallId) };
  }

  const title = readString(toolCall, 'title', 'description');
  if (title) {
    return { field: 'detail', value: sanitizeSummaryValue(title) };
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

function readLocationPath(
  raw: Record<string, unknown>,
  toolCall: Record<string, unknown> | undefined,
): string | undefined {
  for (const candidate of [raw.locations, toolCall?.locations]) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    for (const location of candidate) {
      const record = asRecord(location);
      const path = readString(record, 'path', 'file_path', 'filePath', 'uri');
      if (path) {
        return path;
      }
    }
  }

  return undefined;
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
