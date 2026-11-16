import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_CONFIG_FILE } from '@agents-ensemble/core/operator-runtime';
import {
  type OperatorAgentConfiguration,
} from './operator-agent-config.js';
import { resolveOperatorAgentMcpServers } from './operator-agent-mcp.js';

describe('operator-agent MCP selection', () => {
  let userRoot = '';

  afterEach(async () => {
    if (userRoot) await rm(userRoot, { recursive: true, force: true });
    userRoot = '';
  });

  it('uses the profile selection as a replacement and reads no project MCP config', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-mcp-'));
    await writeFile(
      join(userRoot, MCP_CONFIG_FILE),
      JSON.stringify({
        mcpServers: {
          common: { type: 'stdio', command: 'common-server' },
          github: { type: 'stdio', command: 'github-server' },
          unselected: { type: 'stdio', command: 'unselected-server' },
        },
      }),
    );
    const launchRoot = await mkdtemp(join(tmpdir(), 'ensemble-mcp-launch-'));
    await mkdir(join(launchRoot, '.agents'), { recursive: true });
    await writeFile(
      join(launchRoot, '.agents', MCP_CONFIG_FILE),
      JSON.stringify({
        mcpServers: {
          project: { type: 'stdio', command: 'project-server' },
        },
      }),
    );

    const originalCwd = process.cwd();
    process.chdir(launchRoot);
    try {
      await expect(
        resolveOperatorAgentMcpServers(
          userRoot,
          'work',
          { mcp: { servers: ['github'] } },
          { mcp: { servers: ['common'] } },
        ),
      ).resolves.toEqual({
        github: { type: 'stdio', command: 'github-server' },
      });
    } finally {
      process.chdir(originalCwd);
      await rm(launchRoot, { recursive: true, force: true });
    }
  });

  it('uses common selection when profile selection is omitted, and an empty profile list disables it', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-mcp-'));
    await writeFile(
      join(userRoot, MCP_CONFIG_FILE),
      JSON.stringify({
        mcpServers: {
          shared: { type: 'stdio', command: 'shared-server' },
        },
      }),
    );

    const common: OperatorAgentConfiguration['common'] = {
      mcp: { servers: ['shared'] },
    };
    await expect(
      resolveOperatorAgentMcpServers(userRoot, 'work', {}, common),
    ).resolves.toEqual({
      shared: { type: 'stdio', command: 'shared-server' },
    });
    await expect(
      resolveOperatorAgentMcpServers(
        userRoot,
        'work',
        { mcp: { servers: [] } },
        common,
      ),
    ).resolves.toBeUndefined();
  });

  it('does not read the user MCP file when no servers are selected', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-mcp-empty-'));
    await writeFile(join(userRoot, MCP_CONFIG_FILE), 'not-json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        resolveOperatorAgentMcpServers(userRoot, 'work', {}, {}),
      ).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reports every selected name that has no user MCP definition', async () => {
    userRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-mcp-'));

    await expect(
      resolveOperatorAgentMcpServers(
        userRoot,
        'work',
        { mcp: { servers: ['missing'] } },
        {},
      ),
    ).rejects.toThrow(
      `Operator-agent profile "work" selects MCP server(s) "missing", but they are not defined in ${join(userRoot, MCP_CONFIG_FILE)}.`,
    );
  });
});
