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
  let closeServers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const closeServer of closeServers) await closeServer();
    closeServers = [];
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = '';
    tuiHarness.onSubmit = undefined;
    tuiHarness.readyResolvers = [];
    vi.restoreAllMocks();
  });

  it('compares baseline and idle integration across multiple watched sessions through runOperatorAgent', async () => {
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
    let blockNextQuestionObservation = false;
    let questionPollBarrier: Promise<void> = Promise.resolve();
    let signalBlockedQuestionPoll: () => void = () => {};
    let gateRefreshBarrier: Promise<void> = Promise.resolve();
    let signalGateRefreshStarted: () => void = () => {};
    let failGateRefresh = false;
    let refreshReadActive = false;
    let overlappingReads = 0;
    const questionServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => currentQuestion ? [currentQuestion] : [],
      observeSession: async () => {
        if (refreshReadActive) overlappingReads++;
        if (gateReleased && !modeledRefreshDelayApplied) {
          modeledRefreshDelayApplied = true;
          fakeNow += 50;
          signalGateRefreshStarted();
          if (failGateRefresh) {
            throw new Error('injected gate-clear refresh failure');
          }
          refreshReadActive = true;
          try { await gateRefreshBarrier; } finally { refreshReadActive = false; }
        }
        if (blockNextQuestionObservation) {
          blockNextQuestionObservation = false;
          signalBlockedQuestionPoll();
          await questionPollBarrier;
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
    closeServers.push(() => questionServer.close());
    const idleSessionServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
        sequence: 0,
        openQuestions: [],
        sessionState: {
          current: {
            statusLine: '外部処理の完了待ち',
            reportedAt: startAt - 60_000,
          },
          history: [],
        },
      }),
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => idleSessionServer.close());
    const healthyRunningServer = await startOpenQuestionControlServer({
      listOpenQuestions: () => [],
      observeSession: async () => ({
        sequence: 0,
        openQuestions: [],
        sessionState: {
          current: {
            statusLine: '正常な長時間処理中',
            reportedAt: startAt - 5 * 60_000,
          },
          history: [],
        },
      }),
      answerOpenQuestion: async () => {
        throw new Error('unused');
      },
    });
    closeServers.push(() => healthyRunningServer.close());

    const baseStore = {
      version: 1,
      conductorBackend: 'pi',
      repoRoot,
      profile: { workers: [], agents: {} },
      openQuestions: [],
      sequence: 0,
      workers: {},
      updatedAt: startAt,
      harnessPhase: 'idle',
      modifiedAt: startAt - 31 * 60_000,
      lifecycle: 'unknown',
    };
    const writeResumeStore = async (
      conductorAgentId: string,
      harnessSocketPath: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const resumeStorePath = resolveEnsemblePaths({
        repoRoot,
        userEnsembleRoot: userRoot,
      }).canonicalSessionResumeStorePath(issueUrl, conductorAgentId);
      await mkdir(dirname(resumeStorePath), { recursive: true });
      await writeFile(
        resumeStorePath,
        JSON.stringify({
          ...baseStore,
          ...overrides,
          conductorAgentId,
          issueUrl,
          harnessSocketPath,
        }),
      );
    };
    await writeResumeStore('conductor-idle', questionServer.socketPath);
    await writeResumeStore('conductor-idle-peer', idleSessionServer.socketPath);
    await writeResumeStore('conductor-running', healthyRunningServer.socketPath, {
      harnessPhase: 'running',
      modifiedAt: startAt - 50 * 60_000,
    });

    const runProfile = async (
      profile:
        | 'baseline'
        | 'integrated'
        | 'baseline-late'
        | 'integrated-late'
        | 'integrated-inflight'
        | 'integrated-inflight-late'
        | 'integrated-inflight-fail',
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
          `      idlePhaseThresholdMs: ${profile.startsWith('baseline') ? 7200000 : 600000}`,
          '      batchMaxWaitMs: 10000',
          '',
        ].join('\n'),
      );
      currentQuestion = undefined;
      observationSequence = 0;
      gateReleased = false;
      modeledRefreshDelayApplied = false;
      blockNextQuestionObservation = false;
      failGateRefresh = profile.startsWith('baseline') || profile === 'integrated-inflight-fail';
      overlappingReads = 0;
      let gateRefreshBarrierReleased = false;
      let releaseGateRefresh!: () => void;
      let releaseQuestionPoll!: () => void;
      let signalRefreshStarted!: () => void;
      let signalQuestionPollStarted!: () => void;
      let signalQuestionReportSent!: () => void;
      let signalLateIdleReportSent!: () => void;
      const gateRefreshStarted = new Promise<void>((resolve) => {
        signalRefreshStarted = resolve;
      });
      const questionPollInFlight = new Promise<void>((resolve) => {
        signalQuestionPollStarted = resolve;
      });
      const questionReportSent = new Promise<void>((resolve) => {
        signalQuestionReportSent = resolve;
      });
      const lateIdleReportSent = new Promise<void>((resolve) => {
        signalLateIdleReportSent = resolve;
      });
      const gateRefreshBarrierForProfile = new Promise<void>((resolve) => {
        releaseGateRefresh = resolve;
      });
      const questionPollBarrierForProfile = new Promise<void>((resolve) => {
        releaseQuestionPoll = resolve;
      });
      gateRefreshBarrier = gateRefreshBarrierForProfile;
      questionPollBarrier = questionPollBarrierForProfile;
      signalGateRefreshStarted = signalRefreshStarted;
      signalBlockedQuestionPoll = signalQuestionPollStarted;
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
      const mixedBatchReports: Array<Array<{
        reportId: string;
        reportType: string;
        priority?: string;
        arrivalOrder?: number;
        frozenBatchId?: string;
        conductorAgentId: string;
      }>> = [];
      const fakeAgent: ConductorAgent = {
        agentId: `operator-${profile}`,
        async send(prompt) {
          if (prompt === 'watch the live session') {
            try {
              const watchedSessionIds =
                profile.endsWith('-late') ||
                profile.startsWith('integrated-inflight')
                ? ['conductor-idle']
                : [
                    'conductor-idle',
                    'conductor-idle-peer',
                    'conductor-running',
                  ];
              for (const conductorAgentId of watchedSessionIds) {
                await agentOptions!.customTools!.register_session_watch!.execute({
                  conductorAgentId,
                  pollIntervalMs: 250,
                  debounceMs: 0,
                });
              }
              let cursorFound = false;
              for (let attempt = 0; attempt < 800; attempt += 1) {
                try {
                  const state = JSON.parse(
                    await readFile(statePath, 'utf8'),
                  ) as {
                    cursors: Record<string, { sequence: number }>;
                  };
                  if (
                    watchedSessionIds.every(
                      (id) => state.cursors[id]?.sequence === 0,
                    )
                  ) {
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
              if (profile.startsWith('integrated-inflight')) {
                blockNextQuestionObservation = true;
                await questionPollInFlight;
              }
              if (profile.endsWith('-late') && !profile.startsWith('integrated-inflight')) {
                // Keep ordinary background polls out of this cap test so the
                // only blocked observation is the candidate refresh pass.
                for (const conductorAgentId of watchedSessionIds) {
                  await agentOptions!.customTools!.register_session_watch!.execute({
                    conductorAgentId,
                    pollIntervalMs: 60_000,
                    debounceMs: 0,
                  });
                }
              }
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
          const batchReports = (
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
            conductorAgentId: report.conductorAgentId,
          }));
          mixedBatchReports.push(batchReports);
          reportPrompts.push(prompt);
          sendTimes.push(fakeNow);
          if (
            batchReports.some(
              (report) => report.reportType === 'open_question',
            )
          ) {
            signalQuestionReportSent();
          }
          if (
            (profile === 'integrated-late' || profile === 'integrated-inflight-late') &&
            batchReports.some(
              (report) =>
                report.reportType === 'idle_candidate' &&
                report.conductorAgentId === 'conductor-idle',
            )
          ) {
            tuiHarness.onSubmit?.('/exit');
            signalLateIdleReportSent();
          }
          if (
            profile === 'baseline-late' &&
            batchReports.some(
              (report) => report.reportType === 'open_question',
            )
          ) {
            tuiHarness.onSubmit?.('/exit');
          }
          if (
            (profile === 'integrated-inflight' || profile === 'integrated-inflight-fail') &&
            batchReports.some(
              (report) => report.reportType === 'open_question',
            )
          ) {
            tuiHarness.onSubmit?.('/exit');
            signalReportSent();
          }
          if (
            !profile.endsWith('-late') &&
            mixedBatchReports.length === 3
          ) {
            tuiHarness.onSubmit?.('/exit');
            signalReportSent();
          }
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
      if (profile.startsWith('integrated-inflight')) {
        await Promise.race([
          questionPollInFlight,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error('same-session watch poll did not start')),
              2_000,
            ),
          ),
        ]);
      }
      fakeNow = startAt + 10_000;
      gateReleased = true;
      releaseUserSend();
      if (profile.startsWith('integrated-inflight')) {
        const duplicateRead = await Promise.race([
          gateRefreshStarted.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 50),
          ),
        ]);
        expect(duplicateRead).toBe(false);
        expect(reportPrompts).toEqual([]);
        fakeNow = startAt + 10_100;
        releaseQuestionPoll();
      } else {
        await Promise.race([
          gateRefreshStarted,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error(`gate-clear refresh did not start for ${profile}`)),
              2_000,
            ),
          ),
        ]);
      }
      let reportPromptsWhileRefreshPending: string[] | undefined;
      let refreshHeldState:
        | { pendingReports: Array<{ reportType: string }> }
        | undefined;
      if (profile === 'integrated') {
        // Regression guard: the old run loop froze and sent the ready OQ
        // while this fresh observation was still pending, omitting the
        // candidate that admission adds when the observation completes.
        reportPromptsWhileRefreshPending = [...reportPrompts];
        refreshHeldState = JSON.parse(
          await readFile(statePath, 'utf8'),
        ) as {
          pendingReports: Array<{ reportType: string }>;
        };
      }
      if (profile.endsWith('-late')) {
        const questionOutcome = await Promise.race([
          questionReportSent,
          new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), 3_000),
          ),
        ]);
        if (questionOutcome === 'timeout') {
          const state = await readFile(statePath, 'utf8');
          gateRefreshBarrierReleased = true;
          releaseGateRefresh();
          tuiHarness.onSubmit?.('/exit');
          await run;
          throw new Error(
            `OQ was not sent after the refresh cap; prompts=${JSON.stringify(reportPrompts)} state=${state}`,
          );
        }
        if (profile === 'integrated-late' || profile === 'integrated-inflight-late') {
          expect(overlappingReads).toBe(0);
          expect(gateRefreshBarrierReleased).toBe(false);
          const questionOnlyBatch = mixedBatchReports.find((batch) =>
            batch.some((report) => report.reportType === 'open_question'),
          )!;
          expect(questionOnlyBatch.map((report) => report.reportType)).toEqual([
            'open_question',
          ]);
        }
        gateRefreshBarrierReleased = true;
        releaseGateRefresh();
      } else {
        gateRefreshBarrierReleased = true;
        releaseGateRefresh();
      }
      const reportOutcome = await Promise.race([
        (profile === 'integrated-late' || profile === 'integrated-inflight-late'
          ? lateIdleReportSent
          : profile === 'baseline-late'
            ? questionReportSent
            : reportSent
        ).then(() => 'sent' as const),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 4_000),
        ),
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
      if (profile === 'integrated') {
        expect(reportPromptsWhileRefreshPending).toEqual([]);
        expect(
          refreshHeldState!.pendingReports.filter(
            (report) => report.reportType === 'open_question',
          ),
        ).toHaveLength(1);
        expect(
          refreshHeldState!.pendingReports.filter(
            (report) => report.reportType === 'idle_candidate',
          ),
        ).toEqual([]);
      }
      const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
        pendingReports: unknown[];
        idleCandidateFingerprints?: Record<string, Record<string, string>>;
      };
      const questionBatchIndex = mixedBatchReports.findIndex((batch) =>
        batch.some((report) => report.reportType === 'open_question'),
      );
      const metrics = {
        dispatchAttempts: sendTimes.length,
        reportBatches: new Set(frozenBatchIds).size,
        fakeAgentTurns: sendTimes.length,
        openQuestionWaitMs:
          sendTimes[questionBatchIndex + 1]! - questionArrivalAt,
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
    const baselineLate = await runProfile('baseline-late');
    const integratedLate = await runProfile('integrated-late');
    const integratedInflight = await runProfile('integrated-inflight');
    const integratedInflightLate = await runProfile('integrated-inflight-late');
    const integratedInflightFail = await runProfile('integrated-inflight-fail');
    expect(integratedInflightLate.mixedBatchReports[0]!.map((report) => report.reportType)).toEqual(['open_question']);
    expect(integratedInflightLate.mixedBatchReports.flat().filter((report) => report.reportType === 'idle_candidate')).toHaveLength(1);
    expect(integratedInflightFail.mixedBatchReports[0]!.map((report) => report.reportType)).toEqual(['open_question']);

    expect(baseline.metrics).toEqual({
      dispatchAttempts: 4,
      reportBatches: 3,
      fakeAgentTurns: 4,
      openQuestionWaitMs: 10_050,
    });
    expect(integrated.metrics).toEqual(baseline.metrics);
    expect(baselineLate.metrics).toEqual({
      dispatchAttempts: 2,
      reportBatches: 1,
      fakeAgentTurns: 2,
      openQuestionWaitMs: 10_050,
    });
    expect(integratedLate.metrics).toEqual({
      dispatchAttempts: 3,
      reportBatches: 2,
      fakeAgentTurns: 3,
      openQuestionWaitMs: 10_050,
    });
    expect(integratedInflight.metrics).toEqual({
      dispatchAttempts: 2,
      reportBatches: 1,
      fakeAgentTurns: 2,
      openQuestionWaitMs: 10_150,
    });
    expect(baseline.prompt).toContain('Review the live session?');
    expect(baseline.prompt).not.toContain('稼働 session の確認候補');
    expect(integrated.prompt).toContain('Review the live session?');
    expect(integrated.prompt).toContain('稼働 session の確認候補');
    const baselineQuestionBatch = baseline.mixedBatchReports.find((batch) =>
      batch.some((report) => report.reportType === 'open_question'),
    )!;
    const integratedQuestionBatch = integrated.mixedBatchReports.find((batch) =>
      batch.some((report) => report.reportType === 'open_question'),
    )!;
    expect(baselineQuestionBatch.map((report) => report.reportType)).toEqual([
      'open_question',
    ]);
    expect(integratedQuestionBatch.map((report) => report.reportType)).toEqual([
      'open_question',
      'idle_candidate',
    ]);
    expect(integratedQuestionBatch).toHaveLength(2);
    expect(integratedQuestionBatch[0]?.priority).toBe('open_question');
    expect(integratedQuestionBatch[0]?.reportId).toBeTruthy();
    expect(integratedQuestionBatch[1]?.reportId).toBeTruthy();
    expect(integratedQuestionBatch[0]?.conductorAgentId).toBe('conductor-idle');
    expect(integratedQuestionBatch[1]?.conductorAgentId).toBe('conductor-idle');
    expect(integratedQuestionBatch[0]?.frozenBatchId).toBe(
      integratedQuestionBatch[1]?.frozenBatchId,
    );
    expect(
      integratedQuestionBatch[0]!.arrivalOrder!,
    ).toBeLessThan(integratedQuestionBatch[1]!.arrivalOrder!);
    const baselineIdlePeerBatch = baseline.mixedBatchReports.find((batch) =>
      batch.some((report) => report.conductorAgentId === 'conductor-idle-peer'),
    )!;
    const integratedIdlePeerBatch = integrated.mixedBatchReports.find((batch) =>
      batch.some((report) => report.conductorAgentId === 'conductor-idle-peer'),
    )!;
    expect(
      baselineIdlePeerBatch.map((report) => report.reportType),
    ).toEqual(['session_state']);
    expect(
      integratedIdlePeerBatch.map((report) => report.reportType),
    ).toEqual(['session_state', 'idle_candidate']);
    expect(integratedIdlePeerBatch[0]?.conductorAgentId).toBe(
      'conductor-idle-peer',
    );
    expect(integratedIdlePeerBatch[1]?.conductorAgentId).toBe(
      'conductor-idle-peer',
    );
    expect(
      integratedIdlePeerBatch[0]!.arrivalOrder!,
    ).toBeLessThan(integratedIdlePeerBatch[1]!.arrivalOrder!);
    const baselineHealthyRunningBatch = baseline.mixedBatchReports.find((batch) =>
      batch.some((report) => report.conductorAgentId === 'conductor-running'),
    )!;
    const integratedHealthyRunningBatch = integrated.mixedBatchReports.find((batch) =>
      batch.some((report) => report.conductorAgentId === 'conductor-running'),
    )!;
    expect(
      baselineHealthyRunningBatch.map((report) => report.reportType),
    ).toEqual(['session_state']);
    expect(
      integratedHealthyRunningBatch.map((report) => report.reportType),
    ).toEqual(['session_state']);
    expect(
      integrated.mixedBatchReports.flat().filter(
        (report) => report.reportType === 'open_question',
      ),
    ).toHaveLength(1);
    expect(
      integrated.mixedBatchReports.flat().filter(
        (report) =>
          report.reportType === 'idle_candidate' &&
          report.conductorAgentId === 'conductor-running',
      ),
    ).toEqual([]);
    expect(integrated.persisted.pendingReports).toEqual([]);
    expect(
      integrated.persisted.idleCandidateFingerprints?.['conductor-idle']
        ?.idle_phase,
    ).toBeDefined();
    expect(
      integrated.persisted.idleCandidateFingerprints?.['conductor-idle-peer']
        ?.idle_phase,
    ).toBeDefined();
    const lateQuestionBatch = integratedLate.mixedBatchReports.find((batch) =>
      batch.some((report) => report.reportType === 'open_question'),
    )!;
    const lateCandidateBatches = integratedLate.mixedBatchReports.filter(
      (batch) =>
        batch.some(
          (report) =>
            report.reportType === 'idle_candidate' &&
            report.conductorAgentId === 'conductor-idle',
        ),
    );
    expect(lateQuestionBatch.map((report) => report.reportType)).toEqual([
      'open_question',
    ]);
    expect(lateCandidateBatches).toHaveLength(1);
    expect(lateCandidateBatches[0]!.map((report) => report.reportType)).toEqual([
      'idle_candidate',
    ]);
    expect(
      integratedLate.mixedBatchReports.flat().filter(
        (report) => report.reportType === 'open_question',
      ),
    ).toHaveLength(1);
    expect(
      lateQuestionBatch[0]!.frozenBatchId,
    ).not.toBe(lateCandidateBatches[0]![0]!.frozenBatchId);
    const inFlightQuestionBatch = integratedInflight.mixedBatchReports.find(
      (batch) =>
        batch.some((report) => report.reportType === 'open_question'),
    )!;
    expect(inFlightQuestionBatch.map((report) => report.reportType)).toEqual([
      'open_question',
      'idle_candidate',
    ]);
    expect(inFlightQuestionBatch[0]?.priority).toBe('open_question');
    expect(
      inFlightQuestionBatch[0]!.arrivalOrder!,
    ).toBeLessThan(inFlightQuestionBatch[1]!.arrivalOrder!);
    expect(
      integratedInflight.mixedBatchReports.flat().filter(
        (report) => report.reportType === 'open_question',
      ),
    ).toHaveLength(1);
  });
});
