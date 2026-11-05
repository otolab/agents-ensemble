import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnAcpProcess } from '../../src/acp/acp-process.js';
import { loadEnsembleConfig } from '../../src/config/load-ensemble-config.js';
import { profileWorkersToSessionSpecs } from '../../src/profile/types.js';

const require = createRequire(import.meta.url);

function findCodexAdapter(): { adapter: string; codex: string } | undefined {
  try {
    const adapter = require.resolve('@agentclientprotocol/codex-acp');
    const codexPackage = createRequire(adapter).resolve('@openai/codex/package.json');
    return { adapter, codex: join(dirname(codexPackage), 'bin', 'codex.js') };
  } catch (error) {
    // The adapter is an optional dependency and can be absent on unsupported platforms.
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

const codexAdapter = findCodexAdapter();
const suiteName = codexAdapter
  ? 'Codex model reasoning integration'
  : 'Codex model reasoning integration (optional codex-acp dependency unavailable)';

type SessionResult = {
  sessionId: string;
  models: { currentModelId: string };
};

describe.skipIf(!codexAdapter)(suiteName, () => {
  let tempRoot = '';

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('applies a merged catalog entry to the real adapter on new and load', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-codex-reasoning-'));
    const repoRoot = join(tempRoot, 'repo');
    const userRoot = join(tempRoot, 'user');
    const codexRoot = join(tempRoot, 'codex');
    await Promise.all([
      mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
      mkdir(userRoot),
      mkdir(codexRoot),
    ]);
    await writeFile(join(codexRoot, 'config.toml'), [
      'model_provider = "offline"',
      '[model_providers.offline]',
      'name = "Offline test"',
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      '',
    ].join('\n'));
    await writeFile(join(userRoot, 'config.yaml'), [
      'acp:',
      '  defaultPreset: codex',
      '  env:',
      `    CODEX_CONFIG: '{"approval_policy":"on-request","model_reasoning_effort":"low"}'`,
      '  models:',
      '    shared: gpt-6.1-sol',
      '  tags:',
      '    high: shared',
      '',
    ].join('\n'));
    await writeFile(
      join(repoRoot, '.ensemble', 'config.yaml'),
      'acp:\n  models:\n    shared:\n      reasoning: high\n',
    );

    // Use an isolated, dummy login and an unreachable local provider. No user's
    // credentials or model requests are needed to create and load a session.
    const isolatedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: tempRoot,
      CODEX_HOME: codexRoot,
      CODEX_PATH: codexAdapter!.codex,
      MODEL_PROVIDER: 'offline',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const login = spawnSync(
      process.execPath,
      [
        codexAdapter!.codex,
        'login',
        '--with-api-key',
        '-c',
        'cli_auth_credentials_store="file"',
      ],
      { cwd: repoRoot, env: isolatedEnv, input: 'offline-test-key\n', encoding: 'utf8' },
    );
    expect(login.status, login.stderr).toBe(0);

    const config = await loadEnsembleConfig(repoRoot, {
      userEnsembleRoot: userRoot,
      writeStderr: () => {},
    });
    const [worker] = profileWorkersToSessionSpecs(
      { workers: [{ name: 'implementer', kind: 'implementer', modelTag: 'high' }] },
      { defaultAcp: { config, env: isolatedEnv }, spawnBase: { env: isolatedEnv } },
    );
    const client = await spawnAcpProcess({
      ...worker!.spawn,
      cwd: repoRoot,
      command: process.execPath,
      args: [codexAdapter!.adapter],
    });
    try {
      await client.connect();
      const created = await client.peer.request('session/new', {
        cwd: repoRoot,
        mcpServers: [],
      }) as SessionResult;
      expect(created.models.currentModelId).toBe('gpt-6.1-sol[high]');

      // Before a first prompt Codex keeps the thread in the current process.
      const loaded = await client.peer.request('session/load', {
        cwd: repoRoot,
        sessionId: created.sessionId,
        mcpServers: [],
      }) as SessionResult;
      expect(loaded.models.currentModelId).toBe('gpt-6.1-sol[high]');
    } finally {
      await client.close();
    }
  });
});
