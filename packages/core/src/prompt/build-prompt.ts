export interface WorkerPromptOptions {
  issueUrl: string;
  skillName: string;
  worktreePath?: string;
}

const BOOTSTRAP =
  'personaとfoundationモードを有効にしてください。本文をresourceから読み込むのも忘れずに。';

export function buildWorkerPrompt(options: WorkerPromptOptions): string {
  const lines = [
    BOOTSTRAP,
    '',
    '次のIssueに対応してください。',
    options.issueUrl,
    '',
    `作業 Skill: ${options.skillName}`,
    '',
    '作業ブランチを切り、worktreeを作成して作業します。',
    'SKILL文書に沿って丁寧に作業してください。',
    '',
    '調査結果や作業方針決定のタイミングで、Issueに小さく報告するようにしてください。',
  ];

  if (options.worktreePath) {
    lines.push('', `作業 worktree: ${options.worktreePath}`);
  }

  return lines.join('\n');
}

export interface ReviewerPromptOptions {
  prUrl: string;
  skillName: string;
  worktreePath: string;
}

export function buildReviewerPrompt(options: ReviewerPromptOptions): string {
  return [
    BOOTSTRAP,
    '',
    '次のPRをレビューしてください。',
    options.prUrl,
    '',
    `レビュー Skill: ${options.skillName}`,
    '',
    'worktreeを作成しているので、そこに入って検討します。',
    `作業 worktree: ${options.worktreePath}`,
  ].join('\n');
}
