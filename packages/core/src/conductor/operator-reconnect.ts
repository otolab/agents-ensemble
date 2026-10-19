import { isOperatorCommand } from './operator-command.js';

/** オペレータが conductor の in-process 再接続を明示した入力か。 */
export function isOperatorReconnectCommand(message: string): boolean {
  return isOperatorCommand(message, 'reconnect');
}
