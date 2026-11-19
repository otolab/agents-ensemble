import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeMcpConfigDigest,
  loadMcpConfig,
  MCP_CONFIG_FILE,
  PROJECT_MCP_CONFIG_DIR,
  resolveMcpServerConfigMapPlaceholders,
  resolveMcpServers,
  resolveConductorMcpServers,
  resolveMcpServersForSdk,
  resolveUserMcpServers,
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

  it('selects only named definitions and reports missing names with both paths', async () => {
    await writeUserConfig(JSON.stringify({ mcpServers: {
      chosen: { command: 'user' }, unused: { command: 'unused' },
    } }));
    await writeProjectConfig(JSON.stringify({ mcpServers: { chosen: { command: 'project' } } }));
    const options = { userEnsembleRoot };
    await expect(resolveConductorMcpServers(repoRoot, [], options)).resolves.toEqual({});
    const selected = await resolveConductorMcpServers(repoRoot, ['chosen'], options);
    expect(selected).toEqual({ chosen: { command: 'project' } });
    expect(computeMcpConfigDigest(selected)).toBe(computeMcpConfigDigest({ chosen: { command: 'project' } }));
    await expect(resolveConductorMcpServers(repoRoot, ['missing'], options)).rejects.toThrow(
      `MCP server "missing" is not defined in ${join(userEnsembleRoot, 'mcp.json')} or ${join(repoRoot, '.agents', 'mcp.json')}`,
    );
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

  it('resolves only user servers without requiring or reading a project root', async () => {
    await writeUserConfig(
      JSON.stringify({
        mcpServers: {
          selected: { type: 'stdio', command: 'user-server' },
        },
      }),
    );
    await writeProjectConfig(
      JSON.stringify({
        mcpServers: {
          projectOnly: { type: 'stdio', command: 'project-server' },
        },
      }),
    );

    await expect(resolveUserMcpServers({ userEnsembleRoot })).resolves.toEqual({
      selected: { type: 'stdio', command: 'user-server' },
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

  it('returns the merged map for all conductor backends', async () => {
    await writeProjectConfig(
      JSON.stringify({
        mcpServers: {
          projectOnly: { type: 'stdio', command: 'project-server' },
        },
      }),
    );

    await expect(
      resolveMcpServers(repoRoot, { userEnsembleRoot }),
    ).resolves.toEqual({
      projectOnly: { type: 'stdio', command: 'project-server' },
    });
  });

  it('keeps the SDK resolver name as a compatibility alias', async () => {
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

  it('computes a stable digest without persisting MCP values', () => {
    const first = computeMcpConfigDigest({
      server: {
        type: 'stdio',
        command: 'server',
        env: { TOKEN: 'secret-token' },
        args: ['--one', '--two'],
      },
    });
    const reordered = computeMcpConfigDigest({
      server: {
        args: ['--one', '--two'],
        env: { TOKEN: 'secret-token' },
        command: 'server',
        type: 'stdio',
      },
    });
    const changed = computeMcpConfigDigest({
      server: { type: 'stdio', command: 'other-server' },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
    expect(first).not.toContain('secret-token');
  });

  it('resolves selected MCP placeholders against the supplied workspace and environment', () => {
    const servers = resolveMcpServerConfigMapPlaceholders(
      {
        selected: {
          type: 'http',
          url: 'https://mcp.example.test/${workspaceFolderBasename}',
          headers: { Authorization: 'Bearer ${env:MCP_TOKEN}' },
          auth: {
            CLIENT_ID: '${env:CLIENT_ID}',
            CLIENT_SECRET: '${env:CLIENT_SECRET}',
            scopes: ['${env:MCP_SCOPE}'],
          },
        },
        stdio: {
          type: 'stdio',
          command: '${workspaceFolder}/bin/server',
          args: ['--root', '${workspaceFolder}', '--token', '${env:MCP_TOKEN}'],
          cwd: '${workspaceFolder}/server',
          env: { MCP_TOKEN: '${env:MCP_TOKEN}' },
        },
      },
      {
        cwd: '/operator/workspace',
        env: {
          MCP_TOKEN: 'secret-token',
          CLIENT_ID: 'client-id',
          CLIENT_SECRET: 'client-secret',
          MCP_SCOPE: 'read',
        },
      },
    );

    expect(servers).toEqual({
      selected: {
        type: 'http',
        url: 'https://mcp.example.test/workspace',
        headers: { Authorization: 'Bearer secret-token' },
        auth: {
          CLIENT_ID: 'client-id',
          CLIENT_SECRET: 'client-secret',
          scopes: ['read'],
        },
      },
      stdio: {
        type: 'stdio',
        command: '/operator/workspace/bin/server',
        args: [
          '--root',
          '/operator/workspace',
          '--token',
          'secret-token',
        ],
        cwd: '/operator/workspace/server',
        env: { MCP_TOKEN: 'secret-token' },
      },
    });
    expect(JSON.stringify(servers)).not.toContain('${env:');
    expect(JSON.stringify(servers)).not.toContain('${workspaceFolder');
  });

  it('reports a missing environment placeholder with its server and field', () => {
    expect(() =>
      resolveMcpServerConfigMapPlaceholders(
        {
          github: {
            type: 'stdio',
            command: 'docker',
            env: { GITHUB_TOKEN: '${env:MISSING_GITHUB_TOKEN}' },
          },
        },
        { cwd: '/workspace', env: {} },
      ),
    ).toThrow(
      'MCP server "github" references missing environment variable "MISSING_GITHUB_TOKEN" in env.GITHUB_TOKEN.',
    );
  });
});
