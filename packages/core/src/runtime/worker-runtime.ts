import { randomUUID } from 'node:crypto';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import {
  attachWorker,
  buildWorkerAttachPrompt,
  runAttachedWorkerPrompt,
  type AttachedWorker,
} from '../dispatch/attach-worker.js';
import {
  closeWorkerAcpSession,
  type ConnectWorkerAcpFn,
} from '../dispatch/worker-acp-session.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { ConductorInbox } from './conductor-inbox.js';
import type { SendWorkerMessageResult } from './send-worker-message.js';
import type { WorkerStartedInfo, WorkerStartParams } from './types.js';

export interface WorkerRuntimeOptions {
  inbox: ConductorInbox;
  connectAcp?: ConnectWorkerAcpFn;
  spawn?: SpawnAcpProcessOptions;
  /** integration の共有 bridge 注入時は false。 */
  ownsWorkerAcpConnections?: boolean;
}

interface ResidentWorker {
  workerId: string;
  started: WorkerStartedInfo;
  attached: AttachedWorker;
  state: 'idle' | 'prompting';
  queue: string[];
}

export class WorkerRuntime {
  private readonly prompting = new Map<string, WorkerStartedInfo>();
  private readonly residents = new Map<string, ResidentWorker>();
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

  listAttached(): AttachedWorker[] {
    return [...this.residents.values()].map((resident) => resident.attached);
  }

  getAttached(name: string): AttachedWorker | undefined {
    return this.residents.get(name)?.attached;
  }

  listRunning(): WorkerStartedInfo[] {
    return [...this.prompting.values()];
  }

  start(params: WorkerStartParams): string {
    const workerId = randomUUID();
    const started: WorkerStartedInfo = { workerId, ...params };
    void this.bootstrap(started);
    return workerId;
  }

  /** 常駐 worker へ user メッセージ（ACP `session/prompt`）を送る。busy 時は per-worker キューへ。 */
  sendWorkerMessage(
    name: string,
    instruction: string,
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

  private async bootstrap(started: WorkerStartedInfo): Promise<void> {
    this.bootstrapInFlight++;
    try {
      const attached = await attachWorker({
        name: started.name,
        issueUrl: started.issueUrl,
        kind: started.kind,
        systemPrompt: started.systemPrompt,
        repoRoot: started.repoRoot,
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
      };
      this.residents.set(started.name, resident);

      const prompt = buildWorkerAttachPrompt(
        {
          name: started.name,
          issueUrl: started.issueUrl,
          kind: started.kind,
          systemPrompt: started.systemPrompt,
          sessionState: started.sessionState,
          repoRoot: started.repoRoot,
          resumeAcpSessionId: started.resumeAcpSessionId,
        },
        attached.session,
      );

      await this.executeRound(resident, prompt);
    } catch (error) {
      this.residents.delete(started.name);
      this.options.inbox.publishWorkerFailed(started, error);
    } finally {
      this.bootstrapInFlight--;
      this.resolveIdleIfReady();
    }
  }

  private async executeRound(
    resident: ResidentWorker,
    prompt: string,
  ): Promise<void> {
    resident.state = 'prompting';
    this.prompting.set(resident.workerId, resident.started);
    try {
      const result = await runAttachedWorkerPrompt(
        resident.attached,
        prompt,
        this.options.inbox.createPermissionHandler(resident.workerId),
      );
      this.options.inbox.publishWorkerCompleted(resident.workerId, result);
    } catch (error) {
      this.options.inbox.publishWorkerFailed(resident.started, error);
    } finally {
      this.finishPromptRound(resident.workerId);
      const next = resident.queue.shift();
      if (next) {
        await this.executeRound(resident, next);
      } else {
        resident.state = 'idle';
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
