import type { SpawnAcpProcessOptions } from '../acp/acp-process.js';
import type { PermissionDecision } from '../acp/types.js';
import type { WorktreeRef } from '../worktree/worktree.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { ConnectWorkerAcpFn } from '../dispatch/worker-acp-session.js';
import type { SendWorkerMessageOptions, SendWorkerMessageResult } from './send-worker-message.js';
import type { PermissionPipeline } from '../permission/permission-pipeline.js';
import type { PermissionRequest } from '../permission/permission-request.js';
import { ConductorInbox } from './conductor-inbox.js';
import { startInboxProcessor } from './inbox-processor.js';
import type { WorkerFailureRecord } from './types.js';
import { WorkerRuntime } from './worker-runtime.js';
import type {
  EnsembleSessionState,
  SessionWorkerSpec,
} from '../profile/types.js';

export type { SessionWorkerSpec };

export interface WorkerSessionOptions {
  issueUrl: string;
  /** Conductor が worker 起動前に resolve した作業ディレクトリ（worker ありのとき必須）。 */
  worktree?: WorktreeRef;
  workers: SessionWorkerSpec[];
  sessionState: EnsembleSessionState;
  /** resume 時に復元する worker 名 → ACP session id。 */
  restoredWorkerSessions?: Record<string, string>;
  connectAcp?: ConnectWorkerAcpFn;
  spawn?: SpawnAcpProcessOptions;
  /** integration の共有 bridge 注入時は false（既定 true）。 */
  ownsWorkerAcpConnections?: boolean;
  permissionPipeline?: PermissionPipeline;
  decidePermission?: (
    request: PermissionRequest,
    workerId: string,
    requestId: string,
  ) => PermissionDecision | null | Promise<PermissionDecision | null>;
  onWorkerCompleted?: (result: WorkerDispatchResult) => void;
  onWorkerFailed?: (failure: WorkerFailureRecord) => void;
  onPromptTelemetry?: (event: import('./types.js').WorkerPromptTelemetry) => void;
  onAcpUpdate?: (event: import('./types.js').WorkerAcpUpdateTelemetry) => void;
}

/**
 * 1 Issue セッションの worker 群。
 * conductor とは inbox 経由で接続し、セッション開始時に worker を attach する。
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
      ...(options.connectAcp ? { connectAcp: options.connectAcp } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.ownsWorkerAcpConnections !== undefined
        ? { ownsWorkerAcpConnections: options.ownsWorkerAcpConnections }
        : {}),
      ...(options.onPromptTelemetry
        ? { onPromptTelemetry: options.onPromptTelemetry }
        : {}),
      ...(options.onAcpUpdate ? { onAcpUpdate: options.onAcpUpdate } : {}),
    });
    this.processor = startInboxProcessor({
      inbox: this.inbox,
      decidePermission,
      onWorkerCompleted: options.onWorkerCompleted,
      onWorkerFailed: options.onWorkerFailed,
    });
  }

  /** プロファイルで指定された worker を attach し init prompt ラウンドを開始する。 */
  startWorkers(): void {
    if (this.options.workers.length > 0 && !this.options.worktree) {
      throw new Error('WorkerSession requires worktree when workers are configured');
    }
    for (const worker of this.options.workers) {
      const workerId = this.runtime.start({
        name: worker.name,
        issueUrl: this.options.issueUrl,
        kind: worker.kind,
        prompt: worker.prompt,
        worktree: this.options.worktree!,
        sessionState: this.options.sessionState,
        resumeAcpSessionId:
          this.options.restoredWorkerSessions?.[worker.name],
      });
      this.startedWorkerIds.push(workerId);
    }
  }

  /**
   * @deprecated Use {@link WorkerSession.startWorkers}.
   */
  bootstrap(): void {
    this.startWorkers();
  }

  /** 常駐 worker へ作業指示を送る（`session/prompt`）。 */
  sendWorkerMessage(
    name: string,
    instruction: string,
    options?: SendWorkerMessageOptions,
  ): SendWorkerMessageResult {
    return this.runtime.sendWorkerMessage(name, instruction, options);
  }

  async stop(): Promise<void> {
    await this.runtime.shutdown();
    await this.processor.stop();
  }
}
