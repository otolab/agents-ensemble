import { expect } from 'vitest';

/** conductor 向け YAML ブロックからスカラー値を抜き出す（integration テスト用）。 */
export function extractYamlScalar(message: string, key: string): string | undefined {
  const match = message.match(new RegExp(`^${key}: '?([^'\\n]+)'?$`, 'm'));
  return match?.[1]?.trim();
}

/** 旧 follow-up prompt（毎ターン full state 投影）の名残がないこと。 */
export function expectNotLegacyFollowUpPrompt(message: string): void {
  expect(message).not.toMatch(/完了した worker/);
  expect(message).not.toMatch(/人間オペレータからの入力:/);
}
