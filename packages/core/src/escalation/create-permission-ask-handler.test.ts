import { describe, expect, it, vi } from 'vitest';
import { createPermissionAskHandler } from './create-permission-ask-handler.js';

describe('createPermissionAskHandler', () => {
  it('maps yes_no human response to allow/deny', async () => {
    const onHumanInquiry = vi
      .fn()
      .mockResolvedValueOnce({ answer: 'y', approved: true })
      .mockResolvedValueOnce({ answer: 'n', approved: false });

    const handler = createPermissionAskHandler(onHumanInquiry);

    const allow = await handler({ toolName: 'Shell', raw: {} });
    expect(allow.outcome.outcome).toBe('selected');
    expect(allow.outcome).toMatchObject({ optionId: 'allow-once' });

    const denyResult = await handler({ toolName: 'Shell', raw: {} });
    expect(denyResult.outcome).toMatchObject({
      outcome: 'selected',
      optionId: 'deny',
    });
  });
});
