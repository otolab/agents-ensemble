import { isOperatorCommand } from './operator-command.js';

/** オペレータがセッション終了を明示した入力か。 */
export function isOperatorExitCommand(message: string): boolean {
  return isOperatorCommand(message, 'exit');
}
