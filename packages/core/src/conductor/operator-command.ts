export const OPERATOR_COMMANDS = [
  {
    id: 'reconnect',
    name: '/reconnect',
    aliases: ['reconnect'],
    description: 'conductor を再接続',
  },
  {
    id: 'exit',
    name: '/exit',
    aliases: ['exit'],
    description: 'セッションを終了',
  },
] as const;

export type OperatorCommandId = (typeof OPERATOR_COMMANDS)[number]['id'];

/** Operator input が専用処理するコマンドか。 */
export function isOperatorCommand(message: string, id: OperatorCommandId): boolean {
  const normalized = message.trim().toLowerCase();
  const command = OPERATOR_COMMANDS.find((candidate) => candidate.id === id);
  return (
    command !== undefined &&
    (normalized === command.name ||
      command.aliases.some((alias) => normalized === alias.toLowerCase()))
  );
}
