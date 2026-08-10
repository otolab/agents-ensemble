import { randomUUID } from 'node:crypto';
import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import {
  attachWorker,
  buildBootstrapWorkerPrompt,
  runAttachedWorkerPrompt,
  type AttachedWorker,
} from '../dispatch/attach-worker.js';
import {
  closeWorkerAcpSession,
  type ConnectWorkerAcpFn,
} from '../dispatch/worker-acp-session.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import { ConductorInbox } from './conductor-inbox.js';
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
}

export class WorkerRuntime {
  private readonly prompting = new Map<string, WorkerStartedInfo>();
  private readonly residents = new Map<string, ResidentWorker>();
  private readonly idleResolvers = new Set<() => void>();

  constructor(private readonly options: WorkerRuntimeOptions) {}

  /** 進行中の prompt ラウンド数（conductor ループ用）。 */
  get runningCount(): number {
    return this.prompting.size;
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
    this.prompting.set(workerId, started);
    void this.bootstrap(started);
    return workerId;
  }

  async waitForIdle(): Promise<void> {
    if (this.prompting.size === 0) return;
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

      this.residents.set(started.name, { workerId: started.workerId, started, attached });

      const prompt = buildBootstrapWorkerPrompt(
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

      const result = await this.runPromptRound(attached, prompt, started.workerId);
      this.options.inbox.publishWorkerCompleted(started.workerId, result);
    } catch (error) {
      this.residents.delete(started.name);
      this.options.inbox.publishWorkerFailed(started, error);
    } finally {
      this.finishPromptRound(started.workerId);
    }
  }

  private async runPromptRound(
    attached: AttachedWorker,
    prompt: string,
    workerId: string,
  ): Promise<WorkerDispatchResult> {
    return runAttachedWorkerPrompt(
      attached,
      prompt,
      this.options.inbox.createPermissionHandler(workerId),
    );
  }

  private finishPromptRound(workerId: string): void {
    this.prompting.delete(workerId);
    if (this.prompting.size === 0) {
      for (const resolve of this.idleResolvers) {
        resolve();
      }
      this.idleResolvers.clear();
    }
  }
}
