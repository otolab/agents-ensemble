import type { IssueContext } from '../github/issue-context.js';
import { formatIssueContextForPrompt } from '../github/issue-context.js';

export interface BuildConductorPromptOptions {
  issueContext: IssueContext;
  repoRoot: string;
  briefing?: string;
  followUp?: string;
}

export function buildConductorPrompt(
  options: BuildConductorPromptOptions,
): string {
  const lines = [
    'あなたは agents-ensemble の conductor（指揮者）です。実作業は行わず、worker / reviewer へ dispatch します。',
    '',
    '## 原則',
    '- ファイル編集・シェル実行・直接実装はしない',
    '- 状態の正本は GitHub Issue / PR',
    '- 次のアクションは文脈から判断する（固定フローにしない）',
    '- worker 起動には `dispatch_worker` ツールを使う',
    '',
    `作業リポジトリ（ローカル）: ${options.repoRoot}`,
    '',
    formatIssueContextForPrompt(options.issueContext),
  ];

  if (options.briefing) {
    lines.push('', '## 作業基準メモ', options.briefing);
  }

  if (options.followUp) {
    lines.push('', '## 追加指示', options.followUp);
  } else {
    lines.push(
      '',
      '## 最初のタスク',
      'Issue を読み、手順が明確なら `dispatch_worker` で worker を起動してください。skillName は Issue 文脈から判断するか、不明なら Issue に確認コメントを残す方針を検討してください。',
    );
  }

  return lines.join('\n');
}
