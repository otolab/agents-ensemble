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
  /** Called when policy verdict is `ask`. Defaults to the backend's allow-once option. */
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

  decide(
    params: unknown,
    sessionLabel?: string,
  ): Promise<PermissionDecision> {
    return this.enqueue(() => this.handle(params, sessionLabel));
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
      return allowOnce(request);
    }
    if (verdict === 'deny') {
      return deny(request);
    }

    const onAsk = this.options.onAsk ?? defaultAllowOnceAskHandler;
    return onAsk({
      ...request,
      sessionId: request.sessionId ?? sessionLabel,
    });
  }
}

export function allowOnce(
  request?: Pick<PermissionRequest, 'options'>,
): PermissionDecision {
  const optionId = selectPermissionOptionId(request, 'allow');
  if (!optionId) {
    return DEFAULT_PERMISSION_DECISION;
  }

  return {
    outcome: { outcome: 'selected', optionId },
  };
}

export function deny(
  request?: Pick<PermissionRequest, 'options'>,
): PermissionDecision {
  const optionId = selectPermissionOptionId(request, 'deny');
  if (optionId) {
    return {
      outcome: { outcome: 'selected', optionId },
    };
  }

  return {
    outcome: { outcome: 'selected', optionId: 'deny' },
  };
}

function selectPermissionOptionId(
  request: Pick<PermissionRequest, 'options'> | undefined,
  intent: 'allow' | 'deny',
): string | undefined {
  const preferredKinds =
    intent === 'allow'
      ? ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always'];

  for (const kind of preferredKinds) {
    const option = request?.options?.find((candidate) => candidate.kind === kind);
    if (option) {
      return option.optionId;
    }
  }

  return undefined;
}

function defaultAllowOnceAskHandler(request: PermissionRequest): PermissionDecision {
  return allowOnce(request);
}
