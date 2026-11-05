import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Cross-package vertical test: use the real Issue command, session, and adapters;
// fake only the GitHub and backend SDK boundaries so no inference is performed.
const {
  mockCursorAgentCreate,
  mockCursorAgentResume,
  mockCursorModelList,
  mockCursorSend,
  mockPiCreateAgentSession,
  mockPiGetModel,
  mockPiSessionManagerCreate,
  mockPiSessionManagerFindById,
  mockPiSessionManagerOpen,
} = vi.hoisted(() => ({
  mockCursorAgentCreate: vi.fn(),
  mockCursorAgentResume: vi.fn(),
  mockCursorModelList: vi.fn(),
  mockCursorSend: vi.fn(),
  mockPiCreateAgentSession: vi.fn(),
  mockPiGetModel: vi.fn(),
  mockPiSessionManagerCreate: vi.fn(),
  mockPiSessionManagerFindById: vi.fn(),
  mockPiSessionManagerOpen: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Agent: {
    create: mockCursorAgentCreate,
    resume: mockCursorAgentResume,
  },
  Cursor: { models: { list: mockCursorModelList } },
  AuthenticationError: class AuthenticationError extends Error {},
  CursorAgentError: class CursorAgentError extends Error {
    isRetryable = false;
  },
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  findEnvKeys: vi.fn(() => undefined),
  getEnvApiKey: vi.fn(() => undefined),
  getModel: mockPiGetModel,
  getModels: vi.fn(() => []),
  getProviders: vi.fn(() => []),
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  const noopExtension = vi.fn(() => () => {});
  return {
    ...actual,
    createAgentSession: mockPiCreateAgentSession,
    createMcpExtension: noopExtension,
    createCodemodeExtension: noopExtension,
    createToolSearchExtension: noopExtension,
    SessionManager: {
      ...actual.SessionManager,
      create: mockPiSessionManagerCreate,
      findById: mockPiSessionManagerFindById,
      open: mockPiSessionManagerOpen,
    },
  };
});

const { mockFetchIssueContext, mockResolveGitHubAuthToken } = vi.hoisted(() => ({
  mockFetchIssueContext: vi.fn(),
  mockResolveGitHubAuthToken: vi.fn(),
}));

vi.mock('../github/issue-context.js', () => ({
  fetchIssueContext: mockFetchIssueContext,
}));

vi.mock('../github/resolve-github-auth-token.js', () => ({
  resolveGitHubAuthToken: mockResolveGitHubAuthToken,
}));

import { loadEnsembleConfig } from '../config/load-ensemble-config.js';
import { SessionLogger } from './session/session-logger.js';
import { runIssueSession as runIssueSessionImpl } from './issue-session.js';
import { executeIssueCommand } from '../../../cli/src/issue-command.js';

const issueUrl = 'https://github.com/org/repo/issues/629';
const issue = { owner: 'org', repo: 'repo', number: 629, url: issueUrl };

describe('Issue startup conductor reasoning backend wiring', () => {
  let tempRoot = '';
  let repoRoot = '';
  let userEnsembleRoot = '';
  let fakePiSession: {
    state: { messages: never[] };
    subscribe: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    bindExtensions: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    sessionManager: Record<string, ReturnType<typeof vi.fn>>;
  };
  let fakePiSessionManager: Record<string, ReturnType<typeof vi.fn>>;
  let fakeCursorAgent: {
    agentId: string;
    send: typeof mockCursorSend;
    getUsage: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    [Symbol.asyncDispose]: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-issue-reasoning-'));
    repoRoot = join(tempRoot, 'repo');
    userEnsembleRoot = join(tempRoot, 'user-ensemble');
    await mkdir(join(repoRoot, '.ensemble'), { recursive: true });
    await mkdir(join(userEnsembleRoot, 'pi'), { recursive: true });
    await mkdir(join(tempRoot, 'home', '.ensemble', 'pi'), { recursive: true });
    vi.stubEnv('HOME', join(tempRoot, 'home'));
    vi.stubEnv('CONDUCTOR_MODEL_ID', '');
    vi.stubEnv('CONDUCTOR_REASONING', '');
    vi.stubEnv('CURSOR_API_KEY', undefined);

    fakePiSessionManager = {
      getBranch: vi.fn(() => []),
      appendCustomEntry: vi.fn(),
    };
    fakePiSession = {
      state: { messages: [] },
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      sessionManager: fakePiSessionManager,
    };
    mockPiSessionManagerCreate.mockReset();
    mockPiSessionManagerCreate.mockReturnValue(fakePiSessionManager);
    mockPiSessionManagerFindById.mockReset();
    mockPiSessionManagerOpen.mockReset();
    mockPiCreateAgentSession.mockReset();
    mockPiCreateAgentSession.mockResolvedValue({ session: fakePiSession });
    mockPiGetModel.mockReset();
    mockPiGetModel.mockReturnValue({
      id: 'model-1',
      name: 'Model 1',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    });

    mockCursorAgentCreate.mockReset();
    mockCursorAgentResume.mockReset();
    mockCursorModelList.mockReset();
    mockCursorSend.mockReset();
    fakeCursorAgent = {
      agentId: 'fake-cursor-agent',
      send: mockCursorSend,
      getUsage: vi.fn().mockResolvedValue({}),
      reload: vi.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
    };
    mockCursorAgentCreate.mockResolvedValue(fakeCursorAgent);
    mockCursorAgentResume.mockResolvedValue(fakeCursorAgent);
    mockCursorModelList.mockResolvedValue([
      {
        id: 'cursor-model',
        displayName: 'Cursor model',
        parameters: [
          {
            id: 'reasoning_effort',
            displayName: 'Reasoning effort',
            values: [{ value: 'high' }],
          },
        ],
      },
    ]);
    mockCursorSend.mockResolvedValue({
      id: 'fake-cursor-run',
      wait: vi.fn().mockResolvedValue({
        status: 'finished',
        result: 'fake response',
        model: { id: 'cursor-model' },
      }),
    });

    mockFetchIssueContext.mockReset();
    mockFetchIssueContext.mockResolvedValue({
      issue,
      title: 'Reasoning wiring test',
      body: 'Fake Issue context',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    mockResolveGitHubAuthToken.mockReset();
    mockResolveGitHubAuthToken.mockResolvedValue({
      token: 'fake-github-token',
      source: 'GITHUB_TOKEN',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it.each([
    {
      backend: 'pi' as const,
      modelId: 'anthropic/model-1',
      assertAdapterCall: () => {
        expect(mockPiCreateAgentSession).toHaveBeenCalledOnce();
        expect(mockPiCreateAgentSession.mock.calls[0]?.[0]).toMatchObject({
          model: expect.objectContaining({ id: 'model-1', provider: 'anthropic' }),
          thinkingLevel: 'high',
        });
      },
    },
    {
      backend: 'cursor' as const,
      modelId: 'cursor-model',
      assertAdapterCall: () => {
        expect(mockCursorModelList).toHaveBeenCalledOnce();
        expect(mockCursorAgentCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            model: {
              id: 'cursor-model',
              params: [{ id: 'reasoning_effort', value: 'high' }],
            },
          }),
        );
      },
    },
  ])(
    'resolves merged config and passes reasoning through the $backend adapter',
    async ({ backend, modelId, assertAdapterCall }) => {
      await writeFile(
        join(userEnsembleRoot, 'config.yaml'),
        [
          'conductor:',
          '  model: stale-user-model',
          '  reasoning: low',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(repoRoot, '.ensemble', 'config.yaml'),
        [
          'conductor:',
          `  backend: ${backend}`,
          `  model: ${modelId}`,
          '  reasoning: high',
          '',
        ].join('\n'),
      );

      const result = await executeIssueCommand(
        issueUrl,
        {
          repoRoot,
          conductorCwd: repoRoot,
          worktree: 'in_repo',
          noWait: true,
          githubMonitor: false,
        },
        {
          isOperatorInputInteractive: () => false,
          isOperatorInputTty: () => false,
          loadEnsembleConfig: (root, options) =>
            loadEnsembleConfig(root, {
              ...options,
              userEnsembleRoot,
              writeStderr: () => {},
            }),
          loadProfile: async () => ({
            profile: { workers: [] },
            profilePath: 'reasoning-wiring-test',
          }),
          runIssueSession: (options) =>
            runIssueSessionImpl({
              ...options,
              mcpConfigOptions: { userEnsembleRoot },
              workerWorktree: {
                path: repoRoot,
                branch: 'test',
                issue,
                inRepo: true,
              },
              registerProcessSignalHandlers: false,
            }),
          SessionLogger,
          writeStderr: () => {},
        },
      );

      assertAdapterCall();
      expect(result.sessionModels.conductor).toMatchObject({
        backend,
        configuredModelId: modelId,
        configuredReasoning: 'high',
      });
      expect(mockFetchIssueContext).toHaveBeenCalledOnce();
    },
  );
});
