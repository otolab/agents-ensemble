import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnAcpProcess } from '../../src/acp/acp-process.js';
import {
  resolveWorkerAcpSpawn,
  resolvedAcpSpawnToOptions,
} from '../../src/acp/resolve-acp-spawn.js';

const require = createRequire(import.meta.url);

function resolveOptionalAdapter(name: string): string | undefined {
  try {
    return require.resolve(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
}

const claudeAdapter = resolveOptionalAdapter(
  '@agentclientprotocol/claude-agent-acp/dist/index.js',
);
const piAdapter = resolveOptionalAdapter('pi-acp');

function resolveSpawn(
  preset: 'claude' | 'pi',
  model: string,
): ReturnType<typeof resolveWorkerAcpSpawn> {
  return resolveWorkerAcpSpawn({
    modelTag: 'integration',
    defaultOptions: {
      defaultAcpCli: preset,
      env: {},
      config: {
        acp: {
          models: {
            selected: { model, reasoning: 'high' },
          },
          tags: { integration: 'selected' },
        },
      } as import('../../src/config/types.js').EnsembleConfig,
    },
  });
}

function parseJsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.skipIf(!claudeAdapter)(
  'claude-agent-acp 0.70.0 worker model reasoning integration',
  () => {
    let tempRoot = '';
    const clients = new Set<Awaited<ReturnType<typeof spawnAcpProcess>>>();

    afterEach(async () => {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    });

    it(
      'applies model and effort through the pinned adapter on session/new and session/load without an LLM call',
      async () => {
        tempRoot = await mkdtemp(
          join(tmpdir(), 'ensemble-claude-acp-model-reasoning-'),
        );
        const repoRoot = join(tempRoot, 'repo');
        const claudeConfigDir = join(tempRoot, 'claude-config');
        const eventsPath = join(tempRoot, 'claude-events.jsonl');
        const loaderPath = join(tempRoot, 'loader.mjs');
        const sdkPath = join(tempRoot, 'fake-claude-agent-sdk.mjs');
        const stderrLines: string[] = [];
        await Promise.all([
          mkdir(repoRoot, { recursive: true }),
          mkdir(claudeConfigDir, { recursive: true }),
        ]);

        await writeFile(
          loaderPath,
          [
            "import { pathToFileURL } from 'node:url';",
            "const sdkUrl = pathToFileURL(process.env.CLAUDE_ADAPTER_TEST_SDK).href;",
            'export async function resolve(specifier, context, nextResolve) {',
            "  if (specifier === '@anthropic-ai/claude-agent-sdk') {",
            '    return { url: sdkUrl, shortCircuit: true };',
            '  }',
            '  return nextResolve(specifier, context, nextResolve);',
            '}',
            '',
          ].join('\n'),
        );
        await writeFile(
          sdkPath,
          [
            "import { appendFileSync } from 'node:fs';",
            "const eventsPath = process.env.CLAUDE_ADAPTER_TEST_EVENTS;",
            "const modelInfos = [",
            "  { value: 'claude-sonnet-test', displayName: 'Test Sonnet', description: '', resolvedModel: 'claude-sonnet-test', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },",
            "  { value: 'claude-opus-test', displayName: 'Test Opus', description: '', resolvedModel: 'claude-opus-test', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },",
            '];',
            'function record(event) {',
            "  appendFileSync(eventsPath, JSON.stringify(event) + '\\n');",
            '}',
            'export async function resolveSettings() {',
            "  return { effective: { env: {} }, effortLevel: 'low' };",
            '}',
            'export function filterEscalatingDefaultMode(settings) { return settings; }',
            'export function query({ options }) {',
            "  let model = 'claude-sonnet-test';",
            "  const sessionId = options.sessionId ?? options.resume ?? 'missing-session-id';",
            '  let isClosed = false;',
            '  let resolveNext;',
            '  record({ type: "query", sessionId, resume: options.resume ?? null, settingsModel: options.settings?.model ?? null });',
            '  return {',
            '    async initializationResult() {',
            '      return { models: modelInfos, account: {}, fast_mode_state: "off" };',
            '    },',
            '    async getContextUsage() {',
            '      return { model, rawMaxTokens: 200000 };',
            '    },',
            '    async setModel(modelId) {',
            '      model = modelId;',
            '      record({ type: "setModel", sessionId, modelId });',
            '    },',
            '    async applyFlagSettings(settings) {',
            '      record({ type: "applyFlagSettings", sessionId, settings });',
            '    },',
            '    async setPermissionMode() {},',
            '    async supportedCommands() { return []; },',
            '    async supportedAgents() { return []; },',
            '    [Symbol.asyncIterator]() {',
            '      return {',
            '        next() {',
            '          if (isClosed) return Promise.resolve({ done: true, value: undefined });',
            '          return new Promise((resolve) => { resolveNext = resolve; });',
            '        },',
            '        async return() {',
            '          isClosed = true;',
            '          resolveNext?.({ done: true, value: undefined });',
            '          return { done: true, value: undefined };',
            '        },',
            '      };',
            '    },',
            '    async close() {',
            '      isClosed = true;',
            '      resolveNext?.({ done: true, value: undefined });',
            '    },',
            '  };',
            '}',
            'export const USAGE_LIMIT_ERROR_PREFIXES = [];',
            'export function createSdkMcpServer(options) { return options; }',
            'export async function getSessionMessages() { return []; }',
            'export async function getSessionInfo() { return undefined; }',
            'export async function listSessions() { return []; }',
            'export async function deleteSession() {}',
            '',
          ].join('\n'),
        );

        const model = 'claude-opus-test';
        const resolved = resolveSpawn('claude', model);
        const spawnOptions = resolvedAcpSpawnToOptions(resolved);
        const isolatedEnv: NodeJS.ProcessEnv = {
          HOME: tempRoot,
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: claudeConfigDir,
          CLAUDE_CODE_EXECUTABLE: join(tempRoot, 'unused-claude-cli'),
          CLAUDE_ADAPTER_TEST_SDK: sdkPath,
          CLAUDE_ADAPTER_TEST_EVENTS: eventsPath,
          NODE_OPTIONS: `--experimental-loader=${loaderPath}`,
          ...(process.platform === 'win32'
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        };

        const startClient = async () => {
          const client = await spawnAcpProcess({
            ...spawnOptions,
            command: process.execPath,
            args: [claudeAdapter!],
            cwd: repoRoot,
            env: isolatedEnv,
            onProcessStdioLine: ({ line }) => stderrLines.push(line),
          });
          clients.add(client);
          try {
            await client.connect();
          } catch (error) {
            throw new Error(
              `claude-agent-acp stderr:\n${stderrLines.join('\n')}`,
              { cause: error },
            );
          }
          return client;
        };

        const createdClient = await startClient();
        const sessionId = await createdClient.newSession(repoRoot);
        await createdClient.close();
        clients.delete(createdClient);

        const loadedClient = await startClient();
        await loadedClient.loadSession(sessionId, repoRoot);
        await loadedClient.close();
        clients.delete(loadedClient);

        const events = parseJsonLines(await readFile(eventsPath, 'utf8'));
        const queries = events.filter((event) => event.type === 'query');
        expect(queries).toHaveLength(2);
        expect(queries.map((event) => event.resume)).toEqual([
          null,
          sessionId,
        ]);
        expect(
          queries.map((event) => event.settingsModel),
        ).toEqual([model, model]);
        expect(
          events.filter(
            (event) =>
              event.type === 'setModel' && event.modelId === model,
          ),
        ).toHaveLength(2);
        expect(
          events.filter(
            (event) =>
              event.type === 'applyFlagSettings' &&
              (event.settings as Record<string, unknown> | undefined)
                ?.effortLevel === 'high',
          ),
        ).toHaveLength(2);
      },
      30_000,
    );
  },
);

describe.skipIf(!piAdapter || process.platform === 'win32')(
  'pi-acp 0.0.33 worker model reasoning integration',
  () => {
    let tempRoot = '';
    const clients = new Set<Awaited<ReturnType<typeof spawnAcpProcess>>>();

    afterEach(async () => {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    });

    it(
      'applies model and thought level through the pinned adapter on session/new and session/load without an LLM call',
      async () => {
        tempRoot = await mkdtemp(
          join(tmpdir(), 'ensemble-pi-acp-model-reasoning-'),
        );
        const repoRoot = join(tempRoot, 'repo');
        const binDir = join(tempRoot, 'bin');
        const eventsPath = join(tempRoot, 'pi-events.jsonl');
        const sessionFile = join(tempRoot, 'pi-sessions', 'test-session.jsonl');
        const fakePiPath = join(tempRoot, 'fake-pi');
        const fakePiSourcePath = join(tempRoot, 'fake-pi.mjs');
        await Promise.all([
          mkdir(repoRoot, { recursive: true }),
          mkdir(binDir, { recursive: true }),
          mkdir(join(tempRoot, 'pi-sessions'), { recursive: true }),
        ]);
        await symlink(process.execPath, join(binDir, 'node'));
        await writeFile(
          fakePiSourcePath,
          [
            "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
            'const eventsPath = process.env.PI_ACP_ADAPTER_TEST_EVENTS;',
            'const sessionFile = process.env.PI_ACP_ADAPTER_TEST_SESSION_FILE;',
            "let model = { provider: 'openai', id: 'baseline-model' };",
            "let thinkingLevel = 'medium';",
            'if (!existsSync(sessionFile)) writeFileSync(sessionFile, "[]\\n");',
            'function record(event) {',
            "  appendFileSync(eventsPath, JSON.stringify({ argv: process.argv.slice(2), ...event }) + '\\n');",
            '}',
            'function reply(request, data = {}) {',
            '  process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true, data }) + "\\n");',
            '}',
            'process.stdin.setEncoding("utf8");',
            'let pending = "";',
            'process.stdin.on("data", (chunk) => {',
            '  pending += chunk;',
            '  for (;;) {',
            '    const newline = pending.indexOf("\\n");',
            '    if (newline < 0) break;',
            '    const line = pending.slice(0, newline);',
            '    pending = pending.slice(newline + 1);',
            '    if (!line.trim()) continue;',
            '    const request = JSON.parse(line);',
            '    record({ type: request.type, model, thinkingLevel });',
            '    switch (request.type) {',
            '      case "get_state":',
            '        reply(request, { sessionId: "pi-acp-integration-session", sessionFile, model, thinkingLevel });',
            '        break;',
            '      case "get_available_models":',
            '        reply(request, { models: [',
            '          { provider: "openai", id: "baseline-model", name: "Baseline" },',
            '          { provider: "openai", id: "target-model", name: "Target" },',
            '        ] });',
            '        break;',
            '      case "set_model":',
            '        model = { provider: request.provider, id: request.modelId };',
            '        record({ type: "set_model_applied", model });',
            '        reply(request, { model });',
            '        break;',
            '      case "set_thinking_level":',
            '        thinkingLevel = request.level;',
            '        record({ type: "set_thinking_level_applied", thinkingLevel });',
            '        reply(request, { thinkingLevel });',
            '        break;',
            '      case "get_messages":',
            '        reply(request, { messages: [] });',
            '        break;',
            '      case "get_commands":',
            '        reply(request, { commands: [] });',
            '        break;',
            '      default:',
            '        reply(request);',
            '    }',
            '  }',
            '});',
            '',
          ].join('\n'),
        );
        await writeFile(
          fakePiPath,
          `#!/usr/bin/env node\nimport(${JSON.stringify(fakePiSourcePath)});\n`,
        );
        await chmod(fakePiPath, 0o755);

        const model = 'openai/target-model';
        const resolved = resolveSpawn('pi', model);
        const spawnOptions = resolvedAcpSpawnToOptions(resolved);
        const isolatedEnv: NodeJS.ProcessEnv = {
          HOME: tempRoot,
          PATH: binDir,
          PI_ACP_PI_COMMAND: fakePiPath,
          PI_ACP_ADAPTER_TEST_EVENTS: eventsPath,
          PI_ACP_ADAPTER_TEST_SESSION_FILE: sessionFile,
        };

        const startClient = async () => {
          const client = await spawnAcpProcess({
            ...spawnOptions,
            command: process.execPath,
            args: [piAdapter!],
            cwd: repoRoot,
            env: isolatedEnv,
          });
          clients.add(client);
          await client.connect();
          return client;
        };

        const createdClient = await startClient();
        const sessionId = await createdClient.newSession(repoRoot);
        await createdClient.close();
        clients.delete(createdClient);

        const loadedClient = await startClient();
        await loadedClient.loadSession(sessionId, repoRoot);
        await loadedClient.close();
        clients.delete(loadedClient);

        const events = parseJsonLines(await readFile(eventsPath, 'utf8'));
        expect(
          events.filter(
            (event) =>
              event.type === 'set_model_applied' &&
              (event.model as Record<string, unknown> | undefined)?.id ===
                'target-model',
          ),
        ).toHaveLength(2);
        expect(
          events.filter(
            (event) =>
              event.type === 'set_thinking_level_applied' &&
              event.thinkingLevel === 'high',
          ),
        ).toHaveLength(2);
        const resumedPiProcesses = events.filter((event) => {
          const argv = event.argv as string[] | undefined;
          const sessionFlag = argv?.indexOf('--session') ?? -1;
          return (
            event.type === 'get_state' &&
            sessionFlag >= 0 &&
            argv?.[sessionFlag + 1] === sessionFile
          );
        });
        expect(resumedPiProcesses).not.toHaveLength(0);
        expect(
          new Set(resumedPiProcesses.map((event) => JSON.stringify(event.argv)))
            .size,
        ).toBe(1);
      },
      30_000,
    );
  },
);
