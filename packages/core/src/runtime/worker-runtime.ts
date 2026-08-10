import { randomUUID } from 'node:crypto';
import {
  dispatchWorker,
  type WorkerDispatchOptions,
  type WorkerDispatchResult,
} from '../dispatch/worker-dispatch.js';
import { ConductorInbox } from './conductor-inbox.js';
import type { WorkerStartedInfo, WorkerStartParams } from './types.js';

export type WorkerDispatchFn = (
  options: WorkerDispatchOptions,
) => Promise<WorkerDispatchResult>;

export interface WorkerRuntimeOptions {
  inbox: ConductorInbox;
  dispatchWorker?: WorkerDispatchFn;
}

export class WorkerRuntime {
  private readonly running = new Map<string, WorkerStartedInfo>();
  private readonly idleResolvers = new Set<() => void>();
  private readonly dispatchWorkerFn: WorkerDispatchFn;

  constructor(private readonly options: WorkerRuntimeOptions) {
    this.dispatchWorkerFn = options.dispatchWorker ?? dispatchWorker;
  }

  get runningCount(): number {
    return this.running.size;
  }

  listRunning(): WorkerStartedInfo[] {
    return [...this.running.values()];
  }

  start(params: WorkerStartParams): string {
    const workerId = randomUUID();
    const started: WorkerStartedInfo = { workerId, ...params };
    this.running.set(workerId, started);
    void this.run(started);
    return workerId;
  }

  async waitForIdle(): Promise<void> {
    if (this.running.size === 0) return;
    await new Promise<void>((resolve) => {
      this.idleResolvers.add(resolve);
    });
  }

  private async run(started: WorkerStartedInfo): Promise<void> {
    try {
      const result = await this.dispatchWorkerFn({
        name: started.name,
        issueUrl: started.issueUrl,
        kind: started.kind,
        systemPrompt: started.systemPrompt,
        repoRoot: started.repoRoot,
        sessionState: started.sessionState,
        resumeAcpSessionId: started.resumeAcpSessionId,
        permissionHandler: this.options.inbox.createPermissionHandler(
          started.workerId,
        ),
      });
      this.options.inbox.publishWorkerCompleted(started.workerId, result);
    } catch (error) {
      this.options.inbox.publishWorkerFailed(started, error);
    } finally {
      this.running.delete(started.workerId);
      if (this.running.size === 0) {
        for (const resolve of this.idleResolvers) {
          resolve();
        }
        this.idleResolvers.clear();
      }
    }
  }
}
