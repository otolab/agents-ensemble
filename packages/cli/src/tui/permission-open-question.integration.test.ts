import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./operator-text-area.js', () => import('./operator-text-area.test-double.js'));

import React from 'react';
import yaml from 'js-yaml';
import { cleanup, render } from 'ink-testing-library';
import { PermissionPipeline, type OpenQuestion } from '@agents-ensemble/core';
import * as issueContextModule from '../../../core/src/github/issue-context.js';
import * as worktreeModule from '../../../core/src/worktree/worktree.js';
import { runConductorSession } from '../../../core/src/conductor/conductor-session.js';
import type { ConductorAgentFactory } from '../../../core/src/conductor/conductor-agent.js';
import { createMockConductorGetUsage } from '../../../core/src/testing/mock-conductor-get-usage.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from '../../../core/test/integration/helpers/in-process-acp-bridge.js';
import { permissionRequestFixtures } from '../../../core/test/fixtures/permission-request-fixtures.js';
import type { Profile } from '../../../core/src/profile/types.js';
import { createTuiViewModel } from './tui-view-model.js';
import { IssueSessionTui } from './issue-session-tui.js';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;

const IMPLEMENTER_PROFILE: Profile = {
  agents: {
    implementer: { prompt: { instructions: [PING_SYSTEM_PROMPT] } },
  },
  workers: [{ name: 'implementer-1', kind: 'implementer' }],
};

const { mockSend, mockClose } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  return { mockSend, mockClose };
});

let conductorTools: Record<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }> = {};

describe('permission summary in the TTY Open Questions pane', () => {
  beforeEach(() => {
    vi.spyOn(issueContextModule, 'fetchIssueContext').mockResolvedValue({
      issue: TEST_ISSUE,
      title: 'Integration open question',
      body: 'body',
      state: 'OPEN',
      labels: [],
      comments: [],
    });
    vi.spyOn(worktreeModule, 'resolveWorkerWorkspace').mockResolvedValue(TEST_WORKTREE);

    mockSend.mockReset();
    mockClose.mockClear();
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 24 });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: 'rawInput path',
      permissionParams: permissionRequestFixtures.editCursorAcpV1.params,
    },
    {
      label: 'locations fallback',
      permissionParams:
        permissionRequestFixtures.editCursorAcpV1LocationsOnly.params,
    },
  ])('shows the same ACP v1 Edit request id and summary through TTY for $label', async ({
    permissionParams,
  }) => {
    const bridge = await createInProcessAcpBridge(undefined, {
      requestPermissionOnPrompt: true,
      permissionParams,
    });
    let pendingId: string | undefined;
    let questionAtEnqueue: OpenQuestion | undefined;
    let sendCount = 0;
    let operatorApi:
      | {
          getContext: () => { openQuestions: OpenQuestion[] };
          submit: (message: string) => boolean;
        }
      | undefined;
    const conductorAgentFactory: ConductorAgentFactory = {
      create: async ({ customTools }) => {
        conductorTools = customTools ?? {};
        return {
          agentId: 'agent-test',
          send: mockSend,
          reload: async () => {},
          getUsage: createMockConductorGetUsage(),
          setSystemPrompt: async () => {},
          close: mockClose,
        };
      },
      resume: async (_agentId, options) => conductorAgentFactory.create(options),
    };

    mockSend.mockImplementation(async (message: string) => {
      sendCount++;
      if (sendCount === 1) {
        await conductorTools.prompt_worker!.execute({
          worker: 'implementer-1',
          instruction: 'Perform the requested work.',
        });
        return { runId: 'run-dispatch', status: 'finished', result: 'worker sent' };
      }

      if (message.includes('permission 判断待ち')) {
        const yamlStart = message.indexOf('```yaml\n');
        const yamlEnd = message.indexOf('\n```', yamlStart);
        const permissionEvent = yaml.load(
          message.slice(yamlStart + '```yaml\n'.length, yamlEnd),
        ) as {
          id: string;
          workerId: string;
          request: { toolName: string };
          operatorSummary: string;
        };
        pendingId = permissionEvent.id;
        expect(permissionEvent.workerId).toBeTruthy();
        expect(permissionEvent.request.toolName).toBe('Edit');
        expect(permissionEvent.operatorSummary).toBe(
          `permission.pending worker=implementer tool=Edit ` +
            'path=packages/core/src/permission/format-permission-summary-for-operator.ts ' +
            `description="Edit File" id=${pendingId.slice(0, 8)}...`,
        );

        await conductorTools.ask_human!.execute({
          question: 'Should I allow this file edit?',
          responseType: 'yes_no',
          context: 'The Edit permission is waiting.',
          relatedPermissionId: pendingId,
        });
        return { runId: 'run-permission', status: 'finished', result: 'question registered' };
      }

      if (message.includes('【open question 回答】')) {
        await conductorTools.resolve_permission!.execute({
          requestId: pendingId,
          decision: 'deny',
        });
        return { runId: 'run-deny-permission', status: 'finished', result: 'denied' };
      }

      return { runId: `run-${sendCount}`, status: 'finished', result: 'worker completed' };
    });

    const result = await runConductorSession({
      issueUrl: TEST_ISSUE.url,
      repoRoot: REPO_ROOT,
      profile: IMPLEMENTER_PROFILE,
      conductorAgentFactory,
      maxTurns: 10,
      permissionPipeline: new PermissionPipeline({
        policy: { allowTools: [], allowReadOnlyTools: false },
      }),
      connectAcp: async () => bridge,
      ownsWorkerAcpConnections: false,
      bindOperatorInput: (api) => {
        operatorApi = api;
      },
      onOpenQuestionEnqueued: () => {
        const context = operatorApi?.getContext();
        questionAtEnqueue = context?.openQuestions.find(
          (question) => question.relatedPermissionId === pendingId,
        );
        operatorApi?.submit('no');
      },
    });

    expect(pendingId).toBeTruthy();
    expect(questionAtEnqueue).toMatchObject({
      relatedPermissionId: pendingId,
      context: expect.stringContaining(
        `permission.pending worker=implementer tool=Edit path=packages/core/src/permission/format-permission-summary-for-operator.ts`,
      ),
    });

    const viewModel = createTuiViewModel();
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: 10,
      openQuestions: [questionAtEnqueue!],
    });
    const { lastFrame } = render(
      React.createElement(IssueSessionTui, { viewModel, onSubmit: () => {} }),
    );
    const visibleFrame = (lastFrame() ?? '').replace(/\s+/gu, ' ');
    expect(visibleFrame).toContain(
      `▸ ${questionAtEnqueue!.id} [yes_no] Should I allow this file edit?`,
    );
    expect(visibleFrame).toContain('permission.pending worker=implementer tool=Edit');
    expect(visibleFrame).toContain(
      'path=packages/core/src/permission/format-permission-summary-for-operator.ts',
    );
    expect(visibleFrame).toContain('description="Edit');
    expect(visibleFrame).toContain('File"');
    expect(visibleFrame).toContain(`id=${pendingId!.slice(0, 8)}...`);
    expect(visibleFrame).toContain('The Edit permission is waiting.');
    expect(result.workerFailures).toHaveLength(0);
  });
});
