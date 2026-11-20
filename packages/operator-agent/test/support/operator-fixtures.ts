import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ConductorAgent } from '@agents-ensemble/core/operator-runtime';
import type { OperatorAgentOutput } from '../../src/run-operator-agent.js';

export function createOutput(
  isTTY = true,
): OperatorAgentOutput & { capturedText: () => string } {
  const output = new PassThrough() as PassThrough &
    OperatorAgentOutput & { capturedText: () => string };
  const chunks: string[] = [];
  output.on('data', (chunk) => chunks.push(String(chunk)));
  output.capturedText = () => chunks.join('');
  output.isTTY = isTTY;
  output.columns = 80;
  output.rows = 24;
  return output;
}

export function createFakeAgent(overrides: {
  send: ConductorAgent['send'];
}): ConductorAgent {
  return {
    agentId: 'operator-agent-id',
    send: overrides.send,
    reload: async () => {},
    getUsage: async () => ({}),
    setSystemPrompt: async () => {},
    close: async () => {},
  };
}

export async function writeOperatorSettings(
  repoRoot: string,
  backend: 'pi' | 'cursor',
  reasoning?: string,
  mcp?: { common?: string[]; profile?: string[] },
): Promise<void> {
  const model = backend === 'pi' ? 'smoke-model' : 'cursor-model';
  await writeFile(
    join(repoRoot, '.ensemble', 'operator-agents.config.yaml'),
    [
      'version: 1',
      'defaultProfile: smoke',
      'common:',
      '  conductor:',
      `    backend: ${backend}`,
      `    model: ${model}`,
      ...(reasoning ? [`    reasoning: ${reasoning}`] : []),
      '  pi:',
      '    agentDir: pi-user',
      ...(mcp?.common !== undefined
        ? [
            '  mcp:',
            ...(mcp.common.length > 0
              ? [
                  '    servers:',
                  ...mcp.common.map((name) => `      - ${JSON.stringify(name)}`),
                ]
              : ['    servers: []']),
          ]
        : []),
      'profiles:',
      '  smoke:',
      '    prompt:',
      '      instructions:',
      '        - Profile operator guidance.',
      '    pi:',
      '      projectDir: pi-project',
      ...(mcp?.profile !== undefined
        ? [
            '    mcp:',
            ...(mcp.profile.length > 0
              ? [
                  '      servers:',
                  ...mcp.profile.map((name) => `        - ${JSON.stringify(name)}`),
                ]
              : ['      servers: []']),
          ]
        : []),
      '',
    ].join('\n'),
  );
}
