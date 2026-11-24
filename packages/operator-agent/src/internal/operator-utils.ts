import type { ConductorJsonValue } from '@agents-ensemble/core/operator-runtime';

export const ANSI_RED = '\u001b[31m';

export function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function isEnoentError(error: unknown): boolean {
  return error instanceof Error && isEnoent(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function objectToolResult(value: Record<string, ConductorJsonValue>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export function jsonToolResult(value: ConductorJsonValue): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, ConductorJsonValue>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent:
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : { value },
  };
}
