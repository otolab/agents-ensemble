import yaml from 'js-yaml';
import type { SessionEvent } from './session-event.js';

/** セッションイベントを conductor 向け user メッセージ文字列に変換する。 */
export function formatSessionEventForConductor(event: SessionEvent): string {
  return formatSessionEventsForConductor([event]);
}

/** 1 件以上のセッションイベントを 1 本の user メッセージに合成する。 */
export function formatSessionEventsForConductor(events: SessionEvent[]): string {
  if (events.length === 0) {
    return '';
  }
  if (events.length === 1) {
    return formatSingleSessionEventForConductor(events[0]!);
  }
  return formatBatchedSessionEventsForConductor(events);
}

function formatSingleSessionEventForConductor(event: SessionEvent): string {
  switch (event.type) {
    case 'operator.message':
      return event.text.trim();
    case 'worker.completed': {
      const heading =
        event.result.roundKind === 'bootstrap'
          ? '## worker bootstrap 完了'
          : '## worker 作業ラウンド完了';
      return [
        heading,
        '',
        formatEventBodyForConductor(event),
      ].join('\n');
    }
    case 'worker.failed':
      return ['## worker 失敗', '', formatEventBodyForConductor(event)].join('\n');
    case 'permission.pending':
      return [
        '## permission 判断待ち',
        '',
        formatEventBodyForConductor(event),
      ].join('\n');
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

function formatEventBodyForConductor(event: SessionEvent): string {
  switch (event.type) {
    case 'operator.message':
      return event.text.trim();
    case 'worker.completed':
      return fencedYaml('worker.completed', event.result);
    case 'worker.failed':
      return fencedYaml('worker.failed', event.failure);
    case 'permission.pending':
      return fencedYaml('permission.pending', event.permission);
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

function formatBatchedSessionEventsForConductor(events: SessionEvent[]): string {
  const heading = batchHeadingForEvents(events);
  const sections = events.map((event, index) => {
    const body = formatEventBodyForConductor(event);
    return [`### ${index + 1}/${events.length}`, '', body].join('\n');
  });
  return [heading, '', ...sections].join('\n\n');
}

function batchHeadingForEvents(events: SessionEvent[]): string {
  const count = events.length;
  if (events.every((event) => event.type === 'operator.message')) {
    return `## オペレータ入力（${count} 件）`;
  }
  if (events.every((event) => event.type === 'permission.pending')) {
    return `## permission 判断待ち（${count} 件）`;
  }

  const workerEvents = events.filter(
    (event) => event.type === 'worker.completed' || event.type === 'worker.failed',
  );
  if (workerEvents.length === events.length) {
    const name =
      workerEvents[0]!.type === 'worker.completed'
        ? workerEvents[0]!.result.name
        : workerEvents[0]!.failure.name;
    const completedCount = workerEvents.filter(
      (event) => event.type === 'worker.completed',
    ).length;
    const failedCount = workerEvents.filter(
      (event) => event.type === 'worker.failed',
    ).length;
    if (failedCount > 0 && completedCount > 0) {
      return `## worker 通知（${name}・${count} 件）`;
    }
    if (failedCount === count) {
      return `## worker 失敗（${name}・${count} 件）`;
    }
    const bootstrapCount = workerEvents.filter(
      (event) =>
        event.type === 'worker.completed' &&
        event.result.roundKind === 'bootstrap',
    ).length;
    if (bootstrapCount === completedCount) {
      return `## worker bootstrap 完了（${name}・${count} 件）`;
    }
    return `## worker 作業ラウンド完了（${name}・${count} 件）`;
  }

  return `## セッションイベント（${count} 件）`;
}

function fencedYaml(label: string, data: unknown): string {
  return ['```yaml', `# ${label}`, yaml.dump(data, { lineWidth: 120 }).trimEnd(), '```'].join(
    '\n',
  );
}
