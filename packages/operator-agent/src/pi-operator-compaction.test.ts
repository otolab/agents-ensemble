import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import xterm from '@xterm/headless';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSessionEvent } from '../../core/node_modules/@earendil-works/pi-coding-agent/dist/index.js';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  createManager: vi.fn(),
  getModel: vi.fn(),
}));

// Mock the SDK modules resolved by core, leaving the actual conductor factory intact.
vi.mock('../../core/node_modules/@earendil-works/pi-ai/dist/compat.js', () => ({
  findEnvKeys: vi.fn(() => undefined),
  getEnvApiKey: vi.fn(() => undefined),
  getModel: mocks.getModel,
  getModels: vi.fn(() => []),
  getProviders: vi.fn(() => []),
}));
vi.mock('../../core/node_modules/@earendil-works/pi-coding-agent/dist/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/node_modules/@earendil-works/pi-coding-agent/dist/index.js')>(
    '../../core/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
  );
  return {
    ...actual,
    createAgentSession: mocks.createSession,
    SessionManager: { ...actual.SessionManager, create: mocks.createManager },
  };
});

import type { OperatorAgentOutput } from './run-operator-agent.js';
import { createInteractiveInput } from '../test/support/interactive-input.js';

let root = '';
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('delivers Pi SDK compaction events to operator activity while queued input proceeds', async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-operator-compaction-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ENSEMBLE_USER_ROOT', join(root, '.ensemble'));
  await mkdir(join(root, '.ensemble'), { recursive: true });
  await writeFile(join(root, '.ensemble', 'operator-agents.config.yaml'), [
    'version: 1', 'defaultProfile: smoke', 'common:', '  conductor:',
    '    backend: pi', '    model: anthropic/model-1', 'profiles:', '  smoke: {}', '',
  ].join('\n'));
  mocks.getModel.mockReturnValue({
    id: 'model-1', name: 'Model 1', provider: 'anthropic', api: 'anthropic-messages',
    baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 4096,
  });
  const manager = { getBranch: vi.fn(() => []), appendCustomEntry: vi.fn() };
  mocks.createManager.mockReturnValue(manager);
  let listener!: (event: AgentSessionEvent) => void;
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const prompts: string[] = [];
  const session = {
    state: { messages: [] }, sessionManager: manager,
    subscribe: vi.fn((callback: (event: AgentSessionEvent) => void) => { listener = callback; return () => {}; }),
    prompt: vi.fn(async (text: string) => { prompts.push(text); if (prompts.length === 1) await gate; }),
    reload: vi.fn(async () => {}), bindExtensions: vi.fn(async () => {}),
    abort: vi.fn(async () => {}), dispose: vi.fn(),
  };
  mocks.createSession.mockResolvedValue({ session, extensionsResult: { errors: [] } });
  const input = createInteractiveInput();
  const output = new PassThrough() as PassThrough & OperatorAgentOutput;
  output.isTTY = true; output.columns = 120; output.rows = 24;
  let transcript = '';
  const terminal = new xterm.Terminal({ cols: 120, rows: 24, allowProposedApi: true, convertEol: true });
  output.on('data', (chunk) => { transcript += String(chunk); terminal.write(chunk); });
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n');
  const type = async (text: string) => {
    for (const key of text) {
      input.write(key);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  // The package test setup imports core before tests register their SDK mocks.
  vi.resetModules();
  const { runOperatorAgent } = await import('./run-operator-agent.js');
  const run = runOperatorAgent({ repoRoot: root, newSession: true }, { stdin: input, stdout: output });
  try {
    await vi.waitFor(() => expect(transcript).toContain('user>'));
    await type('first\r');
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    listener({ type: 'compaction_start', reason: 'threshold' });
    await vi.waitFor(() => expect(screen()).toContain('operator: compacting'));
    listener({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: 'synthetic retry' });
    await vi.waitFor(() => expect(screen()).toContain('operator: retrying (1/2)'));
    listener({ type: 'summarization_retry_finished' });
    await vi.waitFor(() => expect(screen()).toContain('operator: compacting'));
    listener({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: {
      summary: 'summary', firstKeptEntryId: 'entry', tokensBefore: 200,
      estimatedTokensAfter: 80, usage: {}, details: '',
    } });
    listener({ type: 'compaction_start', reason: 'manual' });
    listener({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, result: undefined, errorMessage: 'synthetic failure' });
    listener({ type: 'compaction_start', reason: 'overflow' });
    listener({ type: 'compaction_end', reason: 'overflow', aborted: true, willRetry: false, result: undefined });
    await type('second\r');
    await vi.waitFor(() => expect(transcript).toContain('compaction 中断'));
    expect(transcript).toContain('compaction 開始（自動）');
    expect(transcript).toContain('compaction 成功（このプロセスで 1 回、圧縮前 200 tokens）');
    expect(transcript).toContain('compaction 開始（手動）');
    expect(transcript).toContain('compaction 失敗: synthetic failure');
    expect(transcript).toContain('compaction 開始（context 超過）');
    expect(prompts).toHaveLength(1);
    releaseFirst();
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toContain('second');
  } finally {
    releaseFirst();
    await type('/exit\r');
    await run;
    terminal.dispose(); input.destroy(); output.destroy();
  }
}, 15_000);
