import type { PromptModule } from '@modular-prompt/core';
import type { EnsembleContext } from '../../contexts/kind.js';

/**
 * 全 worker 共通の ensemble 基底（conductor–worker モデル）。
 * baseModule と merge し、起動文書の instructions が追記される。
 *
 * FIXME(#36): conductor → worker の session/prompt 経路は未実装。
 * プロンプト文言は目標仕様の仮置き。実装後に突き合わせて修正する。
 */
export const workerBaseModule: PromptModule<EnsembleContext> = {
  objective: [
    // FIXME(#36): 作業指示の受信経路は未実装。目標仕様の仮置き。
    'セッション開始時に起動し、conductor からの作業指示を待つ。',
  ],
  instructions: [
    // FIXME(#36): session/prompt 経路は未実装。文言は harness 実装後に修正する。
    '- 作業指示が届いたら Issue / PR を正本として動く',
    '- 起動後は作業指示が来るまで待機してよい',
    '- conductor との直接会話経路はない（作業指示と permission 以外）',
    '- 気づき・違和感・未解決は解決できなくても Issue に残す',
    '- 操作の許可が必要なときは harness 経由で permission を要求する',
    '- 手順の細部は Skill（指示があれば）と Issue / PR を正本にする',
  ],
};
