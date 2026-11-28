import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnAcpProcess } from '../../src/acp/acp-process.js';
import { configurePiWorkerRuntime } from '../../src/acp/pi-runtime.js';
import { resolveEnsemblePaths } from '../../src/ensemble-paths.js';
import {
  resolveWorkerAcpSpawn,
  resolvedAcpSpawnToOptions,
} from '../../src/acp/resolve-acp-spawn.js';
import { finalizeResolvedAcpSpawn } from '../../src/acp/validate-acp-preset-prerequisites.js';
import { createPiConductorAgentFactory } from '../../src/conductor/pi-conductor-agent.js';
import type { ConductorAgent } from '../../src/conductor/conductor-agent.js';
import type { EnsembleConfig } from '../../src/config/types.js';

const MODEL_ID = 'fixture-tool-model';
const PROVIDER = 'loopback-fixture';

describe('Pi runtime with a loopback OpenAI-compatible provider', () => {
  let agent: ConductorAgent | undefined;
  let workerClient: Awaited<ReturnType<typeof spawnAcpProcess>> | undefined;
  let root = '';
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await agent?.close();
    agent = undefined;
    await workerClient?.close();
    workerClient = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('accepts a model tool call, executes a safe harness tool, and returns the follow-up answer', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-local-provider-tool-'));
    const agentDir = join(root, 'pi-user');
    const projectDir = join(root, 'pi-project');
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);

    let requestCount = 0;
    const requests: Array<{ host: string | undefined; authorization: string | undefined }> = [];
    server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      requestCount += 1;
      requests.push({
        host: request.headers.host,
        authorization: request.headers.authorization,
      });
      void (async () => {
        for await (const _chunk of request) {
          // The request is deliberately consumed only by this loopback fixture.
        }
        const chunks =
          requestCount === 1
            ? [
                {
                  id: 'local-tool-call',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: MODEL_ID,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        id: 'fixture-call-1',
                        type: 'function',
                        function: {
                          name: 'record_fixture_tool',
                          arguments: '{"value":"loopback-tool-ran"}',
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                },
                {
                  id: 'local-tool-call',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: MODEL_ID,
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                },
              ]
            : [{
                id: 'local-final-answer',
                object: 'chat.completion.chunk',
                created: 2,
                model: MODEL_ID,
                choices: [{
                  index: 0,
                  delta: { content: 'loopback fixture completed the tool round trip' },
                  finish_reason: 'stop',
                }],
              }];
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        for (const chunk of chunks) {
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Loopback fixture did not bind a TCP port.');
    }
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          [PROVIDER]: {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            authHeader: true,
            models: [{
              id: MODEL_ID,
              name: 'Loopback fixture model',
              contextWindow: 16_000,
              maxTokens: 1_000,
              reasoning: false,
            }],
          },
        },
      }),
    );

    const toolCalls: string[] = [];
    agent = await createPiConductorAgentFactory().create({
      cwd: root,
      sessionDir: join(root, 'sessions'),
      modelId: `${PROVIDER}/${MODEL_ID}`,
      systemPrompt: 'Use the provided fixture tool, then report its result.',
      pi: { agentDir, projectDir },
      apiKey: 'not-a-provider-credential',
      piExtensions: false,
      piSkills: false,
      piPromptResources: false,
      piInternalExtensions: false,
      builtinTools: false,
      customTools: {
        record_fixture_tool: {
          name: 'record_fixture_tool',
          description: 'Record a fixed local runtime smoke-test marker.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
          execute: async (args) => {
            toolCalls.push(String(args.value));
            return { content: [{ type: 'text', text: `recorded:${String(args.value)}` }] };
          },
        },
      },
    });

    await expect(agent.send('Run the local fixture tool.')).resolves.toMatchObject({
      status: 'finished',
      result: 'loopback fixture completed the tool round trip',
    });
    expect(toolCalls).toEqual(['loopback-tool-ran']);
    expect(requestCount).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.host === `127.0.0.1:${address.port}`)).toBe(true);
    expect(requests.every((request) => request.authorization === 'Bearer not-a-provider-credential')).toBe(true);
  });

  it('runs the bundled Pi ACP worker through a loopback model tool call', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-worker-local-provider-'));
    const repoRoot = join(root, 'repo');
    const agentDir = join(root, 'pi-user');
    const markerPath = join(root, 'worker-tool-marker');
    await Promise.all([
      mkdir(join(repoRoot, '.ensemble'), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);

    let requestCount = 0;
    const workerRequestHosts: string[] = [];
    server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      requestCount += 1;
      workerRequestHosts.push(request.headers.host ?? '');
      void (async () => {
        for await (const _chunk of request) {
          // The request is deliberately consumed only by this loopback fixture.
        }
        const chunks =
          requestCount === 1
            ? [
                {
                  id: 'local-worker-tool',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: MODEL_ID,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: 0,
                        id: 'worker-call-1',
                        type: 'function',
                        function: {
                          name: 'bash',
                          arguments: JSON.stringify({
                            command: `printf 'worker-tool-ran' > '${markerPath}'`,
                          }),
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                },
                {
                  id: 'local-worker-tool',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: MODEL_ID,
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                },
              ]
            : [{
                id: 'local-worker-final',
                object: 'chat.completion.chunk',
                created: 2,
                model: MODEL_ID,
                choices: [{
                  index: 0,
                  delta: { content: 'loopback worker fixture finished' },
                  finish_reason: 'stop',
                }],
              }];
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        for (const chunk of chunks) {
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Loopback worker fixture did not bind a TCP port.');
    }
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          [PROVIDER]: {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            authHeader: true,
            models: [{
              id: MODEL_ID,
              name: 'Loopback fixture model',
              contextWindow: 16_000,
              maxTokens: 1_000,
              reasoning: false,
            }],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({ apiKeys: { [PROVIDER]: 'not-a-provider-credential' } }),
    );

    const config = {
      acp: {
        pi: { runtime: 'builtin' },
        models: { smoke: { model: `${PROVIDER}/${MODEL_ID}` } },
        tags: { implementer: 'smoke' },
      },
    } as EnsembleConfig;
    const resolved = configurePiWorkerRuntime(
      resolveWorkerAcpSpawn({
        modelTag: 'implementer',
        defaultOptions: { defaultAcpCli: 'pi', env: {}, config },
      }),
      { repoRoot, issueNumber: 888, workerName: 'implementer', agentDir },
    );
    const spawnOptions = resolvedAcpSpawnToOptions(
      finalizeResolvedAcpSpawn(resolved),
      {
        env: {
          PATH: process.env.PATH,
          HOME: resolved.env?.HOME,
          USERPROFILE: resolved.env?.USERPROFILE,
          ENSEMBLE_USER_ROOT: join(root, 'ensemble-user'),
        },
      },
    );
    workerClient = await spawnAcpProcess({
      ...spawnOptions,
      cwd: repoRoot,
      permissionHandler: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
    });
    await workerClient.connect();
    const sessionId = await workerClient.newSession(repoRoot);
    const result = await workerClient.prompt(
      sessionId,
      'Use bash to create the configured local marker, then report completion.',
    );

    expect(result.responseText).toContain('loopback worker fixture finished');
    expect(existsSync(markerPath)).toBe(true);
    expect(await readFile(markerPath, 'utf8')).toBe('worker-tool-ran');
    expect(requestCount).toBe(2);
    expect(workerRequestHosts).toEqual([
      `127.0.0.1:${address.port}`,
      `127.0.0.1:${address.port}`,
    ]);
    const workerHome = resolveEnsemblePaths({
      repoRoot,
      piAgentDir: agentDir,
    }).piWorkerDir('implementer', 888);
    const sessionMapPath = join(
      workerHome,
      '.pi',
      'pi-acp',
      'session-map.json',
    );
    expect(resolved.env?.HOME).toBe(workerHome);
    expect(existsSync(sessionMapPath)).toBe(true);
    const sessionMap = JSON.parse(await readFile(sessionMapPath, 'utf8')) as {
      sessions: Record<string, { sessionFile: string }>;
    };
    const transcriptPath = sessionMap.sessions[sessionId]?.sessionFile;
    expect(transcriptPath).toBeTruthy();
    expect(transcriptPath && existsSync(transcriptPath)).toBe(true);
    expect(transcriptPath && dirname(transcriptPath)).toBe(
      join(workerHome, 'sessions'),
    );
  });
});
