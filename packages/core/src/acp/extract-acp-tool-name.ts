import type { SessionUpdateNotification } from './types.js';

function readToolName(record: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'title', 'toolName'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** ACP `session/update` の payload から tool 名を best-effort で取り出す。 */
export function extractAcpToolName(
  update: SessionUpdateNotification['update'],
): string | undefined {
  if (!update) {
    return undefined;
  }

  if (typeof update.toolName === 'string' && update.toolName.length > 0) {
    return update.toolName;
  }

  for (const key of ['toolCall', 'tool_call'] as const) {
    const candidate = update[key];
    if (candidate && typeof candidate === 'object') {
      const name = readToolName(candidate as Record<string, unknown>);
      if (name) {
        return name;
      }
    }
  }

  return undefined;
}
