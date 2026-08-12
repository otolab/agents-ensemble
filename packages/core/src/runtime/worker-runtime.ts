import { randomUUID } from 'node:crypto';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import {
  attachWorker,
  buildWorkerAttachPrompt,
  runAttachedWorkerPrompt,
  type AttachedWorker,
} from '../dispatch/attach-worker.js';
import {
  cancelWorkerAcpPrompt,
  closeWorkerAcpSession,
  type ConnectWorkerAcpFn,
} from '../dispatch/worker-acp-session.js';
import type { WorkerRoundKind } from '../dispatch/worker-dispatch.js';
import { ConductorInbox } from './conductor-inbox.js';
import type {
  SendWorkerMessageOptions,
  SendWorkerMessageResult,
} from './send-worker-message.js';
import type {
  WorkerBootstrapTelemetry,
  WorkerStartedInfo,
  WorkerStartParams,
} from './types.js';
import type {
  WorkerStatusDetail,
  WorkerStatusSummary,
} from './worker-status.js';

export interface WorkerRuntimeOptions {
  inbox: ConductorInbox;
  connectAcp?: ConnectWorkerAcpFn;
  spawn?: SpawnAcpProcessOptions;
  /** integration の共有 bridge 注入時は false。 */
  ownsWorkerAcpConnections?: boolean;
  onBootstrapTelemetry?: (event: WorkerBootstrapTelemetry) => void;
}

interface ResidentWorker {
  workerId: string;
  started: WorkerStartedInfo;
  attached: AttachedWorker;
  state: 'idle' | 'prompting';
  queue: string[];
  /** `session/cancel` 応答待ちの新指示。 */
  preemptInstruction?: string;
  cancelInFlight: boolean;
}

interface BootstrappingWorker {
  workerId: string;
  name: string;
  kind: string;
}

interface FailedWorker {
  workerId: string;
  name: string;
  kind: string;
  error: string;
}

export class WorkerRuntime {
  private readonly prompting = new Map<string, WorkerStartedInfo>();
  private readonly residents = new Map<string, ResidentWorker>();
  private readonly bootstrapping = new Map<string, BootstrappingWorker>();
  private readonly failedWorkers = new Map<string, FailedWorker>();
  private readonly idleResolvers = new Set<() => void>();
  private bootstrapInFlight = 0;

  constructor(private readonly options: WorkerRuntimeOptions) {}

  /** 進行中の prompt ラウンド数 + bootstrap 中（conductor ループ用）。 */
  get runningCount(): number {
    return this.prompting.size + this.bootstrapInFlight;
  }

  /** attach 済み worker 数。 */
  get attachedCount(): number {
    return this.residents.size;
  }

  /** bootstrap 中（attach または bootstrap prompt 実行中を含む）の worker 数。 */
  get bootstrapInFlightCount(): number {
    return this.bootstrapInFlight;
  }

  listAttached(): AttachedWorker[] {
    return [...this.residents.values()].map((resident) => resident.attached);
  }

  getAttached(name: string): AttachedWorker | undefined {
    return this.residents.get(name)?.attached;
  }

  listRunning(): WorkerStartedInfo[] {
    return [...this.prompting.values()];
  }

  /** attach 済み・bootstrap 中・失敗済み worker の harness 状態一覧。 */
  listWorkerStatuses(): WorkerStatusSummary[] {
    const names = new Set<string>([
      ...this.residents.keys(),
      ...this.bootstrapping.keys(),
      ...this.failedWorkers.keys(),
    ]);
    return [...names].map((name) => this.summarizeWorkerStatus(name));
  }

  /** 1 worker の harness 状態詳細。未登録なら undefined。 */
  /** worker UUID から kind（なければ name）を返す。 */
  resolveWorkerLabel(workerId: string): string | undefined {
    for (const resident of this.residents.values()) {
      if (resident.workerId === workerId) {
        return resident.started.kind;
      }
    }

    for (const bootstrapping of this.bootstrapping.values()) {
      if (bootstrapping.workerId === workerId) {
        return bootstrapping.kind;
      }
    }

    for (const failed of this.failedWorkers.values()) {
      if (failed.workerId === workerId) {
        return failed.kind;
      }
    }

    for (const started of this.prompting.values()) {
      if (started.workerId === workerId) {
        return started.kind;
      }
    }

    return undefined;
  }

  getWorkerStatus(name: string): WorkerStatusDetail | undefined {
    if (
      !this.residents.has(name) &&
      !this.bootstrapping.has(name) &&
      !this.failedWorkers.has(name)
    ) {
      return undefined;
    }

    const summary = this.summarizeWorkerStatus(name);
    const resident = this.residents.get(name);
    if (!resident) {
      return {
        ...summary,
        workerId:
          this.bootstrapping.get(name)?.workerId ??
          this.failedWorkers.get(name)?.workerId,
        queuePreview: [],
        preemptPending: false,
        cancelInFlight: false,
      };
    }

    return {
      ...summary,
      workerId: resident.workerId,
      queuePreview: resident.queue.map((instruction) => summarizeInstruction(instruction)),
      preemptPending: resident.preemptInstruction !== undefined,
      cancelInFlight: resident.cancelInFlight,
    };
  }

  start(params: WorkerStartParams): string {
    const workerId = randomUUID();
    const started: WorkerStartedInfo = { workerId, ...params };
    void this.bootstrap(started);
    return workerId;
  }

  /** 常駐 worker へ user メッセージ（ACP `session/prompt`）を送る。busy 時はキュー、preempt 時は割り込み。 */
  sendWorkerMessage(
    name: string,
    instruction: string,
    options?: SendWorkerMessageOptions,
  ): SendWorkerMessageResult {
    const text = instruction.trim();
    if (!text) {
      return {
        status: 'error',
        worker: name,
        message: 'instruction must not be empty',
      };
    }

    const resident = this.residents.get(name);
    if (!resident) {
      return {
        status: 'error',
        worker: name,
        message: `Worker "${name}" is not attached`,
      };
    }

    if (resident.state === 'prompting') {
      if (options?.preempt) {
        resident.queue.length = 0;
        resident.preemptInstruction = text;
        if (!resident.cancelInFlight) {
          resident.cancelInFlight = true;
          cancelWorkerAcpPrompt(resident.attached.session);
        }
        return { status: 'preempted', worker: name };
      }

      resident.queue.push(text);
      return {
        status: 'queued',
        worker: name,
        position: resident.queue.length,
      };
    }

    void this.executeRound(resident, text);
    return { status: 'sent', worker: name };
  }

  async waitForIdle(): Promise<void> {
    if (this.prompting.size === 0 && this.bootstrapInFlight === 0) return;
    await new Promise<void>((resolve) => {
      this.idleResolvers.add(resolve);
    });
  }

  /** ensemble 終了時に全 resident の ACP 接続を閉じる。 */
  async shutdown(): Promise<void> {
    await this.waitForIdle();
    for (const resident of this.residents.values()) {
      await closeWorkerAcpSession(resident.attached.session);
    }
    this.residents.clear();
  }

  private summarizeWorkerStatus(name: string): WorkerStatusSummary {
    const failed = this.failedWorkers.get(name);
    if (failed) {
      return {
        name: failed.name,
        kind: failed.kind,
        state: 'failed',
        queueDepth: 0,
        error: failed.error,
      };
    }

    const bootstrapping = this.bootstrapping.get(name);
    if (bootstrapping) {
      return {
        name: bootstrapping.name,
        kind: bootstrapping.kind,
        state: 'bootstrapping',
        queueDepth: 0,
      };
    }

    const resident = this.residents.get(name);
    if (!resident) {
      throw new Error(`summarizeWorkerStatus: unknown worker ${name}`);
    }

    return {
      name: resident.attached.name,
      kind: resident.attached.kind,
      state: resident.state,
      queueDepth: resident.queue.length,
      worktreePath: resident.started.worktree.path,
      acpSessionId: resident.attached.session.sessionId,
    };
  }

  private async bootstrap(started: WorkerStartedInfo): Promise<void> {
    this.bootstrapInFlight++;
    this.bootstrapping.set(started.name, {
      workerId: started.workerId,
      name: started.name,
      kind: started.kind,
    });
    this.options.onBootstrapTelemetry?.({
      phase: 'started',
      workerId: started.workerId,
      name: started.name,
      kind: started.kind,
    });
    try {
      const attached = await attachWorker({
        name: started.name,
        issueUrl: started.issueUrl,
        kind: started.kind,
        systemPrompt: started.systemPrompt,
        worktree: started.worktree,
        sessionState: started.sessionState,
        resumeAcpSessionId: started.resumeAcpSessionId,
        connectAcp: this.options.connectAcp,
        spawn: this.options.spawn,
        ownsBridge: this.options.ownsWorkerAcpConnections,
        permissionHandler: this.options.inbox.createPermissionHandler(
          started.workerId,
        ),
      });

      const resident: ResidentWorker = {
        workerId: started.workerId,
        started,
        attached,
        state: 'idle',
        queue: [],
        cancelInFlight: false,
      };
      this.residents.set(started.name, resident);
      this.bootstrapping.delete(started.name);

      const prompt = buildWorkerAttachPrompt(
        {
          name: started.name,
          issueUrl: started.issueUrl,
          kind: started.kind,
          systemPrompt: started.systemPrompt,
          worktree: started.worktree,
          sessionState: started.sessionState,
          resumeAcpSessionId: started.resumeAcpSessionId,
        },
        attached.session,
      );

      await this.executeRound(resident, prompt, 'bootstrap');
    } catch (error) {
      this.residents.delete(started.name);
      this.bootstrapping.delete(started.name);
      const message = error instanceof Error ? error.message : String(error);
      this.failedWorkers.set(started.name, {
        workerId: started.workerId,
        name: started.name,
        kind: started.kind,
        error: message,
      });
      this.options.onBootstrapTelemetry?.({
        phase: 'failed',
        workerId: started.workerId,
        name: started.name,
        kind: started.kind,
        error: message,
      });
      this.options.inbox.publishWorkerFailed(started, error);
    } finally {
      this.bootstrapInFlight--;
      this.resolveIdleIfReady();
    }
  }

  private async executeRound(
    resident: ResidentWorker,
    prompt: string,
    roundKind: WorkerRoundKind = 'instruction',
  ): Promise<void> {
    resident.state = 'prompting';
    resident.cancelInFlight = false;
    this.prompting.set(resident.workerId, resident.started);
    let skipCompletion = false;
    try {
      const result = await runAttachedWorkerPrompt(
        resident.attached,
        prompt,
        this.options.inbox.createPermissionHandler(resident.workerId),
      );
      const dispatch = { ...result, roundKind };
      skipCompletion =
        result.promptResult.stopReason === 'cancelled' &&
        resident.preemptInstruction !== undefined;
      if (!skipCompletion) {
        if (roundKind === 'bootstrap') {
          this.options.onBootstrapTelemetry?.({
            phase: 'completed',
            workerId: resident.workerId,
            name: resident.started.name,
            kind: resident.started.kind,
            stopReason: result.promptResult.stopReason,
          });
        }
        this.options.inbox.publishWorkerCompleted(resident.workerId, dispatch);
      }
    } catch (error) {
      if (!resident.preemptInstruction) {
        if (roundKind === 'bootstrap') {
          this.options.onBootstrapTelemetry?.({
            phase: 'failed',
            workerId: resident.workerId,
            name: resident.started.name,
            kind: resident.started.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.options.inbox.publishWorkerFailed(resident.started, error);
      }
    } finally {
      this.finishPromptRound(resident.workerId);
      const preempt = resident.preemptInstruction;
      if (preempt) {
        resident.preemptInstruction = undefined;
        await this.executeRound(resident, preempt);
      } else {
        const next = resident.queue.shift();
        if (next) {
          await this.executeRound(resident, next);
        } else {
          resident.state = 'idle';
        }
      }
    }
  }

  private finishPromptRound(workerId: string): void {
    this.prompting.delete(workerId);
    this.resolveIdleIfReady();
  }

  private resolveIdleIfReady(): void {
    if (this.prompting.size === 0 && this.bootstrapInFlight === 0) {
      for (const resolve of this.idleResolvers) {
        resolve();
      }
      this.idleResolvers.clear();
    }
  }
}

function summarizeInstruction(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}
