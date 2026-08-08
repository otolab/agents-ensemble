import { compile, merge } from '@modular-prompt/core';
import { renderCompiledPrompt } from '../../prompt/render-compiled-prompt.js';
import { conductorSystemModule } from './modules/conductor-system-module.js';
import { conductorTurnModule } from './modules/conductor-turn-module.js';
import type { ConductorPromptContext } from './types.js';

/** 初回ターン: システムプロンプト（基本指示 + ドキュメント）+ ターン文脈。 */
export function compileConductorSessionStart(
  context: ConductorPromptContext,
): string {
  const merged = merge(conductorSystemModule, conductorTurnModule);
  return renderCompiledPrompt(compile(merged, context));
}

/** system prompt 文のみ（materials 含む）。SDK 専用 API 登場まで初回 send に含める。 */
export function compileConductorSystemPrompt(
  context: ConductorPromptContext,
): string {
  return renderCompiledPrompt(compile(conductorSystemModule, context));
}

/** 初回 `agent.send` 用（system + Issue ブリーフィング等）。 */
export function compileConductorInitialMessage(
  context: ConductorPromptContext,
): string {
  return compileConductorSessionStart(context);
}
