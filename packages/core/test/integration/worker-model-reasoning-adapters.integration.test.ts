import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpBridge } from '../../src/acp/acp-bridge.js';
import { spawnAcpProcess } from '../../src/acp/acp-process.js';
import { configurePiWorkerRuntime } from '../../src/acp/pi-runtime.js';
import {
  resolveWorkerAcpSpawn,
  resolvedAcpSpawnToOptions,
} from '../../src/acp/resolve-acp-spawn.js';
import { finalizeResolvedAcpSpawn } from '../../src/acp/validate-acp-preset-prerequisites.js';
import { resolveEnsemblePaths } from '../../src/ensemble-paths.js';
import { resolvePiAcpSessionMapPaths } from '../../src/acp/pi-session-map.js';
import { attachWorker } from '../../src/dispatch/attach-worker.js';

const require = createRequire(import.meta.url);
const piByoAdapterManifest = require.resolve('pi-acp/package.json');
const piBuiltinAdapterManifest = require.resolve(
  'pi-acp-builtin/package.json',
);

describe('Pi ACP upstream dependency selection', () => {
  it('keeps BYO on 0.0.33 and builtin on 0.0.34', () => {
    const byo = JSON.parse(
      readFileSync(piByoAdapterManifest, 'utf8'),
    ) as { name: string; version: string };
    const builtin = JSON.parse(
      readFileSync(piBuiltinAdapterManifest, 'utf8'),
    ) as { name: string; version: string };

    expect(byo).toMatchObject({ name: 'pi-acp', version: '0.0.33' });
    expect(builtin).toMatchObject({ name: 'pi-acp', version: '0.0.34' });
  });
});

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
function resolveSpawn(
  preset: 'claude' | 'pi',
  model: string,
  piRuntime?: 'byo' | 'builtin',
): ReturnType<typeof resolveWorkerAcpSpawn> {
  return resolveWorkerAcpSpawn({
    modelTag: 'integration',
    defaultOptions: {
      defaultAcpCli: preset,
      env: {},
      config: {
        acp: {
          ...(piRuntime ? { pi: { runtime: piRuntime } } : {}),
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
      vi.unstubAllEnvs();
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

describe.skipIf(process.platform === 'win32')(
  'upstream pi-acp builtin worker model reasoning integration',
  () => {
    let tempRoot = '';
    const clients = new Set<Awaited<ReturnType<typeof spawnAcpProcess>>>();

    afterEach(async () => {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
      vi.unstubAllEnvs();
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
        const userRoot = join(tempRoot, 'ensemble-user');
        const userHome = join(tempRoot, 'operator-home');
        const customAgentDir = join(tempRoot, 'custom-pi-agent');
        const binDir = join(tempRoot, 'bin');
        const eventsPath = join(tempRoot, 'pi-events.jsonl');
        const fakePiPath = join(tempRoot, 'fake-pi');
        const fakePiSourcePath = join(tempRoot, 'fake-pi.mjs');
        vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
        vi.stubEnv('HOME', userHome);
        vi.stubEnv('USERPROFILE', userHome);
        await Promise.all([
          mkdir(repoRoot, { recursive: true }),
          mkdir(join(userHome, '.ssh'), { recursive: true, mode: 0o700 }),
          mkdir(join(userHome, '.config', 'gh'), {
            recursive: true,
            mode: 0o700,
          }),
          mkdir(binDir, { recursive: true }),
          mkdir(customAgentDir, { recursive: true }),
        ]);
        await Promise.all([
          writeFile(
            join(userHome, '.gitconfig'),
            '[user]\n  name = Fixture Developer\n  email = fixture@example.invalid\n',
            { mode: 0o600 },
          ),
          writeFile(
            join(userHome, '.ssh', 'config'),
            'Host ensemble-fixture\n  HostName git.example.invalid\n  User fixture-user\n  Port 2222\n',
            { mode: 0o600 },
          ),
          writeFile(
            join(userHome, '.config', 'gh', 'config.yml'),
            'version: 1\ngit_protocol: ssh\n',
            { mode: 0o600 },
          ),
        ]);
        await writeFile(
          join(customAgentDir, 'auth.json'),
          '{"fixture":"credential-path-probe"}\n',
        );
        await symlink(process.execPath, join(binDir, 'node'));
        await writeFile(
          fakePiSourcePath,
          [
            "import { spawnSync } from 'node:child_process';",
            "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            'const eventsPath = process.env.PI_ACP_ADAPTER_TEST_EVENTS;',
            'const sessionFile = process.env.PI_ACP_ADAPTER_TEST_SESSION_FILE;',
            "let model = { provider: 'openai', id: 'baseline-model' };",
            "let thinkingLevel = 'medium';",
            'if (!existsSync(sessionFile)) writeFileSync(sessionFile, [',
            '  JSON.stringify({ type: "session", version: 3, id: "pi-acp-integration-session", timestamp: new Date().toISOString(), cwd: process.cwd() }),',
            '  JSON.stringify({ type: "message", id: "fixture-user", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "builtin fixture user message" }], timestamp: Date.now() } }),',
            '  JSON.stringify({ type: "message", id: "fixture-assistant", parentId: "fixture-user", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "builtin fixture assistant message" }], timestamp: Date.now() } }),',
            '].join("\\n") + "\\n");',
            'function record(event) {',
            "  appendFileSync(eventsPath, JSON.stringify({ argv: process.argv.slice(2), ...event }) + '\\n');",
            '}',
            'function runCommand(command, args) {',
            '  const result = spawnSync(command, args, { encoding: "utf8" });',
            '  if (result.error || result.status !== 0) {',
            '    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`);',
            '  }',
            '  return result.stdout.trim();',
            '}',
            'function readShellConfig() {',
            '  const gitUser = runCommand("git", ["config", "--global", "user.name"]);',
            '  const sshConfigPath = join(process.env.HOME ?? "", ".ssh", "config");',
            '  const sshConfig = runCommand("ssh", ["-F", sshConfigPath, "-G", "ensemble-fixture"]);',
            '  const sshHost = sshConfig.split("\\n").find((line) => line.startsWith("hostname "))?.slice("hostname ".length);',
            '  const sshPort = sshConfig.split("\\n").find((line) => line.startsWith("port "))?.slice("port ".length);',
            '  const ghGitProtocol = runCommand("gh", ["config", "get", "git_protocol"]);',
            '  return { gitUser, sshHost, sshPort, ghGitProtocol };',
            '}',
            'record({ type: "shell-config", home: process.env.HOME ?? null, userprofile: process.env.USERPROFILE ?? null, ...readShellConfig() });',
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
            '    record({',
            '      type: request.type,',
            '      model,',
            '      thinkingLevel,',
            '      home: process.env.HOME ?? null,',
            '      userprofile: process.env.USERPROFILE ?? null,',
            '      piAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,',
            '      piAuthExists: process.env.PI_CODING_AGENT_DIR ? existsSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json")) : false,',
            '    });',
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
            '      case "get_available_thinking_levels":',
            '        reply(request, { levels: ["low", "medium", "high"] });',
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

        // Keep the runtime's user-scoped logs inside this test's temporary tree.
        vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
        const model = 'openai/target-model';
        const resolved = configurePiWorkerRuntime(
          resolveSpawn('pi', model, 'builtin'),
          {
            repoRoot,
            workerName: 'integration',
            agentDir: customAgentDir,
          },
        );
        const paths = resolveEnsemblePaths({ repoRoot });
        const workerHome = paths.piWorkerDir('integration');
        const sessionMapPaths = resolvePiAcpSessionMapPaths(workerHome);
        const sessionFile = join(
          resolved.env!.PI_CODING_AGENT_SESSION_DIR!,
          'test-session.jsonl',
        );
        await mkdir(resolved.env!.PI_CODING_AGENT_SESSION_DIR!, {
          recursive: true,
        });
        const spawnOptions = resolvedAcpSpawnToOptions(
          finalizeResolvedAcpSpawn(resolved),
        );
        const searchPath = [binDir, process.env.PATH]
          .filter((entry): entry is string => Boolean(entry))
          .join(delimiter);
        const isolatedEnv: NodeJS.ProcessEnv = {
          ENSEMBLE_PI_BUILTIN_RUNTIME:
            spawnOptions.env?.ENSEMBLE_PI_BUILTIN_RUNTIME,
          ENSEMBLE_PI_CLI_HOME: spawnOptions.env?.ENSEMBLE_PI_CLI_HOME,
          ENSEMBLE_PI_CLI_USERPROFILE:
            spawnOptions.env?.ENSEMBLE_PI_CLI_USERPROFILE,
          ENSEMBLE_PI_CLI_NODE: spawnOptions.env?.ENSEMBLE_PI_CLI_NODE,
          ENSEMBLE_PI_CLI_EXECUTABLE: fakePiPath,
          HOME: spawnOptions.env?.HOME,
          USERPROFILE: spawnOptions.env?.USERPROFILE,
          PATH: searchPath,
          PI_CODING_AGENT_DIR: spawnOptions.env?.PI_CODING_AGENT_DIR,
          PI_CODING_AGENT_SESSION_DIR:
            spawnOptions.env?.PI_CODING_AGENT_SESSION_DIR,
          PI_ACP_PI_COMMAND: spawnOptions.env?.PI_ACP_PI_COMMAND,
          ENSEMBLE_USER_ROOT: userRoot,
          // Force the normal HOME-based fallback for `gh`; this proves the
          // wrapper restores HOME instead of relying on a separately pinned
          // config directory.
          XDG_CONFIG_HOME: '',
          GH_CONFIG_DIR: '',
          PI_ACP_ADAPTER_TEST_EVENTS: eventsPath,
          PI_ACP_ADAPTER_TEST_SESSION_FILE: sessionFile,
          ...(process.platform === 'win32'
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        };

        const startClient = async () => {
          const client = await spawnAcpProcess({
            ...spawnOptions,
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

        const createdMap = JSON.parse(
          await readFile(sessionMapPaths.upstreamPath, 'utf8'),
        ) as {
          sessions: Record<string, { sessionFile: string }>;
        };
        expect(createdMap.sessions[sessionId]?.sessionFile).toBe(sessionFile);
        expect(resolved.env?.HOME).toBe(workerHome);
        expect(resolved.env?.USERPROFILE).toBe(workerHome);
        expect(resolved.env?.PI_CODING_AGENT_DIR).toBe(customAgentDir);
        expect(resolved.env?.PI_CODING_AGENT_SESSION_DIR).toBe(
          paths.piWorkerSessionsDir('integration'),
        );
        expect(resolved.env?.ENSEMBLE_PI_CLI_HOME).toBe(userHome);
        expect(resolved.env?.PI_ACP_PI_COMMAND).not.toBe(fakePiPath);
        expect(resolved.env).not.toHaveProperty('PI_ACP_SESSION_MAP_PATH');

        // The old builtin layout stored its map directly in the worker root.
        // Exercise wrapper migration before loading the just-created session.
        await rename(sessionMapPaths.upstreamPath, sessionMapPaths.legacyPath);
        const legacyMapContents = await readFile(
          sessionMapPaths.legacyPath,
          'utf8',
        );
        const loadedClient = await startClient();
        await loadedClient.loadSession(sessionId, repoRoot);
        await loadedClient.close();
        clients.delete(loadedClient);
        await expect(
          readFile(sessionMapPaths.legacyPath, 'utf8'),
        ).resolves.toBe(legacyMapContents);
        const migratedMap = JSON.parse(
          await readFile(sessionMapPaths.upstreamPath, 'utf8'),
        ) as {
          sessions: Record<
            string,
            { sessionId: string; cwd: string; sessionFile: string }
          >;
        };
        expect(migratedMap.sessions[sessionId]).toMatchObject({
          sessionId,
          cwd: repoRoot,
          sessionFile,
        });

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
        expect(resolved.env?.PI_CODING_AGENT_DIR).toBe(
          customAgentDir,
        );
        expect(sessionFile).toBe(
          join(
            resolved.env!.PI_CODING_AGENT_SESSION_DIR!,
            'test-session.jsonl',
          ),
        );
        expect(
          JSON.parse(
            await readFile(join(customAgentDir, 'settings.json'), 'utf8'),
          ),
        ).toMatchObject({
          defaultThinkingLevel: 'medium',
          enableSkillCommands: true,
        });
        const piProcessEvents = parseJsonLines(await readFile(eventsPath, 'utf8'))
          .filter((event) => event.type === 'get_state');
        expect(piProcessEvents.length).toBeGreaterThan(0);
        for (const event of piProcessEvents) {
          expect(event.home).toBe(userHome);
          expect(event.userprofile).toBe(userHome);
          expect(event.piAgentDir).toBe(customAgentDir);
          expect(event.piAuthExists).toBe(true);
        }
        const shellConfigEvents = events.filter(
          (event) => event.type === 'shell-config',
        );
        expect(shellConfigEvents).toHaveLength(2);
        for (const event of shellConfigEvents) {
          expect(event.home).toBe(userHome);
          expect(event.userprofile).toBe(userHome);
          expect(event.gitUser).toBe('Fixture Developer');
          expect(event.sshHost).toBe('git.example.invalid');
          expect(event.sshPort).toBe('2222');
          expect(event.ghGitProtocol).toBe('ssh');
        }

        // Simulate a stopped worker whose session map was lost but transcript
        // remains. A builtin resume must fail visibly without creating a new
        // Pi session or changing the saved session identifier.
        await rm(sessionMapPaths.upstreamPath, { force: true });
        await rm(sessionMapPaths.legacyPath, { force: true });
        await expect(readFile(sessionFile, 'utf8')).resolves.toContain(
          'builtin fixture user message',
        );

        const issueUrl = 'https://github.com/org/repo/issues/1';
        await expect(
          attachWorker({
            name: 'integration',
            issueUrl,
            kind: 'implementer',
            sessionState: {} as never,
            worktree: {
              path: repoRoot,
              branch: 'ensemble/issue-1',
              issue: {
                owner: 'org',
                repo: 'repo',
                number: 1,
                url: issueUrl,
              },
              inRepo: false,
            },
            resumeAcpSessionId: sessionId,
            currentAcpSpawn: {
              preset: 'pi',
              command: 'pi-acp',
              args: [],
              piRuntime: 'builtin',
            },
            spawn: {
              command: spawnOptions.command,
              args: spawnOptions.args,
              env: isolatedEnv,
            },
            connectAcp: async ({ cwd, spawn }) =>
              AcpBridge.connect({
                ...spawn,
                cwd,
                env: isolatedEnv,
              }),
          }),
        ).rejects.toThrow(
          /could not resume builtin Pi ACP session.*Refusing to start a new session without the saved context/u,
        );

        await expect(
          readFile(sessionMapPaths.upstreamPath, 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
          readFile(sessionMapPaths.legacyPath, 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      },
      30_000,
    );
  },
);

describe.skipIf(process.platform === 'win32')(
  'upstream pi-acp BYO compatibility integration',
  () => {
    let tempRoot = '';
    const clients = new Set<Awaited<ReturnType<typeof spawnAcpProcess>>>();

    afterEach(async () => {
      await Promise.all([...clients].map((client) => client.close()));
      clients.clear();
      vi.unstubAllEnvs();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    });

    it(
      'keeps Pi CLI PATH and HOME session-map storage for session/new and session/load',
      async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-pi-acp-byo-'));
        const homeRoot = join(tempRoot, 'home');
        const binDir = join(tempRoot, 'bin');
        const eventsPath = join(tempRoot, 'pi-events.jsonl');
        const fakePiPath = join(binDir, 'pi');
        const fakePiSourcePath = join(tempRoot, 'fake-pi.mjs');
        const sessionFile = join(
          homeRoot,
          '.pi',
          'agent',
          'sessions',
          'byo-session.jsonl',
        );
        await Promise.all([
          mkdir(homeRoot, { recursive: true }),
          mkdir(binDir, { recursive: true }),
        ]);
        await symlink(process.execPath, join(binDir, 'node'));
        await writeFile(
          fakePiSourcePath,
          [
            "import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';",
            "import { dirname } from 'node:path';",
            'const eventsPath = process.env.PI_ACP_ADAPTER_TEST_EVENTS;',
            'const sessionFile = process.env.PI_ACP_ADAPTER_TEST_SESSION_FILE;',
            "const sessionId = 'byo-session';",
            'mkdirSync(dirname(sessionFile), { recursive: true });',
            'if (!existsSync(sessionFile)) {',
            '  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\\n");',
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
            '    appendFileSync(eventsPath, JSON.stringify({',
            '      type: request.type,',
            '      argv: process.argv.slice(2),',
            '      home: process.env.HOME ?? null,',
            '      piAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,',
            '      piSessionDir: process.env.PI_CODING_AGENT_SESSION_DIR ?? null,',
            '    }) + "\\n");',
            '    switch (request.type) {',
            '      case "get_state":',
            '        reply(request, { sessionId, sessionFile, model: { provider: "openai", id: "fixture" }, thinkingLevel: "medium" });',
            '        break;',
            '      case "get_available_models":',
            '        reply(request, { models: [{ provider: "openai", id: "fixture", name: "Fixture" }] });',
            '        break;',
            '      case "get_available_thinking_levels":',
            '        reply(request, { levels: ["low", "medium", "high"] });',
            '        break;',
            '      case "get_commands":',
            '        reply(request, { commands: [] });',
            '        break;',
            '      case "get_messages":',
            '        reply(request, { messages: [] });',
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

        const searchPath = [binDir, process.env.PATH]
          .filter((entry): entry is string => Boolean(entry))
          .join(delimiter);
        vi.stubEnv('PATH', searchPath);
        const resolved = resolveWorkerAcpSpawn({
          defaultOptions: { defaultAcpCli: 'pi', env: {} },
        });
        expect(resolved.piRuntime).toBeUndefined();
        expect(resolved.env).toBeUndefined();
        const spawnOptions = resolvedAcpSpawnToOptions(
          finalizeResolvedAcpSpawn(resolved),
        );
        const isolatedEnv: NodeJS.ProcessEnv = {
          HOME: homeRoot,
          USERPROFILE: homeRoot,
          PATH: searchPath,
          PI_ACP_ADAPTER_TEST_EVENTS: eventsPath,
          PI_ACP_ADAPTER_TEST_SESSION_FILE: sessionFile,
        };

        const startClient = async () => {
          const client = await spawnAcpProcess({
            ...spawnOptions,
            cwd: tempRoot,
            env: isolatedEnv,
          });
          clients.add(client);
          await client.connect();
          return client;
        };

        const createdClient = await startClient();
        const sessionId = await createdClient.newSession(tempRoot);
        await createdClient.close();
        clients.delete(createdClient);
        const sessionMapPath = join(
          homeRoot,
          '.pi',
          'pi-acp',
          'session-map.json',
        );
        const sessionMap = JSON.parse(await readFile(sessionMapPath, 'utf8')) as {
          sessions: Record<string, { sessionFile: string }>;
        };
        expect(sessionMap.sessions[sessionId]?.sessionFile).toBe(sessionFile);

        const loadedClient = await startClient();
        await loadedClient.loadSession(sessionId, tempRoot);
        await loadedClient.close();
        clients.delete(loadedClient);

        const piEvents = parseJsonLines(await readFile(eventsPath, 'utf8'));
        const stateEvents = piEvents.filter((event) => event.type === 'get_state');
        expect(stateEvents.length).toBeGreaterThan(0);
        for (const event of stateEvents) {
          expect(event.home).toBe(homeRoot);
          expect(event.piAgentDir).toBeNull();
          expect(event.piSessionDir).toBeNull();
        }
        expect(
          stateEvents.some((event) =>
            (event.argv as string[] | undefined)?.includes('--session'),
          ),
        ).toBe(true);
      },
      30_000,
    );
  },
);
