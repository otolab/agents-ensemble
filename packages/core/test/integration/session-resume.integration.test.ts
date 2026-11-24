import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKCustomTool } from '@cursor/sdk';
import yaml from 'js-yaml';
import { runConductorSession } from '../../src/conductor/conductor-session.js';
import {
  SessionLogger,
  type SessionLogEvent,
} from '../../src/conductor/session/session-logger.js';
import type { OperatorInputBindingApi } from '../../src/conductor/operator-input-binding.js';
import {
  attachWorker,
  buildWorkerAttachPrompt,
  runAttachedWorkerPrompt,
} from '../../src/dispatch/attach-worker.js';
import { closeWorkerAcpSession } from '../../src/dispatch/worker-acp-session.js';
import * as issueContextModule from '../../src/github/issue-context.js';
import * as githubMonitorModule from '../../src/github/github-monitor.js';
import { PermissionPipeline } from '../../src/permission/permission-pipeline.js';
import type { Profile } from '../../src/profile/types.js';
import type { EnsembleConfig } from '../../src/config/types.js';
import {
  loadSessionResumeStore,
  saveSessionResumeStore,
  SESSION_RESUME_STORE_VERSION,
  findLatestSessionResumeStoreForWorkspace,
  listWorkspaceSlugEntries,
} from '../../src/session/session-resume-store.js';
import {
  loadOpenQuestionsStore,
  openQuestionsStorePath,
  saveOpenQuestionsStore,
} from '../../src/session/open-questions-store.js';
import * as worktreeModule from '../../src/worktree/worktree.js';
import {
  createInProcessAcpBridge,
  IN_PROCESS_DEFAULT_ACP,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './helpers/in-process-acp-bridge.js';
import { createTestOperatorInputBinding } from '../../src/conductor/testing/test-operator-input-binding.js';
import type { OperatorInputBinding } from '../../src/conductor/operator-input-binding.js';
import {
  extractYamlScalar,
  isWorkerCompletedConductorMessage,
} from './helpers/conductor-session-assertions.js';
import { createMockConductorGetUsage } from '../../src/testing/mock-conductor-get-usage.js';
import { resolveEnsemblePaths } from '../../src/ensemble-paths.js';
import { toolCallSnapshotHistoryPath } from '../../src/session/tool-call-snapshot-history.js';
import { TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS } from '../../src/runtime/tool-call-snapshot-registry.js';
import { permissionRequestFixtures } from '../fixtures/permission-request-fixtures.js';
import { readWorkspaceNote } from '../../src/notes/workspace-notes-store.js';
import { executeRunCommand } from '../../../cli/src/run-command.js';

const RESUME_AGENT_ID = 'agent-resume-test';

// These tests inject an in-process bridge, but runConductorSession still
// validates the resolved ACP spawn before attaching workers. Use a real,
// always-available executable so the test does not require Cursor Agent CLI.
const PING_PROFILE_BASE: Profile = {
  conductor: { backend: 'cursor' },
  agents: {
    ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
  },
  workers: [{ name: 'ping-1', kind: 'ping' }],
};

const { mockSend, mockClose, mockCreate, mockCreateCursorSdkConductorAgentFactory } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockCreate = vi.fn();
  const mockCreateCursorSdkConductorAgentFactory = vi.fn();
  return { mockSend, mockClose, mockCreate, mockCreateCursorSdkConductorAgentFactory };
});

let conductorTools: Record<string, SDKCustomTool> = {};

vi.mock('../../src/conductor/cursor-sdk-conductor-agent.js', () => ({
  createCursorSdkConductorAgentFactory: mockCreateCursorSdkConductorAgentFactory,
}));

describe('session resume integration', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-resume-'));
    vi.stubEnv('HOME', repoRoot);

    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Resume integration',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue({
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    });

    mockSend.mockReset();
    mockClose.mockClear();
    mockCreate.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReset();
    mockCreateCursorSdkConductorAgentFactory.mockReturnValue({
      create: mockCreate,
      resume: mockCreate,
    });
    conductorTools = {};
    mockCreate.mockImplementation(async (options, resumeOptions) => {
      conductorTools = (resumeOptions ?? options).customTools ?? {};
      return {
        agentId: RESUME_AGENT_ID,
        send: mockSend,
        close: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('continues a workspace through the run command with notes and no GitHub monitor', async () => {
    const cwd = join(repoRoot, 'run-workspace');
    await mkdir(cwd);
    const briefPath = join(cwd, 'brief.md');
    await writeFile(briefPath, 'Investigate this workspace');
    const bridge = await createInProcessAcpBridge();
    const newSession = vi.spyOn(bridge, 'newSession');
    const loadSession = vi.spyOn(bridge, 'loadSession');
    const monitor = vi.spyOn(githubMonitorModule, 'createGitHubMonitor');
    const fetchIssue = vi.mocked(issueContextModule.fetchIssueContext);
    let noteId = '';
    let resumedMemo = '';
    let phase: 'initial' | 'continue' = 'initial';
    let operatorApi: OperatorInputBindingApi | undefined;

    mockSend.mockImplementation(async () => {
      if (phase === 'initial') {
        const result = await conductorTools.create_note!.execute({ summary: 'Workspace note' });
        noteId = JSON.parse(result.content[0]!.text).noteId;
        await conductorTools.push_memo!.execute({ noteId, body: 'Remember this' });
      } else {
        const result = await conductorTools.read_note!.execute({ noteId });
        resumedMemo = JSON.parse(result.content[0]!.text).memos[0].body;
      }
      return { runId: phase, status: 'finished', result: 'ok' };
    });

    const runSession = vi.fn<typeof runConductorSession>((options) =>
      runConductorSession({
        ...options,
        defaultAcp: IN_PROCESS_DEFAULT_ACP,
        connectAcp: async () => bridge,
        ownsWorkerAcpConnections: false,
        ...(phase === 'initial'
          ? {
              waitForOperatorExit: true,
              bindOperatorInput: (api: OperatorInputBindingApi) => { operatorApi = api; },
              onPostLoopWait: () => { operatorApi!.submit('/close'); },
            }
          : {}),
      }));
    const deps = {
      runConductorSession: runSession,
      loadProfile: async () => ({ profile: PING_PROFILE_BASE, profilePath: '' }),
      isOperatorInputInteractive: () => false,
      isOperatorInputTty: () => false,
      isOperatorRecoveryInspectionTty: () => false,
      writeStderr: () => {},
    };
    const options = { repoRoot, conductorCwd: cwd, name: 'run-test', maxTurns: 3 };
    expect((await executeRunCommand({ ...options, briefPath }, deps)).stopReason).toBe('completed');
    expect(noteId).toBeTruthy();
    const paths = resolveEnsemblePaths({ repoRoot });
    const saved = await loadSessionResumeStore(
      paths.workspaceSessionResumeStorePath('run-test', RESUME_AGENT_ID),
    );
    expect(saved).toBeDefined();
    const olderId = 'agent-older';
    const otherId = 'agent-other-slug';
    await saveSessionResumeStore(paths.workspaceSessionResumeStorePath('run-test', olderId), {
      ...saved!,
      conductorAgentId: olderId,
      harnessPhase: 'close',
      modifiedAt: saved!.updatedAt - 10_000,
    });
    await saveSessionResumeStore(paths.workspaceSessionResumeStorePath('other-slug', otherId), {
      ...saved!,
      conductorAgentId: otherId,
      issueUrl: 'workspace://other-slug',
      harnessPhase: 'close',
      modifiedAt: saved!.updatedAt + 10_000,
    });
    const older = await loadSessionResumeStore(paths.workspaceSessionResumeStorePath('run-test', olderId));
    const other = await loadSessionResumeStore(paths.workspaceSessionResumeStorePath('other-slug', otherId));
    expect(older!.updatedAt).toBeLessThan(saved!.updatedAt);
    expect(other!.updatedAt).toBeGreaterThan(saved!.updatedAt);
    phase = 'continue';
    expect((await executeRunCommand({ ...options, continue: true }, deps)).stopReason).toBe('completed');
    expect(runSession).toHaveBeenLastCalledWith(expect.objectContaining({
      issueUrl: 'workspace://run-test',
      resumeAgentId: RESUME_AGENT_ID,
      disableGitHubMonitor: true,
      workerWorktreeMode: 'in_repo',
    }));
    expect(resumedMemo).toBe('Remember this');
    expect(newSession).toHaveBeenCalledWith(cwd);
    expect(loadSession).toHaveBeenCalledOnce();
    expect(fetchIssue).not.toHaveBeenCalled();
    expect(monitor).not.toHaveBeenCalled();
  });

  it('starts a workspace outside git, closes and resumes with its notes and worker cwd', async () => {
    const cwd = join(repoRoot, 'workspace');
    await mkdir(cwd);
    const bridge = await createInProcessAcpBridge();
    const newSession = vi.spyOn(bridge, 'newSession');
    const loadSession = vi.spyOn(bridge, 'loadSession');
    const promptSession = vi.spyOn(bridge, 'promptSession');
    let noteId = '';
    let phase = 'initial';
    mockCreate.mockImplementation(async (options, resumeOptions) => {
      if (phase === 'failure') throw new Error('backend unavailable');
      conductorTools = (resumeOptions ?? options).customTools ?? {};
      return {
        agentId: RESUME_AGENT_ID,
        send: mockSend,
        close: mockClose,
        closeForResume: mockClose,
        getUsage: createMockConductorGetUsage(),
      };
    });
    mockSend.mockImplementation(async () => {
      if (phase === 'initial' && !noteId) {
        const result = await conductorTools.create_note!.execute({ summary: 'test' });
        noteId = JSON.parse(result.content[0]!.text).noteId;
        await conductorTools.push_memo!.execute({ noteId, body: 'saved memo' });
      } else if (phase === 'resume') {
        const result = await conductorTools.read_note!.execute({ noteId });
        expect(JSON.parse(result.content[0]!.text).memos[0].body).toBe('saved memo');
      }
      return { runId: phase, status: 'finished', result: 'ok' };
    });
    let operatorApi: OperatorInputBindingApi | undefined;
    const postLoop = vi.fn();
    const common = {
      issueUrl: 'workspace://test-workspace',
      repoRoot,
      conductorCwd: cwd,
      profile: PING_PROFILE_BASE,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      maxTurns: 3,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    };
    const first = runConductorSession({
      ...common,
      briefText: 'Investigate',
      waitForOperatorExit: true,
      onPostLoopWait: postLoop,
      bindOperatorInput: (api) => { operatorApi = api; },
    });
    await vi.waitFor(() => expect(postLoop).toHaveBeenCalledOnce());
    expect(operatorApi!.submit('/close')).toBe(false);
    expect((await first).stopReason).toBe('completed');
    expect(newSession).toHaveBeenCalledWith(cwd);
    expect(promptSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('test-workspace'),
      expect.anything(),
    );
    expect(noteId).toBeTruthy();
    const resumePath = resolveEnsemblePaths({ repoRoot })
      .workspaceSessionResumeStorePath('test-workspace', RESUME_AGENT_ID);
    const beforeFailure = await readFile(resumePath, 'utf8');
    expect((await findLatestSessionResumeStoreForWorkspace({ repoRoot, slugKey: 'test-workspace' }))?.conductorAgentId)
      .toBe(RESUME_AGENT_ID);
    expect(await listWorkspaceSlugEntries({ repoRoot })).toContainEqual(
      expect.objectContaining({ slugKey: 'test-workspace', latestConductorAgentId: RESUME_AGENT_ID }),
    );
    phase = 'failure';
    await expect(runConductorSession({ ...common, resumeAgentId: RESUME_AGENT_ID }))
      .rejects.toThrow('backend unavailable');
    expect(await readFile(resumePath, 'utf8')).toBe(beforeFailure);
    phase = 'resume';
    expect((await runConductorSession({ ...common, resumeAgentId: RESUME_AGENT_ID })).stopReason).toBe('completed');
    expect(loadSession).toHaveBeenCalled();

    // Simulate a pre-separation workspace worker whose saved session has no marker.
    const legacy = (await loadSessionResumeStore(resumePath))!;
    const oldId = legacy.workers['ping-1']!.acpSessionId;
    delete legacy.workers['ping-1']!.workspacePromptVersion;
    await saveSessionResumeStore(resumePath, legacy);
    loadSession.mockClear();
    const migrationWait = vi.fn();
    let migrationOperator: OperatorInputBindingApi | undefined;
    const migration = runConductorSession({
      ...common, resumeAgentId: RESUME_AGENT_ID, waitForOperatorExit: true,
      onPostLoopWait: migrationWait, bindOperatorInput: (api) => { migrationOperator = api; },
    });
    await vi.waitFor(async () => {
      const saved = await loadSessionResumeStore(resumePath);
      expect(saved?.workers['ping-1']?.handoffPending).toBe(true);
    });
    const migrated = (await loadSessionResumeStore(resumePath))!.workers['ping-1']!;
    expect(migrated.workspacePromptVersion).toBe(1);
    expect(migrated.acpSessionId).not.toBe(oldId);
    expect(migrated.generations).toContainEqual(expect.objectContaining({
      acpSessionId: oldId, nextSessionId: migrated.acpSessionId, reason: 'workspace_prompt_migration',
    }));
    expect(loadSession).not.toHaveBeenCalledWith(oldId, expect.anything(), expect.anything());
    await vi.waitFor(() => expect(migrationWait).toHaveBeenCalled());
    expect(migrationOperator!.submit('/close')).toBe(false);
    await migration;
    expect((await loadSessionResumeStore(resumePath))!.workers['ping-1']).toMatchObject({
      acpSessionId: migrated.acpSessionId, workspacePromptVersion: 1, handoffPending: true,
    });
    loadSession.mockClear();
    expect((await runConductorSession({ ...common, resumeAgentId: RESUME_AGENT_ID })).stopReason).toBe('completed');
    expect(loadSession).toHaveBeenCalledWith(migrated.acpSessionId, cwd, expect.anything());
    expect((await loadSessionResumeStore(resumePath))!.workers['ping-1']?.handoffPending).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('restores an attached worker and workspace state after a process receives SIGINT', async () => {
    const userRoot = join(repoRoot, 'user');
    vi.stubEnv('ENSEMBLE_USER_ROOT', userRoot);
    const fixture = fileURLToPath(new URL('./helpers/workspace-sigint-child.mjs', import.meta.url));
    const childOptions = { env: { ...process.env, HOME: repoRoot, ENSEMBLE_USER_ROOT: userRoot }, silent: true };
    const first = fork(fixture, ['initial', repoRoot], childOptions);
    const children = [first];
    const stderr: string[] = [];
    const watchErrors = (child: typeof first) => {
      child.stderr!.on('data', (chunk) => stderr.push(String(chunk)));
    };
    watchErrors(first);
    type ChildMessage = {
      type: string;
      noteId: string;
      prompts: string[];
      stopReason: string;
      readMemo: string;
      loads: Array<{ sessionId: string; cwd: string }>;
    };
    const waitMessage = (child: typeof first, type: string): Promise<ChildMessage> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.off('message', onMessage);
        child.off('exit', onExit);
        reject(new Error(`timed out waiting for ${type}\n${stderr.join('')}`));
      }, 20_000);
      const onMessage = (value: unknown) => {
        const message = value as ChildMessage;
        if (message.type !== type) return;
        clearTimeout(timeout);
        child.off('exit', onExit);
        child.off('message', onMessage);
        resolve(message);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeout);
        child.off('message', onMessage);
        reject(new Error(`child exited before ${type}: ${code}/${signal}\n${stderr.join('')}`));
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
    const waitExit = (child: typeof first) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      const ready = await waitMessage(first, 'ready');
      expect(ready.noteId).toBeTruthy();
      expect(ready.prompts).toHaveLength(1);
      const firstResult = waitMessage(first, 'result');
      const firstExit = waitExit(first);
      expect(first.kill('SIGINT')).toBe(true);
      expect((await firstResult).stopReason).toBe('interrupted');
      expect(await firstExit).toEqual({ code: 0, signal: null });

      const path = resolveEnsemblePaths({ repoRoot })
        .workspaceSessionResumeStorePath('sigint-workspace', 'sigint-test-agent');
      const saved = await loadSessionResumeStore(path);
      expect(saved).toMatchObject({
        conductorAgentId: 'sigint-test-agent',
        issueUrl: 'workspace://sigint-workspace',
        lifecycle: 'interrupted',
        harnessPhase: 'abort',
        workers: { 'ping-1': { acpSessionId: ready.prompts[0], acpCwd: repoRoot } },
      });
      expect(saved!.harnessSocketPath).toBeUndefined();
      const resumed = fork(fixture, ['resume', repoRoot, ready.noteId, ready.prompts[0]], childOptions);
      children.push(resumed);
      watchErrors(resumed);
      const resumedResult = waitMessage(resumed, 'result');
      const resumedExit = waitExit(resumed);
      const result = await resumedResult;
      expect(await resumedExit).toEqual({ code: 0, signal: null });
      expect(result.stopReason).toBe('completed');
      expect(result.readMemo).toBe('before SIGINT');
      expect(result.loads).toContainEqual(expect.objectContaining({ sessionId: ready.prompts[0], cwd: repoRoot }));
      const note = await readWorkspaceNote({
        repoRoot, slugKey: 'sigint-workspace', noteId: ready.noteId, includeHistory: true,
      });
      expect(note.memos.map((memo) => memo.body)).toEqual(['before SIGINT', 'after resume']);
      const after = await loadSessionResumeStore(path);
      expect(after!.workers['ping-1']!.acpSessionId).toBe(ready.prompts[0]);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('uses the current profile while restoring open questions and worker session/load', async () => {
    const bridge = await createInProcessAcpBridge();
    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');
    const promptSessionSpy = vi.spyOn(bridge, 'promptSession');

    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const sessionState = {
      workers: [{ name: 'ping-1', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'ping-1',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState,
      worktree,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const prompt = buildWorkerAttachPrompt(attachOptions, attached.session);
    const firstDispatch = await runAttachedWorkerPrompt(attached, prompt);
    await closeWorkerAcpSession(attached.session);
    loadSessionSpy.mockClear();
    promptSessionSpy.mockClear();

    const savedProfile: Profile = {
      ...PING_PROFILE_BASE,
      agents: {
        ping: {
          prompt: { instructions: ['stale saved worker instructions'] },
        },
      },
    };

    await saveSessionResumeStore(
      resumeStorePathForIssue(repoRoot),
      {
        version: SESSION_RESUME_STORE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        cursorBootstrapComplete: true,
        profile: savedProfile,
        openQuestions: [
          {
            id: 'inq-resume-1',
            status: 'open',
            question: 'Continue after restart?',
            responseType: 'text',
            source: 'conductor',
            askedAt: Date.now(),
          },
        ],
        sequence: 1,
        workers: {
          'ping-1': { acpSessionId: firstDispatch.acpSessionId },
        },
        updatedAt: Date.now(),
      },
    );

    let sendCount = 0;
    mockSend.mockImplementation(async () => {
      sendCount += 1;
      return {
        runId: `run-${sendCount}`,
        status: 'finished',
        result: sendCount >= 2 ? 'conductor-ok' : 'ack',
      };
    });

    const operator = createTestOperatorInputBinding((context) => {
      const question = context.openQuestions.find(
        (entry) => entry.id === 'inq-resume-1',
      );
      return question ? 'yes, continue' : undefined;
    });
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    const sessionEvents: SessionLogEvent[] = [];
    sessionLogger.subscribe((event) => sessionEvents.push(event));
    let openQuestionsAtBinding: unknown;
    const bindOperatorInput: OperatorInputBinding = (api) => {
      openQuestionsAtBinding = yaml.load(
        readFileSync(
          openQuestionsStorePath({
            repoRoot,
            conductorAgentId: RESUME_AGENT_ID,
            issueUrl: TEST_ISSUE.url,
            location: 'canonical-slug',
          }),
          'utf8',
        ),
      );
      return operator.bindOperatorInput(api);
    };

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      bindOperatorInput,
      onOpenQuestionEnqueued: operator.onOpenQuestionEnqueued,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(loadSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      expect.any(String),
      expect.any(Function),
    );
    expect(promptSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      expect.stringContaining('前回の続き'),
      expect.objectContaining({ permissionHandler: expect.any(Function) }),
    );

    const messages = mockSend.mock.calls.map((call) => String(call[0]));
    // Resume starts restored workers before the driver, so their completed
    // outcome is queued and delivered after the operator answer.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('yes, continue');
    expect(isWorkerCompletedConductorMessage(messages[1]!)).toBe(true);
    expect(messages.some((message) => message.includes('Issue #1'))).toBe(false);
    expect(openQuestionsAtBinding).toMatchObject({
      version: 1,
      sequence: 1,
      openQuestions: [
        {
          id: 'inq-resume-1',
          status: 'open',
          question: 'Continue after restart?',
        },
      ],
    });

    expect(
      result.openQuestions.find((question) => question.id === 'inq-resume-1')
        ?.status,
    ).toBe('answered');
    expect(result.workerDispatches).toHaveLength(1);
    expect(result.workerDispatches[0]?.name).toBe('ping-1');
    expect(result.workerDispatches[0]?.acpSessionId).toBe(
      firstDispatch.acpSessionId,
    );
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({
        type: 'harness.warning',
        message: expect.stringContaining(
          '保存時の team profile と現在の clone で解決した profile が異なります。以降は現在の profile を使います。',
        ),
      }),
    );
    expect(
      await loadOpenQuestionsStore(
        openQuestionsStorePath({
          repoRoot,
          conductorAgentId: RESUME_AGENT_ID,
          issueUrl: TEST_ISSUE.url,
          location: 'canonical-slug',
        }),
      ),
    ).toEqual({
      sequence: 1,
      openQuestions: result.openQuestions,
    });
  });

  it('prefers open questions YAML over the SessionResumeStore snapshot when resuming', async () => {
    await saveSessionResumeStore(
      resumeStorePathForIssue(repoRoot),
      {
        version: SESSION_RESUME_STORE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        cursorBootstrapComplete: true,
        profile: { conductor: { backend: 'cursor' }, workers: [] },
        openQuestions: [
          {
            id: 'inq-json-1',
            status: 'open',
            question: 'This stale JSON question must not be restored.',
            responseType: 'text',
            source: 'conductor',
            askedAt: 1,
          },
        ],
        sequence: 1,
        workers: {},
        updatedAt: Date.now(),
      },
    );
    const canonicalOpenQuestionsPath = openQuestionsStorePath({
      repoRoot,
      conductorAgentId: RESUME_AGENT_ID,
      issueUrl: TEST_ISSUE.url,
      location: 'canonical-slug',
    });
    await saveOpenQuestionsStore(canonicalOpenQuestionsPath, {
      sequence: 8,
      openQuestions: [
        {
          id: 'inq-yaml-8',
          status: 'open',
          question: 'This question came from YAML.',
          responseType: 'text',
          source: 'conductor',
          askedAt: 2,
        },
      ],
    });

    mockSend.mockResolvedValue({
      runId: 'run-yaml-resume',
      status: 'finished',
      result: 'recorded answer',
    });
    const operator = createTestOperatorInputBinding((context) =>
      context.openQuestions.some((question) => question.id === 'inq-yaml-8')
        ? 'answer from YAML'
        : undefined,
    );

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { conductor: { backend: 'cursor' }, workers: [] },
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      bindOperatorInput: operator.bindOperatorInput,
      onOpenQuestionEnqueued: operator.onOpenQuestionEnqueued,
    });

    expect(mockSend).toHaveBeenCalledOnce();
    expect(String(mockSend.mock.calls[0]?.[0])).toContain('answer from YAML');
    expect(result.openQuestions).toEqual([
      expect.objectContaining({
        id: 'inq-yaml-8',
        question: 'This question came from YAML.',
        status: 'answered',
        answer: 'answer from YAML',
      }),
    ]);
    expect(result.openQuestions).not.toContainEqual(
      expect.objectContaining({ id: 'inq-json-1' }),
    );
    expect(
      await loadOpenQuestionsStore(
        openQuestionsStorePath({
          repoRoot,
          conductorAgentId: RESUME_AGENT_ID,
          issueUrl: TEST_ISSUE.url,
          location: 'canonical-slug',
        }),
      ),
    ).toEqual({
      sequence: 8,
      openQuestions: result.openQuestions,
    });
  });

  it('continues resuming when the optional tool-call history is corrupt', async () => {
    const historyPath = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: RESUME_AGENT_ID,
      issueUrl: TEST_ISSUE.url,
    });
    const corruptHistory = '{invalid json';
    await saveSessionResumeStore(
      resumeStorePathForIssue(repoRoot),
      {
        version: SESSION_RESUME_STORE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        cursorBootstrapComplete: true,
        profile: { conductor: { backend: 'cursor' }, workers: [] },
        openQuestions: [],
        sequence: 0,
        workers: {},
        updatedAt: Date.now(),
      },
    );
    await writeFile(historyPath, corruptHistory, 'utf8');
    mockSend.mockResolvedValue({
      runId: 'resume-corrupt-history',
      status: 'finished',
      result: 'resumed',
    });

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => emitted.push(event));
    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: { conductor: { backend: 'cursor' }, workers: [] },
      resumeAgentId: RESUME_AGENT_ID,
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      sessionLogger,
    });

    expect(result.stopReason).toBe('completed');
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'harness.warning',
        message: expect.stringContaining('history is invalid and was discarded'),
      }),
    );
    await expect(readFile(historyPath, 'utf8')).resolves.toBe(corruptHistory);
  });

  it('dispatches permission.pending from a resumed worker without an initial send', async () => {
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
    });
    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const sessionState = {
      workers: [{ name: 'ping-1', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'ping-1',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState,
      worktree,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const firstDispatch = await runAttachedWorkerPrompt(
      attached,
      buildWorkerAttachPrompt(attachOptions, attached.session),
    );
    await closeWorkerAcpSession(attached.session);

    await saveSessionResumeStore(
      resumeStorePathForIssue(repoRoot),
      {
        version: SESSION_RESUME_STORE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        cursorBootstrapComplete: true,
        profile: PING_PROFILE_BASE,
        openQuestions: [],
        sequence: 0,
        workers: {
          'ping-1': { acpSessionId: firstDispatch.acpSessionId },
        },
        updatedAt: Date.now(),
      },
    );

    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');

    const permissionPipeline = new PermissionPipeline({
      policy: { allowTools: [], allowReadOnlyTools: false },
    });
    let sendCount = 0;
    mockSend.mockImplementation(async (message: string) => {
      sendCount += 1;
      if (message.includes('permission 判断待ち')) {
        const requestId = extractYamlScalar(message, 'id');
        expect(requestId).toBeTruthy();
        await conductorTools.resolve_permission!.execute({
          requestId: requestId!,
          decision: 'allow',
        });
        return {
          runId: `run-${sendCount}`,
          status: 'finished',
          result: 'permission resolved',
        };
      }
      if (isWorkerCompletedConductorMessage(message)) {
        return {
          runId: `run-${sendCount}`,
          status: 'finished',
          result: 'conductor-ok',
        };
      }
      throw new Error(`Unexpected resume conductor message: ${message}`);
    });

    const emitted: SessionLogEvent[] = [];
    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    sessionLogger.subscribe((event) => {
      emitted.push(event);
    });
    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      sessionLogger,
    });

    expect(loadSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      expect.any(String),
      expect.any(Function),
    );
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'permission.pending',
      permission: expect.objectContaining({
        request: expect.objectContaining({
          sessionId: firstDispatch.acpSessionId,
        }),
      }),
    }));
    const messages = mockSend.mock.calls.map((call) => String(call[0]));
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(messages[0]).toContain('permission 判断待ち');
    expect(messages[1]).toContain('worker.completed');
    expect(
      emitted
        .filter((event) => event.type === 'conductor.send.started')
        .some((event) => event.dispatchSource === 'initial'),
    ).toBe(false);
    expect(permissionPipeline.pending.size).toBe(0);
    expect(result.stopReason).toBe('completed');
    expect(result.workerDispatches).toHaveLength(1);
    expect(
      emitted.some(
        (event) =>
          event.type === 'harness.teardown.phase' && event.phase === 'workers',
      ),
    ).toBe(true);
  });

  it('restores tool-call history for permission briefs and lookup after /close and resume', async () => {
    const toolCallUpdates: Array<Record<string, unknown>> =
      permissionRequestFixtures.editPriorToolCallUpdates.map((update) => ({
        ...update,
      }));
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
      permissionParams: permissionRequestFixtures.editPermissionIdOnly,
      toolCallUpdatesBeforePermission: toolCallUpdates,
    });
    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');
    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    let phase: 'initial' | 'resume' = 'initial';
    let initialWorkerId: string | undefined;
    const closeForResume = vi.fn().mockResolvedValue(undefined);
    mockCreate.mockImplementation(async (options, resumeOptions) => {
      conductorTools = (resumeOptions ?? options).customTools ?? {};
      return {
        agentId: RESUME_AGENT_ID,
        send: mockSend,
        close: mockClose,
        closeForResume,
        getUsage: createMockConductorGetUsage(),
      };
    });

    mockSend.mockImplementation(async (message: string) => {
      if (message.includes('# permission.pending')) {
        const yamlStart = message.indexOf('```yaml\n');
        const yamlEnd = message.indexOf('\n```', yamlStart);
        const pending = yaml.load(
          message.slice(yamlStart + '```yaml\n'.length, yamlEnd),
        ) as {
          id: string;
          workerId: string;
          request: { raw: Record<string, unknown> };
          brief: {
            toolCallId: string;
            operation: { kind: string; path?: string; line?: number };
            missing: string[];
          };
        };

        if (phase === 'initial') {
          initialWorkerId = pending.workerId;
          expect(pending.brief).toMatchObject({
            toolCallId: 'call-edit-from-update',
            operation: {
              kind: 'edit',
              path: '/workspace/agents-ensemble/packages/core/src/example.ts',
              line: 27,
            },
            missing: [],
          });
          const snapshot = await conductorTools.get_tool_call!.execute({
            toolCallId: pending.brief.toolCallId,
          });
          expect(snapshot.structuredContent).toMatchObject({
            workerId: pending.workerId,
            sessionId: 'fake-session-1',
            toolCall: {
              toolCallId: 'call-edit-from-update',
              status: 'in_progress',
              locations: [
                {
                  path: '/workspace/agents-ensemble/packages/core/src/example.ts',
                  line: 27,
                },
              ],
            },
          });
        } else {
          expect(pending.workerId).not.toBe(initialWorkerId);
          expect(pending.request.raw.sessionId).toBe('fake-session-1');
          expect(pending.brief).toMatchObject({
            toolCallId: 'call-edit-from-update',
            operation: {
              kind: 'edit',
              path: '/workspace/agents-ensemble/packages/core/src/example.ts',
              line: 27,
            },
            missing: [],
          });
          const snapshot = await conductorTools.get_tool_call!.execute({
            toolCallId: pending.brief.toolCallId,
          });
          expect(snapshot.structuredContent).toMatchObject({
            workerId: pending.workerId,
            sessionId: 'fake-session-1',
            toolCall: {
              toolCallId: 'call-edit-from-update',
              status: 'in_progress',
              locations: [
                {
                  path: '/workspace/agents-ensemble/packages/core/src/example.ts',
                  line: 27,
                },
              ],
            },
          });
          const futureSnapshot = await conductorTools.get_tool_call!.execute({
            toolCallId: 'call-future-updated-at',
          });
          expect(futureSnapshot.structuredContent).toMatchObject({
            found: false,
            toolCallId: 'call-future-updated-at',
            reason: 'no_matching_snapshot',
            suggestedReads: [
              'permission.pending.request.raw',
              'permission.pending.brief.missing',
            ],
          });
        }

        await conductorTools.resolve_permission!.execute({
          requestId: pending.id,
          decision: 'allow',
        });
      }
      return {
        runId: `${phase}-run`,
        status: 'finished',
        result: 'ok',
      };
    });

    let firstOperatorApi: OperatorInputBindingApi | undefined;
    const firstPostLoopWait = vi.fn();
    const firstSessionEvents: SessionLogEvent[] = [];
    const firstSessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    firstSessionLogger.subscribe((event) => firstSessionEvents.push(event));
    const firstSessionPromise = runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({}),
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      workerWorktree: worktree,
      waitForOperatorExit: true,
      onPostLoopWait: firstPostLoopWait,
      sessionLogger: firstSessionLogger,
      bindOperatorInput: (api) => {
        firstOperatorApi = api;
      },
    });
    await vi.waitFor(() => expect(firstPostLoopWait).toHaveBeenCalledOnce());
    expect(firstOperatorApi!.submit('/close')).toBe(false);
    const firstResult = await firstSessionPromise;

    expect(firstResult.stopReason).toBe('completed');
    expect(closeForResume).toHaveBeenCalledOnce();
    expect(firstSessionEvents).toContainEqual({ type: 'session.operator_close' });
    expect(initialWorkerId).toBeTruthy();
    const initialPrompt = String(mockSend.mock.calls[0]?.[0] ?? '');
    expect(initialPrompt).toContain('permission 判断待ち');
    expect(initialPrompt).not.toContain('# permission.pending');

    const historyPath = toolCallSnapshotHistoryPath({
      repoRoot,
      conductorAgentId: RESUME_AGENT_ID,
      issueUrl: TEST_ISSUE.url,
    });
    const savedHistory = JSON.parse(await readFile(historyPath, 'utf8')) as {
      snapshots: Array<{
        workerId: string;
        workerName: string;
        sessionId: string;
      }>;
    };
    expect(savedHistory.snapshots).toContainEqual(
      expect.objectContaining({
        workerId: initialWorkerId,
        workerName: 'ping-1',
        sessionId: 'fake-session-1',
      }),
    );
    const futureEntry = {
      ...savedHistory.snapshots[0]!,
      updatedAt: Date.now() + 2 * TOOL_CALL_SNAPSHOT_HISTORY_TTL_MS,
      snapshot: {
        toolCallId: 'call-future-updated-at',
        kind: 'shell',
        rawInput: { command: 'private future command' },
        locations: [{ path: '/private/future/path' }],
      },
    };
    await writeFile(
      historyPath,
      JSON.stringify({
        ...savedHistory,
        snapshots: [...savedHistory.snapshots, futureEntry],
      }),
      'utf8',
    );

    toolCallUpdates.length = 0;
    phase = 'resume';
    const resumedResult = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: PING_PROFILE_BASE,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({}),
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      workerWorktree: worktree,
    });

    expect(resumedResult.stopReason).toBe('completed');
    expect(loadSessionSpy).toHaveBeenCalledWith(
      'fake-session-1',
      expect.any(String),
      expect.any(Function),
    );
    const rewrittenHistory = JSON.parse(await readFile(historyPath, 'utf8')) as {
      snapshots: Array<{
        snapshot: { toolCallId: string };
      }>;
    };
    expect(rewrittenHistory.snapshots).toContainEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          toolCallId: 'call-edit-from-update',
        }),
      }),
    );
    expect(rewrittenHistory.snapshots).not.toContainEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          toolCallId: 'call-future-updated-at',
        }),
      }),
    );
    expect(JSON.stringify(rewrittenHistory)).not.toContain('private future command');
    expect(JSON.stringify(rewrittenHistory)).not.toContain('/private/future/path');
  });

  it('restores worker session/load with custom workspace acpCwd on resume', async () => {
    const docsDir = join(repoRoot, 'docs-repo');
    await mkdir(docsDir, { recursive: true });
    const bridge = await createInProcessAcpBridge();
    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');

    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const workspaceProfile: Profile = {
      conductor: { backend: 'cursor' },
      agents: { ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } } },
      workers: [
        {
          name: 'librarian',
          kind: 'ping',
          workspace: 'docs-repo',
          resolvedWorkspacePath: docsDir,
        },
      ],
    };
    const sessionState = {
      workers: [{ name: 'librarian', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'librarian',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState,
      worktree,
      resolvedWorkspacePath: docsDir,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const prompt = buildWorkerAttachPrompt(attachOptions, attached.session);
    const firstDispatch = await runAttachedWorkerPrompt(attached, prompt);
    await closeWorkerAcpSession(attached.session);
    loadSessionSpy.mockClear();

    await saveSessionResumeStore(
      resumeStorePathForIssue(repoRoot),
      {
        version: SESSION_RESUME_STORE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        cursorBootstrapComplete: true,
        profile: workspaceProfile,
        openQuestions: [],
        sequence: 0,
        workers: {
          librarian: {
            acpSessionId: firstDispatch.acpSessionId,
            acpCwd: docsDir,
          },
        },
        updatedAt: Date.now(),
      },
    );

    mockSend.mockImplementation(async (message: string) => {
      if (isWorkerCompletedConductorMessage(message)) {
        return {
          runId: 'run-workspace-resume',
          status: 'finished',
          result: 'conductor-ok',
        };
      }
      return {
        runId: 'run-workspace-resume-progress',
        status: 'finished',
        result: 'ack',
      };
    });

    await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: workspaceProfile,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(loadSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      docsDir,
      expect.any(Function),
    );
  });

  it('uses the current workspace and reports a saved resume store acpCwd mismatch', async () => {
    const docsDir = join(repoRoot, 'docs-repo');
    await mkdir(docsDir, { recursive: true });
    const bridge = await createInProcessAcpBridge();
    const loadSessionSpy = vi.spyOn(bridge, 'loadSession');

    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const workspaceProfile: Profile = {
      conductor: { backend: 'cursor' },
      agents: { ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } } },
      workers: [
        {
          name: 'librarian',
          kind: 'ping',
          workspace: 'docs-repo',
          resolvedWorkspacePath: docsDir,
        },
      ],
    };
    const sessionState = {
      workers: [{ name: 'librarian', kind: 'ping' }],
      kinds: ['ping'],
    };
    const attachOptions = {
      issueUrl: TEST_ISSUE.url,
      name: 'librarian',
      kind: 'ping',
      prompt: { instructions: [PING_SYSTEM_PROMPT] },
      sessionState,
      worktree,
      resolvedWorkspacePath: docsDir,
    };
    const attached = await attachWorker({
      ...attachOptions,
      connectAcp: async () => bridge,
      ownsBridge: false,
    });
    const prompt = buildWorkerAttachPrompt(attachOptions, attached.session);
    const firstDispatch = await runAttachedWorkerPrompt(attached, prompt);
    await closeWorkerAcpSession(attached.session);

    await saveSessionResumeStore(
      resumeStorePathForIssue(repoRoot),
      {
        version: SESSION_RESUME_STORE_VERSION,
        conductorAgentId: RESUME_AGENT_ID,
        issueUrl: TEST_ISSUE.url,
        repoRoot,
        cursorBootstrapComplete: true,
        profile: workspaceProfile,
        openQuestions: [],
        sequence: 0,
        workers: {
          librarian: {
            acpSessionId: firstDispatch.acpSessionId,
            acpCwd: join(repoRoot, 'stale-workspace'),
          },
        },
        updatedAt: Date.now(),
      },
    );

    const sessionLogger = new SessionLogger({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
    });
    const sessionEvents: SessionLogEvent[] = [];
    sessionLogger.subscribe((event) => sessionEvents.push(event));

    mockSend.mockImplementation(async (message: string) => {
      if (message.includes('## worker 失敗')) {
        return {
          runId: 'run-workspace-mismatch',
          status: 'finished',
          result: 'conductor-ok',
        };
      }
      return {
        runId: 'run-workspace-mismatch-progress',
        status: 'finished',
        result: 'ack',
      };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: workspaceProfile,
      defaultAcp: IN_PROCESS_DEFAULT_ACP,
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      sessionLogger,
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
    });

    expect(result.workerFailures).toHaveLength(0);
    expect(loadSessionSpy).toHaveBeenCalledWith(
      firstDispatch.acpSessionId,
      docsDir,
      expect.any(Function),
    );
    const warningMessages = sessionEvents
      .filter((event) => event.type === 'harness.warning')
      .map((event) => event.message)
      .join('\n');
    expect(warningMessages).toContain(
      `worker「librarian」の保存時 ACP cwd ${join(repoRoot, 'stale-workspace')} と現在の workspace ${docsDir} が異なります。現在の workspace で ACP session/load を試みます。`,
    );
    expect(warningMessages).toContain(
      `worker「librarian」の保存時 ACP cwd ${join(repoRoot, 'stale-workspace')} は見つかりません。そこにだけあった未コミット変更は復元できず、保存 Store に commit SHA がないため欠落 commit の有無も照合できません。`,
    );
  });

  it('keeps the saved builtin Pi session id when resume load fails', async () => {
    const worktree = {
      ...TEST_WORKTREE,
      path: join(repoRoot, 'worktree'),
    };
    const piProfile: Profile = {
      conductor: { backend: 'cursor' },
      agents: { ping: { prompt: { instructions: [PING_SYSTEM_PROMPT] } } },
      workers: [{ name: 'pi-worker', kind: 'ping' }],
    };
    const loadSession = vi
      .fn()
      .mockRejectedValue(new Error('Unknown sessionId: saved-pi-session'));
    const newSession = vi.fn().mockResolvedValue('fresh-pi-session');
    const promptSession = vi.fn();
    const bridge = {
      loadSession,
      newSession,
      promptSession,
      close: vi.fn(),
    };
    const resumePath = resumeStorePathForIssue(repoRoot);

    await saveSessionResumeStore(resumePath, {
      version: SESSION_RESUME_STORE_VERSION,
      conductorAgentId: RESUME_AGENT_ID,
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: piProfile as never,
      cursorBootstrapComplete: true,
      openQuestions: [],
      sequence: 0,
      workers: {
        'pi-worker': {
          acpSessionId: 'saved-pi-session',
          acpCwd: worktree.path,
          acpSpawn: {
            preset: 'pi',
            command: 'node',
            args: [],
            piRuntime: 'builtin',
          },
        },
      },
      updatedAt: Date.now(),
    });

    let sendCount = 0;
    mockSend.mockImplementation(async () => ({
      runId: `run-pi-resume-failure-${sendCount++}`,
      status: 'finished',
      result: 'conductor-ok',
    }));

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot,
      profile: piProfile,
      defaultAcp: {
        defaultAcpCli: 'pi',
        config: {
          acp: {
            defaultPreset: 'pi',
            pi: { runtime: 'builtin' },
          },
        } as EnsembleConfig,
      },
      resumeAgentId: RESUME_AGENT_ID,
      maxTurns: 5,
      permissionPipeline: new PermissionPipeline({}),
      disableGitHubMonitor: true,
      disablePermissionDeadlockMonitor: true,
      connectAcp: async () => bridge as never,
      ownsWorkerAcpConnections: false,
      workerWorktree: worktree,
    });

    expect(result.workerFailures).toHaveLength(1);
    expect(result.workerFailures[0]?.name).toBe('pi-worker');
    expect(result.workerFailures[0]?.error).toMatch(
      /could not resume builtin Pi ACP session "saved-pi-session".*Refusing to start a new session without the saved context.*Unknown sessionId/u,
    );
    expect(loadSession).toHaveBeenCalledWith(
      'saved-pi-session',
      worktree.path,
      expect.any(Function),
    );
    expect(newSession).not.toHaveBeenCalled();
    expect(promptSession).not.toHaveBeenCalled();

    const savedAfterResume = await loadSessionResumeStore(resumePath);
    expect(savedAfterResume?.workers['pi-worker']?.acpSessionId).toBe(
      'saved-pi-session',
    );
  });
});

function resumeStorePathForIssue(
  repoRoot: string,
  conductorAgentId = RESUME_AGENT_ID,
): string {
  return resolveEnsemblePaths({ repoRoot }).canonicalSessionResumeStorePath(
    TEST_ISSUE.url,
    conductorAgentId,
  );
}
