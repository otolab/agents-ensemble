import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

it('omits a resumed length-truncated tool call and its results together', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-length-recovery-'));
  try {
    const agentDir = join(cwd, 'agent');
    const manager = SessionManager.inMemory(cwd);
    const assistant = fauxAssistantMessage([
      fauxToolCall('first', {}, { id: 'call-1' }),
      fauxToolCall('second', {}, { id: 'call-2' }),
    ], { stopReason: 'length' });
    const assistantId = manager.appendMessage(assistant);
    const resultIds = ['call-1', 'call-2'].map((toolCallId) => manager.appendMessage({
      role: 'toolResult', toolCallId, toolName: 'test',
      content: [{ type: 'text', text: 'result' }], isError: false, timestamp: Date.now(),
    }));
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, settingsManager, resourceLoader, noTools: 'builtin' });
    try {
      const resumed = session.agent.state.messages.find((message) => message.role === 'assistant');
      expect(resumed).toBeDefined();
      // Exercise the same omission used by pre-run overflow recovery on a resumed transcript.
      (session as unknown as { _omitRecoveryAttempt(message: unknown): void })._omitRecoveryAttempt(resumed);
      const edits = manager.getBranch().filter((entry) => entry.type === 'context_edit');
      expect(edits.map((entry) => entry.targetId)).toEqual([assistantId, ...resultIds]);
      expect(edits.every((entry) => entry.replacement === null)).toBe(true);
      expect(manager.buildSessionContext().messages.filter((message) => message.role === 'assistant' || message.role === 'toolResult')).toEqual([]);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
