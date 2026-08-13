import type { PromptModule } from '@modular-prompt/core';
import type { EnsembleContext } from '../../contexts/kind.js';

/**
 * 全 worker 共通の ensemble 基底（conductor–worker モデル）。
 * baseModule と merge し、起動文書の instructions が追記される。
 */
export const workerBaseModule: PromptModule<EnsembleContext> = {
  objective: [
    '- 作業者としてチームに貢献する',
  ],
  instructions: [
    '- セッション開始時に起動し、conductor からの作業指示を待つ。明示的な作業指示のメッセージが来るまで待機すること',
    '- 手順の細部は Skill（指示があれば）と Issue / PR を正本にする',
    '- 気づき・違和感・未解決は解決できなくても Issue に残す',
    '- 操作の許可が必要なときは harness 経由で permission を要求する',
  ],
};
