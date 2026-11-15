import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSession,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarnessSink } from '../../../cli/src/session-sinks.js';
import { formatIssueSessionSummaryJson } from '../../../cli/src/format-session-summary.js';
import {
  formatSessionTimelineText,
  readSavedSessionTimeline,
} from '../../../cli/src/session-timeline.js';
import { DEFAULT_ENSEMBLE_CONFIG } from '../../src/config/defaults.js';
import { createPiConductorAgentFactory } from '../../src/conductor/pi-conductor-agent.js';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import { SessionLogger, type SessionLogEvent } from '../../src/conductor/session/session-logger.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import { ENSEMBLE_USER_ROOT_ENV } from '../../src/resolve-user-ensemble-root.js';
import { exportSessionBundle } from '../../src/session/export-session-bundle.js';
import {
  getPiConductorAuthStatus,
  listPiConductorModels,
} from '../../src/conductor/conductor-pi-auth.js';
import { TEST_ISSUE } from './helpers/in-process-acp-bridge.js';

const FIXTURE_PROVIDER = 'fixture';
const FIXTURE_MODEL = 'fixture-model';
const COMMAND_SENTINEL = 'COMMAND_SENTINEL';
const STDOUT_SENTINEL = 'STDOUT_SENTINEL';
const STDERR_SENTINEL = 'STDERR_SENTINEL';
const CAUSE_SENTINEL = 'CAUSE_SENTINEL';
const CREDENTIAL_SENTINEL = 'CREDENTIAL_SENTINEL';
const SAFE_COMMAND_ERROR =
  'API key auth failed for provider: failed to resolve API key for Pi provider from the configured command.';
const SECRET_SENTINELS = [
  COMMAND_SENTINEL,
  STDOUT_SENTINEL,
  STDERR_SENTINEL,
  CAUSE_SENTINEL,
  CREDENTIAL_SENTINEL,
];

interface PiAgentInternals {
  session: AgentSession;
}

function containsSecretSentinel(value: string): boolean {
  return SECRET_SENTINELS.some((sentinel) => value.includes(sentinel));
}

async function readFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? readFilesRecursively(path)
        : readFile(path, 'utf8');
    }),
  );
  return contents.flat();
}

function createCommandFailureMessage(model: {
  api: string;
  provider: string;
  id: string;
}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage:
      `Failed to resolve API key from shell command: ${COMMAND_SENTINEL}; ` +
      `stdout=${STDOUT_SENTINEL}; stderr=${STDERR_SENTINEL}; ` +
      `cause=${CAUSE_SENTINEL}; credential=${CREDENTIAL_SENTINEL}`,
    timestamp: Date.now(),
  };
}

describe('Pi command auth through the real conductor session', () => {
  let repoRoot = '';
  let userRoot = '';

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true });
      repoRoot = '';
    }
    if (userRoot) {
      await rm(userRoot, { recursive: true, force: true });
      userRoot = '';
    }
  });

  it('defers the command until a provider request and scrubs Pi errorMessage before persistence and output', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'pi-command-auth-session-'));
    userRoot = await mkdtemp(join(tmpdir(), 'pi-command-auth-user-'));
    vi.stubEnv(ENSEMBLE_USER_ROOT_ENV, userRoot);

    const agentDir = join(userRoot, 'pi');
    const projectDir = join(repoRoot, '.ensemble', 'pi');
    const markerPath = join(userRoot, 'command-ran');
    const sessionLogPath = join(userRoot, 'harness.log');
    const summaryPath = join(userRoot, 'session-summary.json');
    const bundlePath = join(userRoot, 'session-export');
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
    ]);
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        apiKeys: {
          [FIXTURE_PROVIDER]:
            `!printf '${CREDENTIAL_SENTINEL}'; ` +
            `printf '${STDERR_SENTINEL}' >&2; ` +
            `touch '${markerPath}'; # ${COMMAND_SENTINEL}`,
        },
      }),
    );
    await writeFile(
      join(projectDir, 'models.json'),
      JSON.stringify({
        providers: {
          [FIXTURE_PROVIDER]: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:1/v1',
            models: [
              {
                id: FIXTURE_MODEL,
                name: 'Fixture model',
                contextWindow: 128_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      }),
    );

    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Pi command auth integration',
      body: 'deterministic fixture',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(ModelRuntime.prototype, 'streamSimple').mockImplementation(
      function (this: ModelRuntime, model) {
        const stream = createAssistantMessageEventStream();
        void this
          .getAuth(model)
          .then(() => {
            stream.push({
              type: 'error',
              reason: 'error',
              error: createCommandFailureMessage(model),
            });
          })
          .catch(() => {
            stream.push({
              type: 'error',
              reason: 'error',
              error: createCommandFailureMessage(model),
            });
          });
        return stream;
      },
    );

    const authStatus = await getPiConductorAuthStatus({
      cwd: repoRoot,
      pi: { agentDir, projectDir },
      provider: FIXTURE_PROVIDER,
      env: {},
    });
    expect(authStatus.providers).toEqual([
      expect.objectContaining({
        provider: FIXTURE_PROVIDER,
        configured: true,
        source: 'settings_json',
        mode: 'command',
        scope: 'user',
      }),
    ]);
    await expect(
      listPiConductorModels({
        cwd: repoRoot,
        pi: { agentDir, projectDir },
        provider: FIXTURE_PROVIDER,
        env: {},
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
        provider: FIXTURE_PROVIDER,
      }),
    ]);
    expect(existsSync(markerPath)).toBe(false);

    const piFactory = createPiConductorAgentFactory();
    const piEvents: unknown[] = [];
    const piSessionFiles: string[] = [];
    const conductorAgentFactory = {
      create: async (options: Parameters<typeof piFactory.create>[0]) => {
        const agent = await piFactory.create(options);
        const session = (agent as unknown as PiAgentInternals).session;
        expect(session).toBeInstanceOf(AgentSession);
        expect(existsSync(markerPath)).toBe(false);
        const sessionFile = session.sessionManager.getSessionFile();
        expect(sessionFile).toBeTruthy();
        piSessionFiles.push(sessionFile!);
        session.subscribe((event) => piEvents.push(event));
        return agent;
      },
      resume: async (
        agentId: string,
        options: Parameters<typeof piFactory.resume>[1],
      ) => {
        const agent = await piFactory.resume(agentId, options);
        const session = (agent as unknown as PiAgentInternals).session;
        expect(session).toBeInstanceOf(AgentSession);
        const sessionFile = session.sessionManager.getSessionFile();
        expect(sessionFile).toBeTruthy();
        piSessionFiles.push(sessionFile!);
        session.subscribe((event) => piEvents.push(event));
        return agent;
      },
    };

    const sessionEvents: SessionLogEvent[] = [];
    const harnessOutput: string[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => sessionEvents.push(event));
    sessionLogger.subscribe(
      createHarnessSink({
        verbose: true,
        writeStderr: (line) => harnessOutput.push(line),
      }),
    );

    expect(existsSync(markerPath)).toBe(false);
    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      conductorCwd: repoRoot,
      profile: { agents: {}, workers: [] },
      ensembleConfig: {
        ...DEFAULT_ENSEMBLE_CONFIG,
        conductor: {
          ...DEFAULT_ENSEMBLE_CONFIG.conductor,
          backend: 'pi',
          pi: { agentDir, projectDir },
        },
      },
      conductorAgentFactory,
      modelId: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
      maxTurns: 1,
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      disableGitHubMonitor: true,
      registerProcessSignalHandlers: false,
      waitForOperatorExit: false,
    });

    expect(existsSync(markerPath)).toBe(true);
    expect(result).toMatchObject({
      lastRunStatus: 'error',
      lastError: {
        message: SAFE_COMMAND_ERROR,
      },
    });
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({ type: 'conductor.auth.recovery' }),
    );

    const transcript = await readFile(piSessionFiles[0]!, 'utf8');
    const sessionEventJson = JSON.stringify(piEvents);
    const harnessEventJson = JSON.stringify(sessionEvents);
    const harnessOutputText = harnessOutput.join('\n');
    const exitJson = JSON.stringify(result, null, 2);
    const summaryJson = formatIssueSessionSummaryJson(result);
    await writeFile(sessionLogPath, `${harnessOutputText}\n`);
    await writeFile(summaryPath, summaryJson);

    const timeline = await readSavedSessionTimeline({
      repoRoot,
      conductorAgentId: result.agentId,
      summaryPath,
      harnessLogPath: sessionLogPath,
    });
    const timelineText = formatSessionTimelineText(timeline);
    expect(sessionEventJson).toContain(SAFE_COMMAND_ERROR);
    expect(transcript).toContain(SAFE_COMMAND_ERROR);
    const exported = await exportSessionBundle({
      repoRoot,
      conductorAgentId: result.agentId,
      outputDirectory: bundlePath,
      ensembleVersion: '0.21.0',
      cliVersion: '0.21.0',
      summaryPath,
      harnessLogPath: sessionLogPath,
    });
    const bundleContents = await readFilesRecursively(bundlePath);

    const exposedSurfaces = [
      sessionEventJson,
      harnessEventJson,
      harnessOutputText,
      exitJson,
      summaryJson,
      JSON.stringify(result.lastError),
      JSON.stringify(timeline),
      timelineText,
      transcript,
      exported.manifest ? JSON.stringify(exported.manifest) : '',
      ...bundleContents,
    ];
    for (const surface of exposedSurfaces) {
      expect(containsSecretSentinel(surface)).toBe(false);
    }

    expect(sessionEvents).toContainEqual(
      expect.objectContaining({
        type: 'conductor.send',
        status: 'error',
        error: { message: SAFE_COMMAND_ERROR },
      }),
    );
    expect(result.lastError?.message).toBe(SAFE_COMMAND_ERROR);
    expect(exported.manifest.files.map((file) => file.path)).toContain(
      'conductor/pi-transcript.jsonl',
    );
    expect(exported.manifest.files.map((file) => file.path)).toContain(
      'inputs/session-summary.json',
    );
    expect(exported.manifest.files.map((file) => file.path)).toContain(
      'inputs/harness.log',
    );
    // This initial harness prompt contains no operator-authored input to put in
    // the process-local recovery inbox. Provider errors are covered above at
    // the user-visible send/recovery hint and the persistent session surfaces.
  });
});
