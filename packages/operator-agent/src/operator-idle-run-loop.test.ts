import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveEnsemblePaths,
  startOpenQuestionControlServer,
  type SessionObservationSnapshot,
} from '@agents-ensemble/core';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
} from '@agents-ensemble/core/operator-runtime';
import { runOperatorAgent } from './run-operator-agent.js';
import { operatorWatchStatePath } from './operator-watch-pool.js';

const tuiHarness = vi.hoisted(() => ({
  onSubmit: undefined as ((message: string) => void) | undefined,
  readyResolvers: [] as Array<(submit: (message: string) => void) => void>,
}));

vi.mock('./operator-agent-tui.js', () => ({
  createOperatorAgentTuiHost: (options: {
    onSubmit: (message: string) => void;
  }) => {
    tuiHarness.onSubmit = options.onSubmit;
    for (const resolve of tuiHarness.readyResolvers.splice(0)) {
      resolve(options.onSubmit);
    }
    return {
      appendChannel: () => {},
      appendUserMessage: () => {},
      appendOperatorResponse: () => {},
      setInputEnabled: () => {},
      dispose: async () => {},
    };
  },
}));

describe('operator idle candidate dispatch run loop', () => {
  let repoRoot = '';
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
    tuiHarness.onSubmit = undefined;
    tuiHarness.readyResolvers = [];
    vi.restoreAllMocks();
  });

  it('compares baseline and integrated sends through runOperatorAgent with a fake clock', async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'ensemble-operator-idle-run-loop-'));
    const userRoot = join(repoRoot, '.ensemble');
    await mkdir(join(userRoot, 'sessions'), { recursive: true });
    const issueUrl = 'https://github.com/example/project/issues/745';
    const startAt = Date.now();
    let fakeNow = startAt;
    let currentQuestion: SessionObservationSnapshot['openQuestions'][number] | undefined;
    let observationSequence = 0;
    let gateReleased = false;
    let modeledRefreshDelayApplied = false;
    const server = await startOpenQuestionControlServer({
      listOpenQuestions: () => currentQuestion ? [currentQuestion] : [],
      observeSession: async () => {
        if (gateReleased && !modeledRefreshDelayApplied) {
          fakeNow += 50;
          modeledRefreshDelayApplied = true;
        }
        return {
          sequence: observationSequence,
          openQuestions: currentQuestion ? [currentQuestion] : [],
        };
      },
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServer = () => server.close();

    const baseStore = {
      version: 1,
      conductorBackend: 'pi',
      repoRoot,
      profile: { workers: [], agents: {} },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: startAt,
      harnessSocketPath: server.socketPath,
      harnessPhase: 'idle',
      modifiedAt: startAt - 31 * 60_000,
      lifecycle: 'unknown',
    };
    const resumeStorePath = resolveEnsemblePaths({
      repoRoot,
      userEnsembleRoot: userRoot,
    }).canonicalSessionResumeStorePath(issueUrl, 'conductor-idle');
    await mkdir(dirname(resumeStorePath), { recursive: true });
    await writeFile(
      resumeStorePath,
      JSON.stringify({
        ...baseStore,
        conductorAgentId: 'conductor-idle',
        issueUrl,
      }),
    );

    const runProfile = async (
      profile: 'baseline' | 'integrated',
    ) => {
      tuiHarness.onSubmit = undefined;
      const configProfile = `smoke-${profile}`;
      await writeFile(
        join(userRoot, 'operator-agents.config.yaml'),
        [
          'version: 1',
          `defaultProfile: ${configProfile}`,
          'common:',
          '  conductor:',
          '    backend: pi',
          '    model: run-loop-model',
          '  pi:',
          '    agentDir: pi-user',
          'profiles:',
          `  ${configProfile}:`,
          '    scheduling:',
          `      idlePhaseThresholdMs: ${profile === 'baseline' ? 7200000 : 600000}`,
          '      batchMaxWaitMs: 10000',
          '',
        ].join('\n'),
      );
      currentQuestion = undefined;
      observationSequence = 0;
      gateReleased = false;
      modeledRefreshDelayApplied = false;
      fakeNow = startAt;
      const statePath = operatorWatchStatePath(userRoot, configProfile, issueUrl);
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
      });
      const stdout = Object.assign(new PassThrough(), {
        isTTY: true,
        columns: 80,
        rows: 24,
      });
      stdout.on('data', () => {});

      let agentOptions: ConductorAgentCreateOptions | undefined;
      let releaseUserSend!: () => void;
      const userSendGate = new Promise<void>((resolve) => {
        releaseUserSend = resolve;
      });
      let signalQuestionQueued!: () => void;
      const questionQueued = new Promise<void>((resolve) => {
        signalQuestionQueued = resolve;
      });
      let rejectSendError!: (error: unknown) => void;
      const sendError = new Promise<never>((_resolve, reject) => {
        rejectSendError = reject;
      });
      void sendError.catch(() => {});
      let signalReportSent!: () => void;
      const reportSent = new Promise<void>((resolve) => {
        signalReportSent = resolve;
      });
      const sendTimes: number[] = [];
      const reportPrompts: string[] = [];
      const frozenBatchIds: string[] = [];
      let mixedBatchReports: Array<{
        reportId: string;
        reportType: string;
        priority?: string;
        arrivalOrder?: number;
        frozenBatchId?: string;
      }> = [];
      const fakeAgent: ConductorAgent = {
        agentId: `operator-${profile}`,
        async send(prompt) {
          if (prompt === 'watch the live session') {
            try {
              await agentOptions!.customTools!.register_session_watch!.execute({
                conductorAgentId: 'conductor-idle',
                pollIntervalMs: 250,
                debounceMs: 0,
              });
              let cursorFound = false;
              for (let attempt = 0; attempt < 800; attempt += 1) {
                try {
                  const state = JSON.parse(
                    await readFile(statePath, 'utf8'),
                  ) as {
                    cursors: Record<string, { sequence: number }>;
                  };
                  if (state.cursors['conductor-idle']?.sequence === 0) {
                    cursorFound = true;
                    break;
                  }
                } catch {
                  // The first watch poll has not persisted its cursor yet.
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              expect(cursorFound).toBe(true);
              currentQuestion = {
                id: `inq-run-loop-${profile}`,
                question: 'Review the live session?',
                responseType: 'text',
                source: 'conductor',
                status: 'open',
                askedAt: Date.now(),
              };
              observationSequence = 1;
              let questionFound = false;
              for (let attempt = 0; attempt < 800; attempt += 1) {
                try {
                  const state = JSON.parse(
                    await readFile(statePath, 'utf8'),
                  ) as {
                    pendingReports: Array<{ reportType: string }>;
                  };
                  if (
                    state.pendingReports.some(
                      (report) => report.reportType === 'open_question',
                    )
                  ) {
                    questionFound = true;
                    signalQuestionQueued();
                    break;
                  }
                } catch {
                  // The next watch poll has not persisted the OQ report yet.
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              expect(questionFound).toBe(true);
            } catch (error) {
              rejectSendError(error);
              throw error;
            }
            await userSendGate;
            sendTimes.push(fakeNow);
            return {
              runId: `${profile}-user`,
              status: 'finished',
              result: 'watch registered',
            };
          }

          const state = JSON.parse(
            await readFile(statePath, 'utf8'),
          ) as {
            pendingReports: Array<{
              reportId: string;
              reportType: string;
              priority?: string;
              arrivalOrder?: number;
              conductorAgentId: string;
              text: string;
              frozenBatchId?: string;
              firstQueuedAt: number;
            }>;
          };
          const included = state.pendingReports.filter(
            (report) => report.frozenBatchId && prompt.includes(report.text),
          );
          const batchId = included[0]?.frozenBatchId;
          expect(batchId).toBeTypeOf('string');
          frozenBatchIds.push(batchId!);
          mixedBatchReports = (
            batchId
              ? state.pendingReports.filter(
                  (report) => report.frozenBatchId === batchId,
                )
              : included
          ).map((report) => ({
            reportId: report.reportId,
            reportType: report.reportType,
            priority: report.priority,
            arrivalOrder: report.arrivalOrder,
            frozenBatchId: report.frozenBatchId,
          }));
          reportPrompts.push(prompt);
          sendTimes.push(fakeNow);
          tuiHarness.onSubmit?.('/exit');
          signalReportSent();
          return {
            runId: `${profile}-report`,
            status: 'finished',
            result: 'report handled',
          };
        },
        async reload() {},
        async getUsage() {
          return {};
        },
        async setSystemPrompt() {},
        async close() {},
      };
      const agentFactory: ConductorAgentFactory = {
        create: async (options) => {
          agentOptions = options;
          return fakeAgent;
        },
        resume: async () => fakeAgent,
      };
      let submit: ((message: string) => void) | undefined;
      const ready = new Promise<(message: string) => void>((resolve) => {
        if (tuiHarness.onSubmit) {
          resolve(tuiHarness.onSubmit);
        } else {
          tuiHarness.readyResolvers.push(resolve);
        }
      });
      const run = runOperatorAgent(
        { newSession: true },
        {
          userEnsembleRoot: userRoot,
          stdin: input,
          stdout,
          agentFactory,
        },
      );
      submit = await ready;
      vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
      submit('watch the live session');
      await Promise.race([questionQueued, sendError]);
      // Let the poll that persisted the OQ finish before opening the gate.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const heldState = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: Array<{
          reportType: string;
          firstQueuedAt: number;
        }>;
      };
      expect(
        heldState.pendingReports.filter(
          (report) => report.reportType === 'open_question',
        ),
      ).toHaveLength(1);
      expect(
        heldState.pendingReports.filter(
          (report) => report.reportType === 'idle_candidate',
        ),
      ).toEqual([]);
      const questionArrivalAt = heldState.pendingReports.find(
        (report) => report.reportType === 'open_question',
      )!.firstQueuedAt;
      fakeNow = startAt + 10_000;
      gateReleased = true;
      releaseUserSend();
      const reportOutcome = await Promise.race([
        reportSent.then(() => 'sent' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
      ]);
      if (reportOutcome === 'timeout') {
        const pendingState = await readFile(statePath, 'utf8');
        tuiHarness.onSubmit?.('/exit');
        await run;
        throw new Error(
          `report batch was not dispatched through runOperatorAgent; state=${pendingState}`,
        );
      }
      await run;
      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: unknown[];
        idleCandidateFingerprints?: Record<string, Record<string, string>>;
      };
      const metrics = {
        dispatchAttempts: sendTimes.length,
        reportBatches: new Set(frozenBatchIds).size,
        fakeAgentTurns: sendTimes.length,
        openQuestionWaitMs: sendTimes[1]! - questionArrivalAt,
      };
      input.destroy();
      stdout.destroy();
      vi.restoreAllMocks();
      return {
        metrics,
        prompt: reportPrompts[0]!,
        mixedBatchReports,
        persisted,
      };
    };

    const baseline = await runProfile('baseline');
    const integrated = await runProfile('integrated');

    expect(baseline.metrics).toEqual({
      dispatchAttempts: 2,
      reportBatches: 1,
      fakeAgentTurns: 2,
      openQuestionWaitMs: 10_050,
    });
    expect(integrated.metrics).toEqual(baseline.metrics);
    expect(baseline.prompt).toContain('Review the live session?');
    expect(baseline.prompt).not.toContain('稼働 session の確認候補');
    expect(integrated.prompt).toContain('Review the live session?');
    expect(integrated.prompt).toContain('稼働 session の確認候補');
    expect(integrated.mixedBatchReports.map((report) => report.reportType)).toEqual([
      'open_question',
      'idle_candidate',
    ]);
    expect(integrated.mixedBatchReports).toHaveLength(2);
    expect(integrated.mixedBatchReports[0]?.priority).toBe('open_question');
    expect(integrated.mixedBatchReports[0]?.reportId).toBeTruthy();
    expect(integrated.mixedBatchReports[1]?.reportId).toBeTruthy();
    expect(integrated.mixedBatchReports[0]?.frozenBatchId).toBe(
      integrated.mixedBatchReports[1]?.frozenBatchId,
    );
    expect(
      integrated.mixedBatchReports[0]!.arrivalOrder!,
    ).toBeLessThan(integrated.mixedBatchReports[1]!.arrivalOrder!);
    expect(integrated.persisted.pendingReports).toEqual([]);
    expect(
      integrated.persisted.idleCandidateFingerprints?.['conductor-idle']
        ?.idle_phase,
    ).toBeDefined();
  });
});
