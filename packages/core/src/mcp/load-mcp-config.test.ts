import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadMcpConfig,
  MCP_CONFIG_FILE,
  PROJECT_MCP_CONFIG_DIR,
  resolveMcpServersForSdk,
} from './load-mcp-config.js';

describe('loadMcpConfig', () => {
  let repoRoot = '';
  let userEnsembleRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-mcp-repo-'));
    userEnsembleRoot = await mkdtemp(join(tmpdir(), 'ensemble-mcp-user-'));
  });

  afterEach(() => {
    repoRoot = '';
    userEnsembleRoot = '';
  });

  async function writeUserConfig(body: string): Promise<void> {
    await writeFile(join(userEnsembleRoot, MCP_CONFIG_FILE), body);
  }

  async function writeProjectConfig(body: string): Promise<void> {
    const projectMcpRoot = join(repoRoot, PROJECT_MCP_CONFIG_DIR);
    await mkdir(projectMcpRoot, { recursive: true });
    await writeFile(join(projectMcpRoot, MCP_CONFIG_FILE), body);
  }

  it('returns an empty mcpServers map when no config files exist', async () => {
    await expect(loadMcpConfig(repoRoot, { userEnsembleRoot })).resolves.toEqual({
      mcpServers: {},
    });
  });

  it('loads the user config from ~/.ensemble/mcp.json', async () => {
    await writeUserConfig(
      JSON.stringify({
        mcpServers: {
          userOnly: { type: 'stdio', command: 'user-server' },
        },
      }),
    );

    await expect(loadMcpConfig(repoRoot, { userEnsembleRoot })).resolves.toEqual({
      mcpServers: {
        userOnly: { type: 'stdio', command: 'user-server' },
      },
    });
  });

  it('merges user then project servers and project overrides by name', async () => {
    await writeUserConfig(
      JSON.stringify({
        mcpServers: {
          shared: { type: 'stdio', command: 'user-server' },
          userOnly: { type: 'stdio', command: 'user-only' },
        },
      }),
    );
    await writeProjectConfig(
      JSON.stringify({
        mcpServers: {
          shared: { type: 'stdio', command: 'project-server' },
          projectOnly: { url: 'https://example.test/mcp' },
        },
      }),
    );

    await expect(loadMcpConfig(repoRoot, { userEnsembleRoot })).resolves.toEqual({
      mcpServers: {
        shared: { type: 'stdio', command: 'project-server' },
        userOnly: { type: 'stdio', command: 'user-only' },
        projectOnly: { url: 'https://example.test/mcp' },
      },
    });
  });

  it('warns and skips invalid JSON without preventing the other layer from loading', async () => {
    const warn = vi.fn();
    await writeUserConfig('{"mcpServers":');
    await writeProjectConfig(
      JSON.stringify({
        mcpServers: {
          projectOnly: { type: 'stdio', command: 'project-server' },
        },
      }),
    );

    await expect(
      loadMcpConfig(repoRoot, { userEnsembleRoot, logger: { warn } }),
    ).resolves.toEqual({
      mcpServers: {
        projectOnly: { type: 'stdio', command: 'project-server' },
      },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('invalid JSON');
  });

  it('warns and skips a config with invalid server entries', async () => {
    const warn = vi.fn();
    await writeProjectConfig(
      JSON.stringify({
        mcpServers: {
          invalid: { type: 'stdio', command: 123 },
        },
      }),
    );

    await expect(
      loadMcpConfig(repoRoot, { userEnsembleRoot, logger: { warn } }),
    ).resolves.toEqual({ mcpServers: {} });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('valid server entries');
  });

  it('returns the merged map for SDK inline options', async () => {
    await writeProjectConfig(
      JSON.stringify({
        mcpServers: {
          projectOnly: { type: 'stdio', command: 'project-server' },
        },
      }),
    );

    await expect(
      resolveMcpServersForSdk(repoRoot, { userEnsembleRoot }),
    ).resolves.toEqual({
      projectOnly: { type: 'stdio', command: 'project-server' },
    });
  });
});
