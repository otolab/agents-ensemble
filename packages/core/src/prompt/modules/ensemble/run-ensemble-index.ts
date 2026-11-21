import { merge } from '@modular-prompt/core';
import type { PromptModule } from '@modular-prompt/core';
import { runBaseModule } from './run-base-module.js';
import { runConductorBaseModule } from './run-conductor-base-module.js';

export const runConductorEnsembleModule = merge(
  runBaseModule,
  runConductorBaseModule,
);

export function mergeRunConductorSystemPrompt(
  profileModule?: PromptModule,
): PromptModule {
  return profileModule
    ? merge(runConductorEnsembleModule, profileModule)
    : runConductorEnsembleModule;
}