import { describe, expect, it } from 'vitest';
import {
  createReportSessionStateTool,
  REPORT_SESSION_STATE_MAX_LENGTH,
} from './report-session-state-tool.js';

describe('createReportSessionStateTool', () => {
  const tool = createReportSessionStateTool().report_session_state!;

  it('requires a statusLine argument and returns the minimal snapshot shape', async () => {
    expect(tool.inputSchema).toMatchObject({
      required: ['statusLine'],
      properties: {
        statusLine: {
          type: 'string',
          maxLength: REPORT_SESSION_STATE_MAX_LENGTH,
        },
      },
    });

    const result = await tool.execute({
      statusLine: 'レビュー中：CIテスト待ち',
    });

    expect(result.structuredContent).toEqual({
      statusLine: 'レビュー中：CIテスト待ち',
    });
    expect(result.content[0]?.text).toContain(
      'statusLine: レビュー中：CIテスト待ち',
    );
  });

  it('accepts a statusLine at the 80-character limit using Unicode code points', async () => {
    const statusLine = '🧪'.repeat(REPORT_SESSION_STATE_MAX_LENGTH);

    const result = await tool.execute({ statusLine });

    expect(result.structuredContent).toEqual({ statusLine });
  });

  it('rejects an empty, missing, multiline, or overlong statusLine', async () => {
    await expect(tool.execute({})).rejects.toThrow(
      'report_session_state requires statusLine',
    );
    await expect(tool.execute({ statusLine: ' \t ' })).rejects.toThrow(
      'statusLine must not be empty',
    );
    await expect(
      tool.execute({ statusLine: 'first line\nsecond line' }),
    ).rejects.toThrow('statusLine must be one line');
    await expect(
      tool.execute({
        statusLine: '🧪'.repeat(REPORT_SESSION_STATE_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow('must be at most 80 characters');
  });
});
