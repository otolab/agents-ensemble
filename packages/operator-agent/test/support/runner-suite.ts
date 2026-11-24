import { resolveEnsemblePaths } from '@agents-ensemble/core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, vi } from 'vitest';
import { waitForNotification } from './wait.js';

interface WatchPollHarness {
  pending: Set<Promise<unknown>>;
  onCompleted: ((id: string, count: number) => void) | undefined;
  onAcknowledged: (() => void) | undefined;
}

export function setupRunnerSuite(watchPollHarness: WatchPollHarness) {
let repoRoot = '';
  let closeServers: Array<() => Promise<void>> = [];
  let preserveFixture = false;
  let originalModelEnv: string | undefined;
  let originalReasoningEnv: string | undefined;
  let originalProfileEnv: string | undefined;
  let originalOperatorModelEnv: string | undefined;
  let originalOperatorBackendEnv: string | undefined;
  let originalOperatorReasoningEnv: string | undefined;
  let originalOperatorProfileEnv: string | undefined;
  let originalUserRootEnv: string | undefined;
  let originalNoColorEnv: string | undefined;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-agent-'));
    vi.stubEnv('HOME', repoRoot);
    originalUserRootEnv = process.env.ENSEMBLE_USER_ROOT;
    vi.stubEnv('ENSEMBLE_USER_ROOT', join(repoRoot, '.ensemble'));
    originalModelEnv = process.env.CONDUCTOR_MODEL_ID;
    originalReasoningEnv = process.env.CONDUCTOR_REASONING;
    originalProfileEnv = process.env.ENSEMBLE_DEFAULT_PROFILE;
    originalOperatorModelEnv = process.env.ENSEMBLE_OPERATOR_AGENT_MODEL;
    originalOperatorBackendEnv = process.env.ENSEMBLE_OPERATOR_AGENT_BACKEND;
    originalOperatorReasoningEnv = process.env.ENSEMBLE_OPERATOR_AGENT_REASONING;
    originalOperatorProfileEnv = process.env.ENSEMBLE_OPERATOR_AGENT_PROFILE;
    originalNoColorEnv = process.env.NO_COLOR;
    delete process.env.CONDUCTOR_MODEL_ID;
    delete process.env.CONDUCTOR_REASONING;
    delete process.env.ENSEMBLE_DEFAULT_PROFILE;
    delete process.env.ENSEMBLE_OPERATOR_AGENT_MODEL;
    delete process.env.ENSEMBLE_OPERATOR_AGENT_BACKEND;
    delete process.env.ENSEMBLE_OPERATOR_AGENT_REASONING;
    delete process.env.ENSEMBLE_OPERATOR_AGENT_PROFILE;
    delete process.env.NO_COLOR;
    await mkdir(join(repoRoot, '.ensemble', 'teams', 'smoke'), { recursive: true });
    await mkdir(join(repoRoot, '.ensemble', 'sessions'), { recursive: true });
    await writeFile(
      join(repoRoot, '.ensemble', 'operator-agents.config.yaml'),
      [
        'version: 1',
        'defaultProfile: smoke',
        'common:',
        '  conductor:',
        '    backend: pi',
        '    model: smoke-model',
        '  pi:',
        '    agentDir: pi-user',
        'profiles:',
        '  smoke:',
        '    prompt:',
        '      instructions:',
        '        - Profile operator guidance.',
        '    pi:',
        '      projectDir: pi-project',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repoRoot, '.ensemble', 'sessions', 'conductor-one.json'),
      JSON.stringify({
        version: 1,
        conductorAgentId: 'conductor-one',
        conductorBackend: 'pi',
        issueUrl: 'https://github.com/example/project/issues/12',
        repoRoot,
        profile: { workers: [], agents: {} },
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Approve this operation?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 1,
            relatedPermissionId: 'permission-1',
          },
        ],
        sequence: 1,
        workers: { implementer: { acpSessionId: 'worker-one' } },
        updatedAt: 100,
      }),
    );
    const issueUrl = 'https://github.com/example/project/issues/12';
    const canonicalStorePath = resolveEnsemblePaths({ repoRoot })
      .canonicalSessionResumeStorePath(issueUrl, 'conductor-one');
    await mkdir(dirname(canonicalStorePath), { recursive: true });
    await writeFile(
      canonicalStorePath,
      JSON.stringify({
        version: 1,
        conductorAgentId: 'conductor-one',
        conductorBackend: 'pi',
        issueUrl,
        repoRoot,
        profile: { workers: [], agents: {} },
        openQuestions: [
          {
            id: 'inq-1',
            question: 'Approve this operation?',
            responseType: 'yes_no',
            source: 'conductor',
            status: 'open',
            askedAt: 1,
            relatedPermissionId: 'permission-1',
          },
        ],
        sequence: 1,
        workers: { implementer: { acpSessionId: 'worker-one' } },
        updatedAt: 100,
      }),
    );
  });

  afterEach(async () => {
    watchPollHarness.onCompleted = undefined;
    watchPollHarness.onAcknowledged = undefined;
    const closeErrors: string[] = [];
    try {
      await waitForNotification((async () => {
        while (watchPollHarness.pending.size > 0) {
          await Promise.allSettled([...watchPollHarness.pending]);
        }
      })(), 'pending watch polls', 5_000);
    } catch (error) {
      preserveFixture = true;
      closeErrors.push(`${String(error)}; pending polls: ${watchPollHarness.pending.size}`);
    }
    for (const close of closeServers) {
      try {
        await waitForNotification(close(), 'server close', 2_000);
      } catch (error) {
        preserveFixture = true;
        closeErrors.push(String(error));
      }
    }
    closeServers = [];
    if (originalModelEnv === undefined) {
      delete process.env.CONDUCTOR_MODEL_ID;
    } else {
      process.env.CONDUCTOR_MODEL_ID = originalModelEnv;
    }
    if (originalReasoningEnv === undefined) {
      delete process.env.CONDUCTOR_REASONING;
    } else {
      process.env.CONDUCTOR_REASONING = originalReasoningEnv;
    }
    if (originalProfileEnv === undefined) {
      delete process.env.ENSEMBLE_DEFAULT_PROFILE;
    } else {
      process.env.ENSEMBLE_DEFAULT_PROFILE = originalProfileEnv;
    }
    if (originalOperatorModelEnv === undefined) {
      delete process.env.ENSEMBLE_OPERATOR_AGENT_MODEL;
    } else {
      process.env.ENSEMBLE_OPERATOR_AGENT_MODEL = originalOperatorModelEnv;
    }
    if (originalOperatorBackendEnv === undefined) {
      delete process.env.ENSEMBLE_OPERATOR_AGENT_BACKEND;
    } else {
      process.env.ENSEMBLE_OPERATOR_AGENT_BACKEND = originalOperatorBackendEnv;
    }
    if (originalOperatorReasoningEnv === undefined) {
      delete process.env.ENSEMBLE_OPERATOR_AGENT_REASONING;
    } else {
      process.env.ENSEMBLE_OPERATOR_AGENT_REASONING = originalOperatorReasoningEnv;
    }
    if (originalOperatorProfileEnv === undefined) {
      delete process.env.ENSEMBLE_OPERATOR_AGENT_PROFILE;
    } else {
      process.env.ENSEMBLE_OPERATOR_AGENT_PROFILE = originalOperatorProfileEnv;
    }
    if (originalUserRootEnv === undefined) {
      delete process.env.ENSEMBLE_USER_ROOT;
    } else {
      process.env.ENSEMBLE_USER_ROOT = originalUserRootEnv;
    }
    if (originalNoColorEnv === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColorEnv;
    }
    if (!preserveFixture) await rm(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    if (preserveFixture) {
      preserveFixture = false;
      throw new Error(`fixture preserved at ${repoRoot}; ${closeErrors.join('; ')}`);
    }
  });
  return {
    get repoRoot() { return repoRoot; },
    get closeServers() { return closeServers; },
    get preserveFixture() { return preserveFixture; },
    set preserveFixture(value: boolean) { preserveFixture = value; },
  };
}
