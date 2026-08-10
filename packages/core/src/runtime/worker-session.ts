import type { PermissionDecision } from '../acp/types.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { PermissionRequest } from '../permission/permission-request.js';
import { ConductorInbox } from './conductor-inbox.js';
import { startInboxProcessor } from './inbox-processor.js';
import type { WorkerFailureRecord } from './types.js';
import type { WorkerDispatchFn } from './worker-runtime.js';
import { WorkerRuntime } from './worker-runtime.js';
import type {
  EnsembleSessionState,
  SessionWorkerSpec,
} from '../profile/types.js';

export type { SessionWorkerSpec };

export interface WorkerSessionOptions {
  issueUrl: string;
  repoRoot: string;
  workers: SessionWorkerSpec[];
  sessionState: EnsembleSessionState;
  /** resume 時に復元する worker 名 → ACP session id。 */
  restoredWorkerSessions?: Record<string, string>;
  dispatchWorker?: WorkerDispatchFn;
  permissionPipeline?: PermissionPipeline;
  decidePermission?: (
    request: PermissionRequest,
    workerId: string,
    requestId: string,
  ) => PermissionDecision | null | Promise<PermissionDecision | null>;
  onWorkerCompleted?: (result: WorkerDispatchResult) => void;
  onWorkerFailed?: (failure: WorkerFailureRecord) => void;
}

/**
 * 1 Issue セッションの worker 群。
 * conductor とは inbox 経由で接続し、セッション開始時に worker を起動する。
 */
export class WorkerSession {
  readonly inbox = new ConductorInbox();
  readonly runtime: WorkerRuntime;
  readonly startedWorkerIds: string[] = [];

  private readonly processor;

  constructor(private readonly options: WorkerSessionOptions) {
    if (!options.permissionPipeline && !options.decidePermission) {
      throw new Error(
        'WorkerSession requires permissionPipeline or decidePermission',
      );
    }

    const decidePermission =
      options.decidePermission ??
      ((request, workerId, requestId) => {
        const outcome = options.permissionPipeline!.evaluate(
          requestId,
          workerId,
          request,
        );
        return outcome.status === 'resolved' ? outcome.decision : null;
      });

    this.runtime = new WorkerRuntime({
      inbox: this.inbox,
      dispatchWorker: options.dispatchWorker,
    });
    this.processor = startInboxProcessor({
      inbox: this.inbox,
      decidePermission,
      onWorkerCompleted: options.onWorkerCompleted,
      onWorkerFailed: options.onWorkerFailed,
    });
  }

  /** プロファイルで指定された worker を起動する。 */
  bootstrap(): void {
    for (const worker of this.options.workers) {
      const workerId = this.runtime.start({
        name: worker.name,
        issueUrl: this.options.issueUrl,
        kind: worker.kind,
        systemPrompt: worker.systemPrompt,
        repoRoot: this.options.repoRoot,
        sessionState: this.options.sessionState,
        resumeAcpSessionId:
          this.options.restoredWorkerSessions?.[worker.name],
      });
      this.startedWorkerIds.push(workerId);
    }
  }

  async stop(): Promise<void> {
    await this.runtime.waitForIdle();
    await this.processor.stop();
  }
}
