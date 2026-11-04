import type { OperatorInputContext } from '@agents-ensemble/core';
import { wrapTextToWidth } from './wrap-text-to-width.js';

/** 一覧は読み取り専用。本文は改行を畳み、幅に収まらない分を省略する。 */
export function messageQueueLines(
  messages: NonNullable<OperatorInputContext['queuedMessages']>,
  width: number,
  terminalRows: number,
  offset = 0,
): string[] {
  if (messages.length === 0) return [];
  const limit = messageQueuePageSize(terminalRows);
  const start = Math.max(0, Math.min(offset, messages.length - limit));
  const shown = messages.slice(start, start + limit);
  const lines = shown.map((message) => {
    const text = message.text.replace(/\s+/gu, ' ').trim();
    const line = `${message.openQuestionAnswer ? 'answer' : 'message'} ${message.delivery} │ ${text}`;
    const wrapped = wrapTextToWidth(line, Math.max(1, width - 1));
    return wrapped.length > 1 ? `${wrapped[0]}…` : wrapped[0];
  });
  const title = messages.length > limit
    ? `Message queue (${start + 1}-${start + shown.length}/${messages.length}) Ctrl+↑/↓`
    : `Message queue (${messages.length})`;
  return [wrapTextToWidth(title, Math.max(1, width))[0], ...lines];
}

export function messageQueuePageSize(terminalRows: number): number {
  return Math.max(1, Math.floor(terminalRows / 4) - 2);
}
