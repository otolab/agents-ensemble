import type { SDKJsonValue } from '@cursor/sdk';
import yaml from 'js-yaml';

export function yamlToolResult(label: string, data: unknown) {
  const text = [
    '```yaml',
    `# ${label}`,
    yaml.dump(data, { lineWidth: 120 }).trimEnd(),
    '```',
  ].join('\n');

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: toStructuredContent(data),
  };
}

export function toStructuredContent(
  data: unknown,
): Record<string, SDKJsonValue> {
  return JSON.parse(JSON.stringify(data)) as Record<string, SDKJsonValue>;
}
