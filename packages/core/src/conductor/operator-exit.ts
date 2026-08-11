/** オペレータがセッション終了を明示した入力か。 */
export function isOperatorExitCommand(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === '/exit' || normalized === 'exit';
}
