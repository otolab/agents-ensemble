import { describe, expect, it, vi } from 'vitest';
import { createPermissionAskHandler } from './create-permission-ask-handler.js';

describe('createPermissionAskHandler', () => {
  it('maps yes_no human response to allow/deny', async () => {
    const onHumanInquiry = vi
      .fn()
      .mockResolvedValueOnce({ answer: 'y', approved: true })
      .mockResolvedValueOnce({ answer: 'n', approved: false });

    const handler = createPermissionAskHandler(onHumanInquiry);

    const allow = await handler({
      toolName: 'Shell',
      raw: {},
      options: [{ optionId: 'backend-allow', kind: 'allow_once' }],
    });
    expect(allow.outcome.outcome).toBe('selected');
    expect(allow.outcome).toMatchObject({ optionId: 'backend-allow' });

    const denyResult = await handler({
      toolName: 'Shell',
      raw: {},
      options: [{ optionId: 'backend-deny', kind: 'reject_once' }],
    });
    expect(denyResult.outcome).toMatchObject({
      outcome: 'selected',
      optionId: 'backend-deny',
    });
  });
});
