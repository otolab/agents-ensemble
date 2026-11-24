import { merge } from '@modular-prompt/core';
import type { PromptModule } from '@modular-prompt/core';
import { baseModule } from './base-module.js';
import { conductorBaseModule } from './conductor-base-module.js';
import { workerBaseModule } from './worker-base-module.js';
import { ticketConductorModule } from './ticket-conductor-module.js';
import { ticketModule } from './ticket-module.js';
import { ticketWorkerModule } from './ticket-worker-module.js';

export { baseModule } from './base-module.js';
export { conductorBaseModule } from './conductor-base-module.js';
export { workerBaseModule } from './worker-base-module.js';

/** base + ticket + conductorBase + ticketConductor。profile の conductor Instructions をさらに merge する。 */
export const conductorEnsembleModule = merge(
  baseModule, ticketModule, conductorBaseModule, ticketConductorModule,
);

/** base + ticket + workerBase + ticketWorker。profile の agents.<kind> Instructions をさらに merge する。 */
export const workerEnsembleModule = merge(
  baseModule, ticketModule, workerBaseModule, ticketWorkerModule,
);

/** profile モジュールを後付け merge して system prompt 用 Instructions を組み立てる。 */
export function mergeConductorSystemPrompt(
  profileModule?: PromptModule,
): PromptModule {
  return profileModule
    ? merge(conductorEnsembleModule, profileModule)
    : conductorEnsembleModule;
}

export function mergeWorkerSystemPrompt(
  profileModule?: PromptModule,
): PromptModule {
  return profileModule
    ? merge(workerEnsembleModule, profileModule)
    : workerEnsembleModule;
}

export const mergeIssueConductorSystemPrompt = mergeConductorSystemPrompt;
export const mergeIssueWorkerSystemPrompt = mergeWorkerSystemPrompt;
