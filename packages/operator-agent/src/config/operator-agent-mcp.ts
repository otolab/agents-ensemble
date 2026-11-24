import { join } from 'node:path';
import {
  MCP_CONFIG_FILE,
  resolveUserMcpServers,
  type McpServerConfigMap,
} from '@agents-ensemble/core/operator-runtime';
import type {
  OperatorAgentConfiguration,
  OperatorAgentMcpConfig,
} from './operator-agent-config.js';

export function selectOperatorAgentMcpServerNames(
  profile: OperatorAgentMcpConfig | undefined,
  common: OperatorAgentMcpConfig | undefined,
): string[] {
  return profile?.servers ?? common?.servers ?? [];
}

export async function resolveOperatorAgentMcpServers(
  userEnsembleRoot: string,
  profileName: string,
  profile: OperatorAgentConfiguration['profiles'][string],
  common: OperatorAgentConfiguration['common'],
): Promise<McpServerConfigMap | undefined> {
  const names = selectOperatorAgentMcpServerNames(profile.mcp, common.mcp);
  if (names.length === 0) return undefined;

  const configured = await resolveUserMcpServers({ userEnsembleRoot });
  const missing = names.filter((name) => !Object.hasOwn(configured, name));
  if (missing.length > 0) {
    throw new Error(
      `Operator-agent profile "${profileName}" selects MCP server(s) ${missing.map((name) => `"${name}"`).join(', ')}, ` +
        `but they are not defined in ${join(userEnsembleRoot, MCP_CONFIG_FILE)}.`,
    );
  }

  return Object.fromEntries(
    names.map((name) => [name, configured[name]!]),
  );
}
