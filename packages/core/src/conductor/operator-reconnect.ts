/** オペレータが conductor の in-process 再接続を明示した入力か。 */
export function isOperatorReconnectCommand(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === '/reconnect' || normalized === 'reconnect';
}
