import type { PermissionRequest } from './permission-request.js';

export type PermissionOperationKind =
  | 'edit'
  | 'read'
  | 'shell'
  | 'delete'
  | 'move'
  | 'other';

export interface PermissionBriefOperation {
  kind: PermissionOperationKind;
  path?: string;
  line?: number;
  cmd?: string;
  cwd?: string;
  targetPath?: string;
  detail?: string;
}

/** Structured minimum context for a conductor permission decision. */
export interface PermissionBrief {
  toolCallId?: string;
  tool: string;
  operation: PermissionBriefOperation;
  missing: string[];
}

const PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'target_file',
  'filename',
  'sourcePath',
  'source_path',
  'from',
];
const TARGET_PATH_KEYS = [
  'targetPath',
  'target_path',
  'destination',
  'dest',
  'to',
];
const COMMAND_KEYS = ['command', 'cmd', 'commandLine', 'shellCommand', 'script'];
const DETAIL_KEYS = ['detail', 'description', 'title'];
const CWD_KEYS = ['cwd', 'workingDirectory', 'working_directory'];

/** The permission params remain the primary source; the snapshot fills gaps. */
export function buildPermissionBrief(
  request: PermissionRequest,
  toolCallSnapshot?: Record<string, unknown>,
): PermissionBrief {
  const raw = asRecord(request.raw) ?? {};
  const params = collectPermissionFields(raw);
  const snapshot = collectPermissionFields(toolCallSnapshot);
  const toolCallId =
    readToolCallId(raw) ??
    (toolCallSnapshot ? readToolCallId(toolCallSnapshot) : undefined);
  const acpKind =
    firstString(params.toolCalls, 'kind') ??
    firstString(snapshot.toolCalls, 'kind') ??
    firstString(snapshot.inputs, 'kind');
  const operationKind = normalizeOperationKind(request.toolName, acpKind);
  const canonicalTool = toolNameForKind(operationKind);
  const snapshotName =
    firstString(snapshot.toolCalls, 'toolName', 'name') ??
    firstString(snapshot.toolCalls, 'title') ??
    firstString(snapshot.inputs, 'toolName', 'name', 'title');
  const tool =
    !isUnknownToolName(request.toolName)
      ? request.toolName
      : canonicalTool ?? snapshotName ?? request.toolName;

  const path =
    firstString(params.inputs, ...PATH_KEYS) ??
    firstString(params.locations, ...PATH_KEYS) ??
    firstString(snapshot.inputs, ...PATH_KEYS) ??
    firstString(snapshot.locations, ...PATH_KEYS);
  const targetPath =
    firstString(params.inputs, ...TARGET_PATH_KEYS) ??
    firstString(snapshot.inputs, ...TARGET_PATH_KEYS);
  const line =
    firstNumber(params.inputs, 'line') ??
    firstNumber(params.locations, 'line') ??
    firstNumber(snapshot.inputs, 'line') ??
    firstNumber(snapshot.locations, 'line');
  const cmd =
    firstString(params.inputs, ...COMMAND_KEYS) ??
    firstString(snapshot.inputs, ...COMMAND_KEYS);
  const cwd =
    firstString(params.inputs, ...CWD_KEYS) ??
    firstString(snapshot.inputs, ...CWD_KEYS);
  const detail =
    firstString(params.inputs, ...DETAIL_KEYS) ??
    firstString(params.toolCalls, ...DETAIL_KEYS) ??
    firstString(snapshot.inputs, ...DETAIL_KEYS) ??
    firstString(snapshot.toolCalls, ...DETAIL_KEYS);

  const operation: PermissionBriefOperation = { kind: operationKind };
  if (path) operation.path = path;
  if (
    line !== undefined &&
    ['edit', 'read', 'delete', 'move'].includes(operationKind)
  ) {
    operation.line = line;
  }
  if (cmd && operationKind === 'shell') operation.cmd = cmd;
  if (cwd && operationKind === 'shell') operation.cwd = cwd;
  if (targetPath && operationKind === 'move') operation.targetPath = targetPath;
  if (detail && operationKind === 'other') operation.detail = detail;

  const missing: string[] = [];
  if (
    ['edit', 'read', 'delete', 'move'].includes(operationKind) &&
    !operation.path
  ) {
    missing.push('path');
  }
  if (operationKind === 'shell' && !operation.cmd) {
    missing.push('cmd');
  }
  if (operationKind === 'other' && !operation.detail) {
    missing.push('detail');
  }

  return {
    ...(toolCallId ? { toolCallId } : {}),
    tool,
    operation,
    missing,
  };
}

export function getPermissionToolCallId(
  request: PermissionRequest,
): string | undefined {
  return readToolCallId(asRecord(request.raw) ?? {});
}

function collectPermissionFields(
  raw: Record<string, unknown> | undefined,
): {
  inputs: Record<string, unknown>[];
  toolCalls: Record<string, unknown>[];
  locations: Record<string, unknown>[];
} {
  if (!raw) {
    return { inputs: [], toolCalls: [], locations: [] };
  }

  const subject = asRecord(raw.subject);
  const toolCalls = [
    asRecord(raw.toolCall),
    asRecord(raw.tool_call),
    asRecord(subject?.toolCall),
    asRecord(subject?.tool_call),
  ].filter((record): record is Record<string, unknown> => record !== undefined);
  const locations = [
    ...readLocations(raw.locations),
    ...readLocations(subject?.locations),
    ...toolCalls.flatMap((toolCall) => readLocations(toolCall.locations)),
  ];
  const inputValues = [
    ...toolCalls.flatMap((toolCall) => [
      toolCall.rawInput,
      toolCall.raw_input,
      toolCall.args,
      toolCall.input,
    ]),
    raw.rawInput,
    raw.raw_input,
    raw.input,
    raw.arguments,
    subject?.rawInput,
    subject?.raw_input,
    subject?.input,
    subject?.arguments,
    ...toolCalls,
    ...(subject ? [subject] : []),
    raw,
  ];
  const inputs = inputValues
    .map(asRecordOrJson)
    .filter((record): record is Record<string, unknown> => record !== undefined);
  return { inputs, toolCalls, locations };
}

function readToolCallId(record: Record<string, unknown>): string | undefined {
  const direct = readString(record, 'toolCallId', 'tool_call_id');
  if (direct) return direct;
  const subject = asRecord(record.subject);
  for (const candidate of [
    asRecord(record.toolCall),
    asRecord(record.tool_call),
    asRecord(subject?.toolCall),
    asRecord(subject?.tool_call),
  ]) {
    const value = candidate
      ? readString(candidate, 'toolCallId', 'tool_call_id')
      : undefined;
    if (value) return value;
  }
  return undefined;
}

function normalizeOperationKind(
  toolName: string,
  acpKind: string | undefined,
): PermissionOperationKind {
  const fromName = operationKindFor(toolName);
  if (fromName !== 'other') return fromName;
  return acpKind ? operationKindFor(acpKind) : 'other';
}

function operationKindFor(value: string): PermissionOperationKind {
  switch (value.trim().toLowerCase()) {
    case 'edit':
    case 'write':
      return 'edit';
    case 'read':
      return 'read';
    case 'shell':
    case 'bash':
    case 'execute':
      return 'shell';
    case 'delete':
      return 'delete';
    case 'move':
      return 'move';
    default:
      return 'other';
  }
}

function toolNameForKind(kind: PermissionOperationKind): string | undefined {
  switch (kind) {
    case 'edit':
      return 'Edit';
    case 'read':
      return 'Read';
    case 'shell':
      return 'Shell';
    case 'delete':
      return 'Delete';
    case 'move':
      return 'Move';
    case 'other':
      return undefined;
  }
}

function isUnknownToolName(toolName: string): boolean {
  return toolName.trim().toLowerCase() === 'unknown';
}

function readLocations(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== undefined);
}

function asRecordOrJson(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value !== 'string') return undefined;
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

function firstString(
  records: Record<string, unknown>[],
  ...keys: string[]
): string | undefined {
  for (const record of records) {
    const value = readString(record, ...keys);
    if (value) return value;
  }
  return undefined;
}

function firstNumber(
  records: Record<string, unknown>[],
  key: string,
): number | undefined {
  for (const record of records) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
