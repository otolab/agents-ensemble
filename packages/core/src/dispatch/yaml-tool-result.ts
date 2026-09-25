import yaml from 'js-yaml';
import type {
  ConductorJsonValue,
  ConductorToolResult,
} from '../conductor/conductor-tool.js';

export function yamlToolResult(
  label: string,
  data: unknown,
): ConductorToolResult {
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
): Record<string, ConductorJsonValue> {
  return JSON.parse(JSON.stringify(data)) as Record<string, ConductorJsonValue>;
}
