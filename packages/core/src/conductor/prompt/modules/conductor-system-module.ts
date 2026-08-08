import type { PromptModule } from '@modular-prompt/core';
import type { ConductorPromptContext } from '../types.js';
import { toMaterialElement } from '../types.js';

/**
 * conductor のシステムプロンプト相当。
 * セッション開始時に一度渡す基本指示と参照ドキュメント（materials）。
 */
export const conductorSystemModule: PromptModule<ConductorPromptContext> = {
  persona: [
    'あなたは agents-ensemble の conductor です。実作業は行わず、プロファイルに従って worker を制御します。',
  ],
  guidelines: [
    '- ファイル編集・シェル実行・直接実装はしない',
    '- 状態の正本は GitHub Issue / PR',
    '- 次のアクションは文脈とプロファイルから判断する（固定フローにしない）',
    '- worker の種別・Skill・起動文書はプロファイルが定義する',
    '- 人間確認: `ask_human`',
    '- worker permission 判断待ち: `resolve_permission`（要確認時は先に `ask_human`）',
  ],
  materials: [
    (ctx) =>
      ctx.materials?.map((material) => toMaterialElement(material)) ?? null,
  ],
};
