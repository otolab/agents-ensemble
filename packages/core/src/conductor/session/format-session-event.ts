import yaml from 'js-yaml';
import type { SessionEvent } from './session-event.js';

/** セッションイベントを conductor 向け user メッセージ文字列に変換する。 */
export function formatSessionEventForConductor(event: SessionEvent): string {
  switch (event.type) {
    case 'operator.message':
      return event.text.trim();
    case 'worker.completed':
      return [
        '## worker 完了',
        '',
        fencedYaml('worker.completed', event.result),
      ].join('\n');
    case 'worker.failed':
      return [
        '## worker 失敗',
        '',
        fencedYaml('worker.failed', event.failure),
      ].join('\n');
    case 'permission.pending':
      return [
        '## permission 判断待ち',
        '',
        fencedYaml('permission.pending', event.permission),
      ].join('\n');
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

function fencedYaml(label: string, data: unknown): string {
  return ['```yaml', `# ${label}`, yaml.dump(data, { lineWidth: 120 }).trimEnd(), '```'].join(
    '\n',
  );
}
