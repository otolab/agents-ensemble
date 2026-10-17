import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeIssueCommand } from '../../dist/issue-command.js';
import { DEFAULT_ENSEMBLE_CONFIG } from '../../../core/dist/config/defaults.js';
import { runConductorSession } from '../../../core/dist/conductor/conductor-session.js';

const issueUrl = 'https://github.com/org/repo/issues/1';
const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-close-process-'));
const userEnsembleRoot = await mkdtemp(
  join(tmpdir(), 'ensemble-close-process-user-'),
);
Object.defineProperty(process.stdin, 'isTTY', {
  configurable: true,
  value: true,
});
process.stdin.setRawMode = () => process.stdin;
const config = structuredClone(DEFAULT_ENSEMBLE_CONFIG);
config.github.monitor.enabled = false;
config.github.auth.allowGhAuthTokenFallback = false;
process.env.GITHUB_TOKEN = 'process-test-token';

globalThis.fetch = async (input) => {
  const { pathname } = new URL(String(input));
  if (pathname === '/repos/org/repo/issues/1') {
    return Response.json({
      title: 'Close process test',
      body: '',
      state: 'open',
      labels: [],
    });
  }
  if (pathname === '/repos/org/repo/issues/1/comments') {
    return Response.json([]);
  }
  if (pathname === '/user') {
    return Response.json({ login: 'process-test' });
  }
  throw new Error(`Unexpected GitHub API request: ${pathname}`);
};

const conductor = {
  agentId: 'close-process-agent',
  send: async () => ({
    runId: 'close-process-run',
    status: 'finished',
    result: 'done',
  }),
  close: async () => {},
  getUsage: async () => ({}),
};
const conductorAgentFactory = {
  create: async () => conductor,
  resume: async () => conductor,
};

let operatorApi;
try {
  const result = await executeIssueCommand(
    issueUrl,
    {
      repoRoot,
      conductorCwd: repoRoot,
      worktree: 'in_repo',
      githubMonitor: false,
    },
    {
      isOperatorInputInteractive: () => true,
      isOperatorInputTty: () => true,
      loadEnsembleConfig: async () => config,
      loadProfile: async () => ({ profile: { workers: [] } }),
      runIssueSession: (sessionOptions) =>
        runConductorSession({
          ...sessionOptions,
          ensembleConfig: config,
          mcpConfigOptions: { userEnsembleRoot },
          conductorAgentFactory,
          registerProcessSignalHandlers: false,
          bindOperatorInput: (api) => {
            operatorApi = api;
            return sessionOptions.bindOperatorInput?.(api);
          },
          onPostLoopWait: () => {
            operatorApi.submit('/close');
          },
        }),
    },
  );

  if (result.stopReason !== 'completed') {
    throw new Error(`Unexpected /close stop reason: ${result.stopReason}`);
  }
  process.stdout.write('close-process-session-completed\n');
} finally {
  await rm(repoRoot, { recursive: true, force: true });
  await rm(userEnsembleRoot, { recursive: true, force: true });
}
