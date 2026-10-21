import type { OperatorMessageDelivery } from './session/session-event.js';

export const OPERATOR_COMMANDS = [
  {
    id: 'delivery-idle',
    name: '/idle',
    aliases: [],
    description: '自律処理が落ち着いてから届ける',
  },
  {
    id: 'delivery-next',
    name: '/next',
    aliases: [],
    description: '次の dispatch で届ける',
  },
  {
    id: 'delivery-interrupt',
    name: '/interrupt',
    aliases: [],
    description: '実行中の conductor を中断して届ける',
  },
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
  {
    id: 'close',
    name: '/close',
    aliases: ['close'],
    description: 'worktree を残してセッションを閉じる',
  },
] as const;

export type OperatorCommandId = (typeof OPERATOR_COMMANDS)[number]['id'];

export interface ParsedOperatorMessageDelivery {
  message: string;
  delivery: OperatorMessageDelivery;
}

/** `/idle message` などの先頭 prefix を取り除いて配信モードを解決する。 */
export function parseOperatorMessageDelivery(
  input: string,
): ParsedOperatorMessageDelivery {
  const match = /^[\t ]*\/(idle|next|interrupt)(?:[\t ]+([\s\S]*))?$/iu.exec(
    input,
  );
  if (!match) {
    return { message: input, delivery: 'next' };
  }
  return {
    message: match[2] ?? '',
    delivery: match[1]!.toLowerCase() as OperatorMessageDelivery,
  };
}

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
