import type { LlmUsageRecord } from './types.js';

/** UTF-8 バイト長 ÷ 4 の切り上げ。worker ACP で usage 未報告時の近似。 */
export function estimateTokenUsageFromText(input: {
  promptText?: string;
  responseText?: string;
}): LlmUsageRecord {
  const inputTokens = estimateTokens(input.promptText ?? '');
  const outputTokens = estimateTokens(input.responseText ?? '');
  return {
    source: 'estimated',
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}
