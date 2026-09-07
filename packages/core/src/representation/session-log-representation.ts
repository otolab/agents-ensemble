import type { SessionLogEvent } from '../conductor/session/events/session-log-event.js';
import { formatPermissionSummaryForOperator } from '../permission/format-permission-summary-for-operator.js';

export type SessionLogRepresentationEventType = SessionLogEvent['type'];

export type SessionLogRenderer<Type extends SessionLogRepresentationEventType> = (
  event: Extract<SessionLogEvent, { type: Type }>,
) => string | undefined;

type RegisteredSessionLogRenderer = (
  event: SessionLogEvent,
) => string | undefined;

/**
 * SessionLogEvent の表示表現をイベント型ごとに登録・解決する core 側の入口。
 *
 * 出力経路（stderr / TUI 活動ログ）が同じ表現を使えるよう、sink はこの
 * representation にイベントを渡すだけにする。未登録のイベントは undefined
 * を返し、sink 側の既存フォーマットへフォールバックできる。
 */
export interface SessionLogRepresentation {
  register<Type extends SessionLogRepresentationEventType>(
    type: Type,
    renderer: SessionLogRenderer<Type>,
  ): void;
  render(event: SessionLogEvent): string | undefined;
}

class DefaultSessionLogRepresentation implements SessionLogRepresentation {
  private readonly renderers = new Map<
    SessionLogRepresentationEventType,
    RegisteredSessionLogRenderer
  >();

  register<Type extends SessionLogRepresentationEventType>(
    type: Type,
    renderer: SessionLogRenderer<Type>,
  ): void {
    this.renderers.set(type, renderer as RegisteredSessionLogRenderer);
  }

  render(event: SessionLogEvent): string | undefined {
    return this.renderers.get(event.type)?.(event);
  }
}

export function createSessionLogRepresentation(): SessionLogRepresentation {
  return new DefaultSessionLogRepresentation();
}

/** 既定の operator 向け SessionLogEvent representation。 */
export const sessionLogRepresentation = createSessionLogRepresentation();

/** 既定 registry にイベント型 renderer を追加する登録入口。 */
export function registerSessionLogRenderer<
  Type extends SessionLogRepresentationEventType,
>(
  type: Type,
  renderer: SessionLogRenderer<Type>,
): void {
  sessionLogRepresentation.register(type, renderer);
}

/** 既定 registry から operator 向け 1 行表現を解決する入口。 */
export function renderSessionLogEvent(
  event: SessionLogEvent,
): string | undefined {
  return sessionLogRepresentation.render(event);
}

registerSessionLogRenderer('permission.pending', (event) =>
  formatPermissionSummaryForOperator(event.permission, {
    workerLabel: event.workerLabel,
  }),
);
