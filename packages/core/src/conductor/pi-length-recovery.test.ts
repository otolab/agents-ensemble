import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

it('recovers a resumed length-truncated tool turn before the next prompt, even if compaction fails', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-length-recovery-'));
  try {
    const agentDir = join(cwd, 'agent');
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'Previous request '.repeat(300), timestamp: Date.now() });
    const assistant = fauxAssistantMessage([
      fauxToolCall('first', {}, { id: 'call-1' }),
      fauxToolCall('second', {}, { id: 'call-2' }),
    ], { stopReason: 'length' });
    const assistantId = manager.appendMessage(assistant);
    const resultIds = ['call-1', 'call-2'].map((toolCallId) => manager.appendMessage({
      role: 'toolResult', toolCallId, toolName: 'test',
      content: [{ type: 'text', text: 'result' }], isError: false, timestamp: Date.now(),
    }));
    manager.appendMessage({ role: 'user', content: 'Earlier follow-up '.repeat(100), timestamp: Date.now() });
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const resumedManager = SessionManager.open(sessionFile!);
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const provider = fauxProvider();
    let promptRoles: string[] = [];
    provider.setResponses(Array.from({ length: 12 }, () => (context) => {
      const isPrompt = context.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('Next request'));
      if (!isPrompt) return fauxAssistantMessage('incomplete summary', { stopReason: 'length' });
      promptRoles = context.messages.map((message) => message.role);
      return fauxAssistantMessage('continued');
    }));
    runtime.registerNativeProvider(provider.provider);
    const model = runtime.getModel('faux', 'faux-1');
    expect(model).toBeDefined();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 10 } });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, sessionManager: resumedManager, settingsManager, resourceLoader, modelRuntime: runtime, model: model!, noTools: 'builtin' });
    try {
      const events: Array<{ type: string; errorMessage?: string }> = [];
      session.subscribe((event) => { if (event.type === 'compaction_end') events.push(event); });
      await session.prompt('Next request');
      expect(events).toEqual([expect.objectContaining({ type: 'compaction_end', errorMessage: expect.stringContaining('generation hit the token cap') })]);
      const edits = resumedManager.getBranch().filter((entry) => entry.type === 'context_edit');
      expect(edits.map((entry) => entry.targetId)).toEqual([assistantId, ...resultIds]);
      expect(edits.every((entry) => entry.replacement === null)).toBe(true);
      expect(promptRoles).toContain('user');
      expect(promptRoles).not.toContain('assistant');
      expect(promptRoles).not.toContain('toolResult');
      const reopened = SessionManager.open(sessionFile!);
      expect(reopened.buildSessionContext().messages.filter((message) => message.role === 'toolResult')).toEqual([]);
      expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'continued' }],
        stopReason: 'stop',
      });
    } finally {
      session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
