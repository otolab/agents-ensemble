import { once } from 'node:events';
import { createServer } from 'node:http';
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

const LOCAL_USAGE = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 5 },
  output_tokens: 9,
  output_tokens_details: { reasoning_tokens: 3 },
  total_tokens: 49,
};

async function startLocalResponsesProvider(
  outputItemForRequest: (requestNumber: number) => Record<string, unknown>,
): Promise<{
  baseUrl: string;
  requestCount: () => number;
  close: () => Promise<void>;
}> {
  let requestNumber = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-6.1-sol', object: 'model', created: 0, owned_by: 'local-test' }],
        }));
        return;
      }
      if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
        response.writeHead(404);
        response.end();
        return;
      }

      for await (const _chunk of request) {
        // Consume the request body. It is intentionally kept on loopback.
      }
      requestNumber += 1;
      const responseId = `local-response-${requestNumber}`;
      const events = [
        { type: 'response.created', response: { id: responseId } },
        { type: 'response.output_item.done', item: outputItemForRequest(requestNumber) },
        {
          type: 'response.completed',
          response: { id: responseId, status: 'completed', usage: LOCAL_USAGE },
        },
      ];
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const event of events) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Local Responses fixture did not bind a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requestNumber,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function prepareLocalCodexEnvironment(
  tempRoot: string,
  baseUrl: string,
  initialMode: string,
): Promise<{ repoRoot: string; env: NodeJS.ProcessEnv }> {
  const repoRoot = join(tempRoot, 'repo');
  const codexRoot = join(tempRoot, 'codex');
  await Promise.all([
    mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
    mkdir(codexRoot, { recursive: true }),
  ]);
  await writeFile(join(codexRoot, 'config.toml'), [
    'model = "gpt-6.1-sol"',
    'model_provider = "offline"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '[model_providers.offline]',
    'name = "Offline integration test"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n'));

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: tempRoot,
    CODEX_HOME: codexRoot,
    CODEX_PATH: codexAdapter!.codex,
    CODEX_CONFIG: JSON.stringify({
      approval_policy: 'on-request',
      model_reasoning_effort: 'low',
    }),
    INITIAL_AGENT_MODE: initialMode,
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
    { cwd: repoRoot, env, input: 'offline-test-key\n', encoding: 'utf8' },
  );
  if (login.status !== 0) {
    throw new Error(`Codex isolated dummy login failed: ${login.stderr}`);
  }
  return { repoRoot, env };
}

function spawnLocalCodexAdapter(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
) {
  return spawnAcpProcess({
    cwd: repoRoot,
    command: process.execPath,
    args: [codexAdapter!.adapter],
    env,
    authenticate: { kind: 'skip' },
  });
}

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

  it(
    'reports usage from a local Responses provider and resumes after restarting the adapter process',
    async () => {
      tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-codex-local-resume-'));
      const provider = await startLocalResponsesProvider((requestNumber) => ({
        type: 'message',
        role: 'assistant',
        id: `local-message-${requestNumber}`,
        status: 'completed',
        content: [{ type: 'output_text', text: `local answer ${requestNumber}` }],
      }));
      let client: Awaited<ReturnType<typeof spawnLocalCodexAdapter>> | undefined;
      try {
        const { repoRoot, env } = await prepareLocalCodexEnvironment(
          tempRoot,
          provider.baseUrl,
          'agent',
        );
        client = await spawnLocalCodexAdapter(repoRoot, env);
        await client.connect();
        const sessionId = await client.newSession(repoRoot);
        const firstPid = client.childProcess?.pid;
        const firstPrompt = await client.prompt(sessionId, 'first local test turn');
        expect(firstPrompt.stopReason).toBe('end_turn');
        expect(firstPrompt.usage).toMatchObject({
          inputTokens: 35,
          outputTokens: 9,
          totalTokens: 49,
          reasoningTokens: 3,
          cacheReadTokens: 5,
        });
        expect(provider.requestCount()).toBeGreaterThan(0);

        await client.close();
        client = await spawnLocalCodexAdapter(repoRoot, env);
        expect(client.childProcess?.pid).not.toBe(firstPid);
        await client.connect();
        await client.loadSession(sessionId, repoRoot);
        const resumedPrompt = await client.prompt(sessionId, 'second local test turn');
        expect(resumedPrompt.stopReason).toBe('end_turn');
        expect(resumedPrompt.usage).toMatchObject({
          inputTokens: 35,
          outputTokens: 9,
          totalTokens: 49,
          reasoningTokens: 3,
          cacheReadTokens: 5,
        });
        expect(provider.requestCount()).toBeGreaterThan(1);
      } finally {
        await client?.close();
        await provider.close();
      }
    },
    30_000,
  );

});
