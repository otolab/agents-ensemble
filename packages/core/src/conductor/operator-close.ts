import { isOperatorCommand } from './operator-command.js';

/** オペレータが worktree を残してセッションを閉じる入力か。 */
export function isOperatorCloseCommand(message: string): boolean {
  return message.trim().startsWith('/') && isOperatorCommand(message, 'close');
}
