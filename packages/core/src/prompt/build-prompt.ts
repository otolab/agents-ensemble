import { compile, merge } from '@modular-prompt/core';
import { bootstrapModule } from './modules/bootstrap.js';
import { reviewerPromptModule } from './modules/reviewer-module.js';
import { workerPromptModule } from './modules/worker-module.js';
import { renderCompiledPrompt } from './render-compiled-prompt.js';

export interface WorkerPromptOptions {
  issueUrl: string;
  skillName: string;
  worktreePath?: string;
}

export function buildWorkerPrompt(options: WorkerPromptOptions): string {
  const module = merge(bootstrapModule, workerPromptModule);
  const compiled = compile(module, options);
  return renderCompiledPrompt(compiled);
}

export interface ReviewerPromptOptions {
  prUrl: string;
  skillName: string;
  worktreePath: string;
}

export function buildReviewerPrompt(options: ReviewerPromptOptions): string {
  const module = merge(bootstrapModule, reviewerPromptModule);
  const compiled = compile(module, options);
  return renderCompiledPrompt(compiled);
}
