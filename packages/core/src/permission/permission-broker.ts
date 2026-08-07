import type { PermissionDecision, PermissionHandler } from '../acp/types.js';
import { DEFAULT_PERMISSION_DECISION } from '../acp/types.js';
import {
  evaluatePermissionPolicy,
  type PermissionPolicyRules,
  type PermissionVerdict,
} from './permission-policy.js';
import {
  parsePermissionRequest,
  type PermissionRequest,
} from './permission-request.js';

export type PermissionAskHandler = (
  request: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

export interface PermissionBrokerOptions {
  policy?: PermissionPolicyRules;
  /** Called when policy verdict is `ask`. Defaults to allow-once. */
  onAsk?: PermissionAskHandler;
  /** Label for logs (e.g. worker session id). */
  sessionLabel?: string;
}

export interface PermissionBrokerDecision {
  request: PermissionRequest;
  verdict: PermissionVerdict;
  decision: PermissionDecision;
}

export class PermissionBroker {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: PermissionBrokerOptions = {}) {}

  createHandler(sessionLabel?: string): PermissionHandler {
    const label = sessionLabel ?? this.options.sessionLabel;

    return (params) =>
      this.enqueue(() => this.handle(params, label));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handle(
    params: unknown,
    sessionLabel?: string,
  ): Promise<PermissionDecision> {
    const request = parsePermissionRequest(params);
    const verdict = evaluatePermissionPolicy(request, this.options.policy);
    const decision = await this.verdictToDecision(verdict, request, sessionLabel);
    return decision;
  }

  private async verdictToDecision(
    verdict: PermissionVerdict,
    request: PermissionRequest,
    sessionLabel?: string,
  ): Promise<PermissionDecision> {
    if (verdict === 'allow') {
      return allowOnce();
    }
    if (verdict === 'deny') {
      return deny();
    }

    const onAsk = this.options.onAsk ?? defaultAllowOnceAskHandler;
    return onAsk({
      ...request,
      sessionId: request.sessionId ?? sessionLabel,
    });
  }
}

export function allowOnce(): PermissionDecision {
  return DEFAULT_PERMISSION_DECISION;
}

export function deny(): PermissionDecision {
  return {
    outcome: { outcome: 'selected', optionId: 'deny' },
  };
}

function defaultAllowOnceAskHandler(): PermissionDecision {
  return allowOnce();
}
