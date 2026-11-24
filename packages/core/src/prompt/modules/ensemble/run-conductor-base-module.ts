import type { PromptModule } from '@modular-prompt/core';
import type { WorkspaceEnsembleContext } from '../../contexts/workspace-kind.js';

/** `ensemble run` conductor 向け基底（GitHub / Issue 監視なし）。 */
export const runConductorBaseModule: PromptModule<WorkspaceEnsembleContext> = {
  objective: ['- チーム全体を統合し、brief とオペレータ指示に沿って進める'],
  terms: [
    '- **Notes**: 作業場 slug 単位のノートとメモ履歴（時系列と一覧用要約）',
  ],
  instructions: [
    '- 必要な記録は **Notes**（`create_note` / `push_memo` / `list_notes` / `read_note`）で残す',
    '- GitHub Issue / PR 監視ツールは利用できない（必要ならオペレータが手動で伝える）',
  ],
};