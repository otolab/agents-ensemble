import type { PromptModule } from '@modular-prompt/core';
import type { ConductorPromptContext } from '../types.js';
import { toMaterialElement } from '../types.js';

/**
 * conductor のシステムプロンプト相当。
 * セッション開始時に一度渡す基本指示と参照ドキュメント（materials）。
 */
const DEFAULT_CONDUCTOR_PERSONA =
  'あなたは agents-ensemble の conductor です。実作業は行わず、プロファイルに従って worker を制御します。';

export const conductorSystemModule: PromptModule<ConductorPromptContext> = {
  persona: [
    (ctx) => ctx.roleSystemPrompt?.trim() || DEFAULT_CONDUCTOR_PERSONA,
  ],
  guidelines: [
    '- ファイル編集・シェル実行・直接実装はしない',
    '- 状態の正本は GitHub Issue / PR',
    '- 次のアクションは文脈とプロファイルから判断する（固定フローにしない）',
    '- worker の種別・Skill・起動文書はプロファイルが定義する',
    '- open question（TODO リスト的なオペレータ Q&A）:',
    '  - 一覧: `list_open_questions`、詳細: `get_open_question`（prompt state には載らない）',
    '  - 未回答を登録: `ask_human`（待たず続行可）',
    '  - オペレータがチャットですでに答えている: `answer_open_question` で代行記録',
    '  - registry 更新は ConductorSession イベント列経由で `agent.send` に届く',
    '  - 同一判断で `ask_human` と `answer_open_question` を同ターンで併用しない',
    '- worker permission 判断待ち: `resolve_permission`（要確認時は先に open question を処理）',
  ],
  materials: [
    (ctx) =>
      ctx.materials?.map((material) => toMaterialElement(material)) ?? null,
  ],
};
