import { expect } from 'vitest';

/** conductor へ届く worker.completed イベントメッセージか（system prompt 内の説明文と区別）。 */
export function isWorkerCompletedConductorMessage(message: string): boolean {
  return (
    message.includes('```yaml\n# worker.completed') &&
    message.includes('## worker ラウンド完了')
  );
}

/** integration 専用。`js-yaml` のスカラー行形式に依存（ネスト・複数行値は非対応）。 */
export function extractYamlScalar(message: string, key: string): string | undefined {
  const match = message.match(new RegExp(`^${key}: '?([^'\\n]+)'?$`, 'm'));
  return match?.[1]?.trim();
}

export function extractWorkerCompletedSource(message: string): string | undefined {
  return extractYamlScalar(message, 'source');
}

/** 旧 follow-up prompt（毎ターン full state 投影）の名残がないこと。 */
export function expectNotLegacyFollowUpPrompt(message: string): void {
  expect(message).not.toMatch(/完了した worker/);
  expect(message).not.toMatch(/人間オペレータからの入力:/);
}
