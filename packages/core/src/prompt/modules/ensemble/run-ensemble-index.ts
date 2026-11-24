import { merge } from '@modular-prompt/core';
import type { PromptModule } from '@modular-prompt/core';
import { baseModule } from './base-module.js';
import { conductorBaseModule } from './conductor-base-module.js';
import { runBaseModule } from './run-base-module.js';
import { runConductorBaseModule } from './run-conductor-base-module.js';
import { workerBaseModule } from './worker-base-module.js';

export const runConductorEnsembleModule = merge(
  baseModule,
  runBaseModule,
  conductorBaseModule,
  runConductorBaseModule,
);

export function mergeRunConductorSystemPrompt(
  profileModule?: PromptModule,
): PromptModule {
  return profileModule
    ? merge(runConductorEnsembleModule, profileModule)
    : runConductorEnsembleModule;
}
export function mergeRunWorkerSystemPrompt(profileModule?: PromptModule): PromptModule {
  return merge(baseModule, runBaseModule, workerBaseModule, profileModule ?? {});
}
