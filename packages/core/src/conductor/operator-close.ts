/** オペレータが worktree を残してセッションを閉じる入力か。 */
export function isOperatorCloseCommand(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === '/close' || normalized === 'close';
}
