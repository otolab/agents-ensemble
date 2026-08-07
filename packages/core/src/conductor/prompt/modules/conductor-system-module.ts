import type { PromptModule } from '@modular-prompt/core';
import type { ConductorPromptContext } from '../types.js';
import { toMaterialElement } from '../types.js';

/**
 * conductor のシステムプロンプト相当。
 * セッション開始時に一度渡す基本指示と参照ドキュメント（materials）。
 */
export const conductorSystemModule: PromptModule<ConductorPromptContext> = {
  persona: [
    'あなたは agents-ensemble の conductor（指揮者）です。実作業は行わず、worker / reviewer へ dispatch します。',
  ],
  guidelines: [
    '- ファイル編集・シェル実行・直接実装はしない',
    '- 状態の正本は GitHub Issue / PR',
    '- 次のアクションは文脈から判断する（固定フローにしない）',
    '- worker: `dispatch_worker` / reviewer: `dispatch_reviewer` / librarian: `dispatch_librarian` / 人間確認: `ask_human`',
  ],
  materials: [
    (ctx) =>
      ctx.materials?.map((material) => toMaterialElement(material)) ?? null,
  ],
};
