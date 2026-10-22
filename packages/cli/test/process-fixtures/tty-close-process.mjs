import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeIssueCommand } from '../../dist/issue-command.js';
import { DEFAULT_ENSEMBLE_CONFIG } from '../../../core/dist/config/defaults.js';
import { runConductorSession } from '../../../core/dist/conductor/conductor-session.js';

const issueUrl = 'https://github.com/org/repo/issues/1';
const repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-close-process-'));
const userEnsembleRoot = await mkdtemp(
  join(tmpdir(), 'ensemble-close-process-user-'),
);
execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'tty-close@example.test'], {
  cwd: repoRoot,
  stdio: 'ignore',
});
execFileSync('git', ['config', 'user.name', 'TTY close process test'], {
  cwd: repoRoot,
  stdio: 'ignore',
});
execFileSync('git', ['commit', '--allow-empty', '-m', 'Initialize process test'], {
  cwd: repoRoot,
  stdio: 'ignore',
});
const config = structuredClone(DEFAULT_ENSEMBLE_CONFIG);
config.github.monitor.enabled = true;
config.github.monitor.debounceMs = 60_000;
config.github.monitor.pollIntervalMs = 60_000;
config.github.monitor.activePollIntervalMs = 60_000;
config.github.monitor.stopPollWaitMs = 250;
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
  if (pathname === '/search/issues') {
    return Response.json({ items: [] });
  }
  throw new Error(`Unexpected GitHub API request: ${pathname}`);
};

let workerPromptStarted = false;
let operatorInputBound = false;
let inputReadyWritten = false;
let workerProcessPid;
const workerWorktreePath = join(repoRoot, '.ensemble', 'worktrees', 'issue-1');
let conductorClosed = false;
const teardownPhases = [];

function writeInputReadyWhenTuiAndWorkerAreReady() {
  if (workerPromptStarted && operatorInputBound && !inputReadyWritten) {
    inputReadyWritten = true;
    process.stdout.write('\nTTY_CLOSE_INPUT_READY\n');
  }
}

const conductor = {
  agentId: 'close-process-agent',
  send: async () => ({
    runId: 'close-process-run',
    status: 'finished',
    result: 'done',
  }),
  close: async () => {
    conductorClosed = true;
  },
  getUsage: async () => ({}),
};
const conductorAgentFactory = {
  create: async () => conductor,
  resume: async () => conductor,
};

try {
  const result = await executeIssueCommand(
    issueUrl,
    {
      repoRoot,
      conductorCwd: repoRoot,
      worktree: 'isolated',
      defaultAcpCommand: process.execPath,
      defaultAcpArgs: [
        fileURLToPath(new URL('./tty-close-acp.mjs', import.meta.url)),
      ],
    },
    {
      loadEnsembleConfig: async () => config,
      loadProfile: async () => ({
        profile: {
          workers: [{ name: 'implementer', kind: 'implementer' }],
        },
      }),
      runIssueSession: (sessionOptions) => {
        sessionOptions.sessionLogger?.subscribe((event) => {
          if (event.type === 'harness.teardown.phase') {
            teardownPhases.push(event.phase);
          }
          if (
            event.type === 'worker.process.stderr' &&
            event.line.startsWith('TTY_CLOSE_ACP_PROMPT pid=')
          ) {
            workerProcessPid = Number(event.line.split('=')[1]);
            workerPromptStarted = true;
            writeInputReadyWhenTuiAndWorkerAreReady();
          }
        });
        return runConductorSession({
          ...sessionOptions,
          ensembleConfig: config,
          mcpConfigOptions: { userEnsembleRoot },
          conductorAgentFactory,
          registerProcessSignalHandlers: false,
          bindOperatorInput: (api) => {
            const dispose = sessionOptions.bindOperatorInput?.({
              getContext: () => api.getContext(),
              submit: (message, submitOptions) => {
                const accepted = api.submit(message, submitOptions);
                if (message.trim().toLowerCase() === '/close') {
                  process.stdout.write(
                    `TTY_CLOSE_SUBMITTED accepted=${accepted}\n`,
                  );
                }
                return accepted;
              },
            });
            operatorInputBound = true;
            writeInputReadyWhenTuiAndWorkerAreReady();
            return dispose;
          },
        });
      },
    },
  );

  if (result.stopReason !== 'completed') {
    throw new Error(`Unexpected /close stop reason: ${result.stopReason}`);
  }
  if (!Number.isInteger(workerProcessPid)) {
    throw new Error('TTY /close did not start the child ACP worker process');
  }
  try {
    process.kill(workerProcessPid, 0);
    throw new Error(
      `TTY /close returned while child ACP worker ${workerProcessPid} was still alive`,
    );
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
  if (!conductorClosed) {
    throw new Error('TTY /close did not close the conductor');
  }
  if (!workerWorktreePath || !existsSync(workerWorktreePath)) {
    throw new Error('TTY /close did not preserve the Issue worktree');
  }
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const registeredWorktreePath = await realpath(workerWorktreePath);
  if (!worktrees.includes(`worktree ${registeredWorktreePath}\n`)) {
    throw new Error('TTY /close removed the Issue worktree registration');
  }
  const resumeStorePath = join(
    repoRoot,
    '.ensemble',
    'sessions',
    'close-process-agent.json',
  );
  const resumeStore = JSON.parse(await readFile(resumeStorePath, 'utf8'));
  if (
    resumeStore.workers?.implementer?.acpSessionId !== 'tty-worker-session' ||
    resumeStore.workers?.implementer?.acpCwd !== workerWorktreePath
  ) {
    throw new Error('TTY /close did not persist the worker ACP session');
  }
  if (
    !['githubMonitor', 'workers', 'conductor'].every((phase) =>
      teardownPhases.includes(phase),
    )
  ) {
    throw new Error(
      `TTY /close did not complete production teardown phases: ${teardownPhases.join(', ')}`,
    );
  }
  if (teardownPhases.includes('worktree')) {
    throw new Error('TTY /close entered the worktree cleanup phase');
  }
  process.stdout.write('close-process-session-completed\n');
} finally {
  await rm(repoRoot, { recursive: true, force: true });
  await rm(userEnsembleRoot, { recursive: true, force: true });
}
