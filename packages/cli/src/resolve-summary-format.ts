export type IssueSummaryFormat = 'auto' | 'json' | 'text';

export type ResolvedIssueSummaryFormat = 'json' | 'text';

export function resolveIssueSummaryFormat(input: {
  summaryFormat?: string;
  isTty: boolean;
}): ResolvedIssueSummaryFormat {
  const format = input.summaryFormat?.trim().toLowerCase();
  if (format === 'json') {
    return 'json';
  }
  if (format === 'text') {
    return 'text';
  }
  if (format != null && format !== '' && format !== 'auto') {
    throw new Error(
      `Invalid --summary-format "${input.summaryFormat}". Use auto, json, or text.`,
    );
  }
  return input.isTty ? 'text' : 'json';
}
