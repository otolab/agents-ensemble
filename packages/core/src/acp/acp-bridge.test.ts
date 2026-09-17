import { describe, expect, it, vi } from 'vitest';
import { AcpBridge } from './acp-bridge.js';
import { AcpClient } from './acp-client.js';

describe('AcpBridge.connect', () => {
  it('closes the spawned client when ACP initialization fails', async () => {
    const close = vi.spyOn(AcpClient.prototype, 'close');

    await expect(
      AcpBridge.connect({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      }),
    ).rejects.toThrow();

    expect(close).toHaveBeenCalledOnce();
  });
});
