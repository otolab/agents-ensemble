export function buildHumanGuidancePrompt(guidance: string): string {
  return [
    '人間オペレータからの指示を受け取りました。Issue / PR の最新状態を踏まえ、次のアクションを判断してください。',
    '',
    '## 人間オペレータからの指示',
    guidance.trim(),
    '',
    '## 次の判断',
    '- 作業が必要なら `dispatch_worker`',
    '- PR レビューが必要なら `dispatch_reviewer`（既存 worktree を使用）',
    '- 追加確認が必要なら `ask_human`',
    '- 完了なら追加 dispatch はせず終了',
  ].join('\n');
}
