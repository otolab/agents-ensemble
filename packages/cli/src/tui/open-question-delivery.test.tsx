import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  element: undefined as React.ReactElement | undefined,
  send: vi.fn(),
  close: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('ink', async (importOriginal) => {
  const ink = await importOriginal<typeof import('ink')>();
  return {
    ...ink,
    render: (element: React.ReactElement, options: Parameters<typeof ink.render>[1]) => {
      if (options && 'debug' in options && options.debug) return ink.render(element, options);
      mocks.element = element;
      return { unmount: vi.fn(), clear: vi.fn() };
    },
  };
});
vi.mock('./operator-text-area.js', () => import('./operator-text-area.test-double.js'));
vi.mock('../../../core/src/conductor/cursor-sdk-conductor-agent.js', () => ({
  createCursorSdkConductorAgentFactory: () => ({ create: mocks.resume, resume: mocks.resume }),
}));
vi.mock('../../../core/src/github/issue-context.js', () => ({
  fetchIssueContext: vi.fn(async () => ({
    issue: { owner: 'org', repo: 'repo', number: 1, url: 'https://github.com/org/repo/issues/1' },
    title: 'Test', body: 'body', state: 'OPEN', labels: [], comments: [],
  })),
}));
vi.mock('../../../core/src/github/resolve-github-auth-token.js', () => ({
  resolveGitHubAuthToken: vi.fn(async () => ({ token: 'test', source: 'GITHUB_TOKEN' })),
}));
vi.mock('../../../core/src/github/github-monitor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../core/src/github/github-monitor.js')>(),
  createGitHubMonitor: () => ({
    start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), flush: vi.fn(),
    getCursor: () => ({ pullRequests: {} }), acknowledgeUpdates: vi.fn(),
    registerPullRequest: vi.fn(), unregisterPullRequest: vi.fn(),
  }),
}));

import { cleanup, render } from 'ink-testing-library';
import { createIssueSessionTuiHost } from './create-issue-session-tui-host.js';
import { flushInkStdin } from './ink-test-keys.js';
import { runConductorSession } from '../../../core/src/conductor/conductor-session.js';
import { DEFAULT_ENSEMBLE_CONFIG } from '../../../core/src/config/defaults.js';
import type { OperatorInputBindingApi } from '../../../core/src/conductor/operator-input-binding.js';
import { PermissionPipeline } from '../../../core/src/permission/permission-pipeline.js';
import { resolveEnsemblePaths } from '../../../core/src/ensemble-paths.js';
import { saveSessionResumeStore, SESSION_RESUME_STORE_VERSION } from '../../../core/src/session/session-resume-store.js';
import { SessionOwnership } from '../../../core/src/session/session-ownership.js';

const issueUrl = 'https://github.com/org/repo/issues/1';
let tempRoot = '';
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

afterEach(async () => {
  cleanup();
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  vi.unstubAllEnvs();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

it('delivers TUI answers through the host and core to conductor without running commands', async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'ensemble-tui-answer-'));
  vi.stubEnv('HOME', tempRoot);
  vi.stubEnv('ENSEMBLE_OPERATOR_MESSAGE', '');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const agentId = 'answer-test';
  const inputs = [
    { input: 'close', id: 'close', label: 'Close option' },
    { input: 'exit', id: 'exit', label: 'Exit option' },
    { input: 'reconnect', id: 'reconnect', label: 'Reconnect option' },
    { input: 'close', id: 'option-close', label: 'close' },
    { input: 'exit', id: 'option-exit', label: 'exit' },
    { input: 'reconnect', id: 'option-reconnect', label: 'reconnect' },
    { input: '/recovery continue', id: '/recovery continue', label: 'Recovery' },
    { input: '/idle keep', id: '/idle keep', label: 'Delivery' },
    { input: '/recovery continue', id: '/recovery continue', label: '', text: true },
  ];
  const questions = inputs.map((item, index) => ({
    id: `inq-${index}`, question: 'Choose',
    responseType: 'text' in item ? 'text' as const : 'choice' as const,
    ...('text' in item ? {} : { choices: [{ id: item.id, label: item.label }] }),
    source: 'conductor' as const,
    status: 'open' as const, askedAt: index + 1,
  }));
  const storePath = resolveEnsemblePaths({ repoRoot: tempRoot }).canonicalSessionResumeStorePath(issueUrl, agentId);
  const owner = await SessionOwnership.acquire(storePath);
  await owner.runWrite((lease) => saveSessionResumeStore(storePath, {
    version: SESSION_RESUME_STORE_VERSION, conductorAgentId: agentId, issueUrl, repoRoot: tempRoot,
    profile: { workers: [] }, openQuestions: questions, sequence: questions.length,
    workers: {}, updatedAt: 0, conductorBackend: 'cursor', cursorBootstrapComplete: true,
  }, owner, lease));
  await owner.closeWritesAndDrain();
  owner.release();
  mocks.send.mockReset().mockResolvedValue({ runId: 'run', status: 'finished', result: 'done' });
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.resume.mockReset().mockResolvedValue({
    agentId, send: mocks.send, close: mocks.close,
    getUsage: vi.fn().mockResolvedValue({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] }),
  });
  const host = createIssueSessionTuiHost(undefined, { env: { ENSEMBLE_TUI_LAYOUT: 'pane' } });
  const tui = render(mocks.element!);
  let bound = false;
  let api: OperatorInputBindingApi | undefined;
  const session = runConductorSession({
    issueUrl, repoRoot: tempRoot, profile: { workers: [] }, resumeAgentId: agentId,
    ensembleConfig: { ...DEFAULT_ENSEMBLE_CONFIG, conductor: { ...DEFAULT_ENSEMBLE_CONFIG.conductor, backend: 'cursor' } },
    mcpConfigOptions: { userEnsembleRoot: join(tempRoot, 'user') },
    maxTurns: 20, permissionPipeline: new PermissionPipeline({}),
    registerProcessSignalHandlers: false, waitForOperatorExit: true,
    bindOperatorInput: (binding) => { api = binding; const dispose = host.bindOperatorInput(binding); bound = true; return dispose; },
  });
  try {
    await vi.waitFor(() => expect(bound).toBe(true));
    for (const [index, item] of inputs.entries()) {
      host.notifyReprompt();
      await flushInkStdin();
      tui.stdin.write(item.input);
      await flushInkStdin();
      tui.stdin.write('\r');
      await flushInkStdin();
      // Choice suggestions complete on the first Enter; slash-prefixed input submits directly.
      if (!item.input.startsWith('/')) {
        tui.stdin.write('\r');
        await flushInkStdin();
      }
      await vi.waitFor(() => expect(mocks.send.mock.calls.some(([text]) => String(text).includes(`【open question 回答】inq-${index}: Choose → ${item.id} (by operator)`))).toBe(true));
    }
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  } finally {
    api?.submit('/close');
    await session;
    tui.unmount();
    host.dispose();
  }
}, 30_000);
