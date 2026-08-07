import { randomUUID } from 'node:crypto';
import type { PermissionDecision, PermissionHandler } from '../acp/types.js';
import { parsePermissionRequest } from '../permission/permission-request.js';
import type { WorkerDispatchResult } from '../dispatch/worker-dispatch.js';
import type { InboxListener, InboxMessage, WorkerStartedInfo } from './types.js';

interface PermissionWaiter {
  resolve: (decision: PermissionDecision) => void;
  reject: (error: unknown) => void;
}

export class ConductorInbox {
  private readonly listeners = new Set<InboxListener>();
  private readonly permissionWaiters = new Map<string, PermissionWaiter>();
  private notifyChain: Promise<void> = Promise.resolve();

  subscribe(listener: InboxListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  createPermissionHandler(workerId: string): PermissionHandler {
    return (params) => this.requestPermission(workerId, params);
  }

  async requestPermission(
    workerId: string,
    params: unknown,
  ): Promise<PermissionDecision> {
    const id = randomUUID();
    const request = parsePermissionRequest(params);

    return new Promise<PermissionDecision>((resolve, reject) => {
      this.permissionWaiters.set(id, { resolve, reject });
      this.enqueueNotify({ type: 'permission.request', id, workerId, request });
    });
  }

  fulfillPermission(id: string, decision: PermissionDecision): void {
    const waiter = this.permissionWaiters.get(id);
    if (!waiter) return;
    this.permissionWaiters.delete(id);
    waiter.resolve(decision);
  }

  rejectPermission(id: string, error: unknown): void {
    const waiter = this.permissionWaiters.get(id);
    if (!waiter) return;
    this.permissionWaiters.delete(id);
    waiter.reject(error);
  }

  publishWorkerCompleted(
    workerId: string,
    result: WorkerDispatchResult,
  ): void {
    this.enqueueNotify({ type: 'worker.completed', workerId, result });
  }

  publishWorkerFailed(started: WorkerStartedInfo, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.enqueueNotify({
      type: 'worker.failed',
      workerId: started.workerId,
      error: message,
      issueUrl: started.issueUrl,
      skillName: started.skillName,
    });
  }

  private enqueueNotify(message: InboxMessage): void {
    this.notifyChain = this.notifyChain.then(() => this.notify(message));
  }

  private async notify(message: InboxMessage): Promise<void> {
    for (const listener of this.listeners) {
      await listener(message);
    }
  }

  async drain(): Promise<void> {
    await this.notifyChain;
  }
}
