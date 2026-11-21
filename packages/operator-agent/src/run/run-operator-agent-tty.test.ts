import { setupRunnerSuite } from '../../test/support/runner-suite.js';
import { readSchedulingStats } from '../../../cli/src/session-scheduling-stats.js';
import { createFakeAgent, createOutput, writeOperatorSettings } from '../../test/support/operator-fixtures.js';
import { waitForNotification } from '../../test/support/wait.js';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { createInteractiveInput } from '../../test/support/interactive-input.js';
import xterm from '@xterm/headless';
import { PiConductorAgent } from '../../../core/src/conductor/pi-conductor-agent.js';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startOpenQuestionControlServer,
  resolveEnsemblePaths,
  type SessionObservationSnapshot,
} from '@agents-ensemble/core';
import {
  MCP_CONFIG_FILE,
  listUserLocatedSessionResumeStoresPage,
} from '@agents-ensemble/core/operator-runtime';
import type {
  ConductorAgent,
  ConductorAgentCreateOptions,
  ConductorAgentFactory,
} from '@agents-ensemble/core/operator-runtime';
import {
  runOperatorAgent,
  type OperatorAgentInput,
} from '../run-operator-agent.js';
import {
  OPERATOR_WATCH_ACK_MAX_RETRIES,
  OPERATOR_WATCH_ACK_RETRY_DELAY_MS,
  retryOperatorWatchAcknowledgement,
} from '../watch/operator-watch-ack.js';
import { createOperatorDispatchQueue } from '../dispatch/operator-dispatch.js';
import { withOperatorWorkspaceLock } from '../workspace/operator-workspace-lock.js';
import {
  createOperatorWatchPool,
  operatorWatchStatePath,
} from '../watch/operator-watch-pool.js';
import {
  loadOperatorAgentState,
  listOperatorAgentStates,
  operatorAgentStatePath,
  operatorPiSessionDirectory,
  saveOperatorAgentState,
  type OperatorAgentState,
} from './operator-agent-state.js';

const watchPollHarness = vi.hoisted(() => ({
  pending: new Set<Promise<unknown>>(),
  onCompleted: undefined as ((id: string, count: number) => void) | undefined,
  onAcknowledged: undefined as (() => void) | undefined,
}));

vi.mock('../watch/operator-watch-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../watch/operator-watch-pool.js')>();
  return {
    ...actual,
    createOperatorWatchPool: async (...args: Parameters<typeof actual.createOperatorWatchPool>) => {
      const pool = await actual.createOperatorWatchPool(...args);
      const track = <T>(operation: Promise<T>): Promise<T> => {
        watchPollHarness.pending.add(operation);
        void operation.then(
          () => watchPollHarness.pending.delete(operation),
          () => watchPollHarness.pending.delete(operation),
        );
        return operation;
      };
      const pollOnce = pool.pollOnce.bind(pool);
      const polling = new Set<string>();
      pool.pollOnce = (id) => track((async () => {
        if (polling.has(id)) return pollOnce(id);
        polling.add(id);
        try {
          const count = await pollOnce(id);
          watchPollHarness.onCompleted?.(id, count);
          return count;
        } finally {
          polling.delete(id);
        }
      })());
      const acknowledge = pool.acknowledge.bind(pool);
      pool.acknowledge = async (...args) => {
        const result = await acknowledge(...args);
        if (args[0].some((event) => event.type === 'report' && event.reportId)) {
          watchPollHarness.onAcknowledged?.();
        }
        return result;
      };
      return pool;
    },
  };
});

function nextWatchPoll(minimumReports = 0): Promise<void> {
  return new Promise((resolve) => {
    watchPollHarness.onCompleted = (id, count) => {
      if (id !== 'conductor-one' || count < minimumReports) return;
      watchPollHarness.onCompleted = undefined;
      resolve();
    };
  });
}

describe('runOperatorAgent', () => {
  const fixture = setupRunnerSuite(watchPollHarness);


  it('runs a Pi-backed TTY conversation with profile prompt and saved session summaries', async () => {
    const input = createInteractiveInput();
    const output = createOutput();
    let agentOptions: ConductorAgentCreateOptions | undefined;
    let listedSessions = '';
    let workspaceFileResult = '';
    const sentPrompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        const tool = agentOptions?.customTools?.list_operator_sessions;
        expect(tool).toBeDefined();
        const toolResult = await tool!.execute({ limit: 1 });
        listedSessions = toolResult.content[0]?.text ?? '';
        const writeWorkspaceFile =
          agentOptions?.customTools?.write_operator_workspace_file;
        const readWorkspaceFile =
          agentOptions?.customTools?.read_operator_workspace_file;
        expect(writeWorkspaceFile).toBeDefined();
        expect(readWorkspaceFile).toBeDefined();
        await writeWorkspaceFile!.execute({
          path: 'notes/session.md',
          content: 'Session notes.',
        });
        const readResult = await readWorkspaceFile!.execute({
          path: 'notes/session.md',
        });
        workspaceFileResult = readResult.content[0]?.text ?? '';
        const list = agentOptions?.customTools?.list_operator_workspace_files;
        const move = agentOptions?.customTools?.move_operator_workspace_file;
        const del = agentOptions?.customTools?.delete_operator_workspace_file;
        expect(list && move && del).toBeTruthy();
        await move!.execute({ source: 'notes/session.md', destination: 'archive/session.md' });
        expect((await list!.execute({ path: 'archive' })).structuredContent?.entries)
          .toEqual([expect.objectContaining({ path: 'archive/session.md', type: 'file' })]);
        await del!.execute({ path: 'archive/session.md' });
        await expect(readWorkspaceFile!.execute({ path: 'archive/session.md' })).rejects.toThrow(/does not exist/u);
        await writeWorkspaceFile!.execute({ path: 'notes/session.md', content: 'Session notes.' });

        return {
          runId: 'run-1',
          status: 'completed',
          result:
            '保存済み SessionResumeStore から implementer のセッション情報を確認できます。\n\n\n\nライブ open question も確認できます。',
        };
      },
    });
    const agentFactory: ConductorAgentFactory = {
      create: async (options) => {
        agentOptions = options;
        return fakeAgent;
      },
      resume: async () => fakeAgent,
    };

    await expect(
      listUserLocatedSessionResumeStoresPage(
        {},
        { userEnsembleRoot: join(fixture.repoRoot, '.ensemble') },
      ),
    ).resolves.toMatchObject({
      total: 1,
      sessions: [
        {
          resumeStore: {
            conductorAgentId: 'conductor-one',
            issueUrl: 'https://github.com/example/project/issues/12',
          },
        },
      ],
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      { stdin: input, stdout: output, agentFactory },
    );
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('user>'),
    );
    input.write('状況を教えて');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('状況を教えて'),
    );
    input.write('\r');
    await vi.waitFor(() => expect(sentPrompts).toEqual(['状況を教えて']));
    // The fake send reads and writes workspace files before rendering its reply.
    // Allow CI's shared runner enough time while still requiring the reply.
    await vi.waitFor(() =>
      expect(normalizeTtyText(output.capturedText())).toContain(
        'ライブ open question も確認できます。',
      ),
      { timeout: 5_000 },
    );
    input.write('/exit\n');
    await run;

    const transcript = output.capturedText();
    expect(sentPrompts).toEqual(['状況を教えて']);
    expect(listedSessions).toContain(
      'https://github.com/example/project/issues/12',
    );
    expect(listedSessions).toContain('permission-1');
    expect(JSON.parse(workspaceFileResult)).toEqual({
      path: 'notes/session.md',
      content: 'Session notes.',
    });
    await expect(
      readFile(
        join(
          fixture.repoRoot,
          '.ensemble',
          'operator-agents',
          'smoke',
          'notes',
          'session.md',
        ),
        'utf8',
      ),
    ).resolves.toBe('Session notes.');
    expect(transcript).toContain(
      '[observation] (pi) ready — enter /exit to start a fresh session next time.',
    );
    expect(transcript).toContain('user>');
    const readableTranscript = normalizeTtyText(transcript);
    expect(readableTranscript).toContain('operator>');
    expect(readableTranscript).toContain(
      '保存済み SessionResumeStore から implementer のセッション情報を確認できます。',
    );
    expect(readableTranscript).toContain('ライブ open question も確認できます。');
    expect(transcript).not.toContain('[harness] 監視報告:');
    expect(readableTranscript).toContain('harness: 監視報告:');
    expect(transcript).toContain(
      '[observation] session ended.',
    );
    expect(transcript).not.toMatch(/(?:^|\n)> /);
    expect(transcript).not.toContain('operator-agent 会話 hold');
    expect(agentOptions).toMatchObject({
      cwd: join(fixture.repoRoot, '.ensemble', 'operator-agents', 'smoke'),
      modelId: 'smoke-model',
      builtinTools: false,
      pi: {
        agentDir: join(fixture.repoRoot, '.ensemble', 'pi-user'),
        projectDir: join(
          fixture.repoRoot,
          '.ensemble',
          'operator-agents',
          'smoke',
          'pi-project',
        ),
      },
      piExtensions: false,
    });
    expect(agentOptions).not.toHaveProperty('mcpServers');
    expect(agentOptions).not.toHaveProperty('reasoning');
    expect(agentOptions?.systemPrompt).toContain('operator ロール');
    expect(agentOptions?.systemPrompt).toContain('Profile operator guidance.');
    expect(agentOptions?.systemPrompt).toContain('shutdown_issue_session');
    expect(agentOptions?.systemPrompt).not.toContain('answer_live_open_question');
    const toolDescription = (name: string): string =>
      String(
        (agentOptions?.customTools as Record<string, { description?: string }> | undefined)?.[name]
          ?.description,
      );
    expect(toolDescription('answer_live_open_question')).toContain('not secret-masked');
    expect(toolDescription('list_worker_messages')).toContain('do not infer a failure');
    expect(toolDescription('list_operator_sessions')).toContain('openQuestionHistory');
    expect(toolDescription('register_session_watch')).toContain('answeredBy: operator');
    expect(toolDescription('read_operator_workspace_file')).toContain('TOCTOU');
    expect(toolDescription('read_operator_workspace_file')).toContain('without secret redaction');
    expect(toolDescription('move_operator_workspace_file')).toContain('get_operator_workspace_move_status');
    expect(toolDescription('move_operator_workspace_file')).toContain('operator-workspace-maintain');
    expect(toolDescription('write_operator_workspace_file')).toContain('AGENTS.md can be edited');
    expect(toolDescription('get_operator_workspace_move_status')).toContain('operator-workspace-maintain');
    expect(toolDescription('get_operator_workspace_move_status')).toContain('Never remove the journal directly');
    expect(agentOptions?.customTools).not.toHaveProperty('prompt_worker');
    expect(
      Object.keys(agentOptions?.customTools ?? {}).filter(
        (toolName) => toolName === 'send_operator_message',
      ),
    ).toHaveLength(1);
    expect(Object.keys(agentOptions?.customTools ?? {})).toEqual([
      'list_operator_sessions',
      'list_live_open_questions',
      'answer_live_open_question',
      'get_last_conductor_message',
      'list_conductor_messages',
      'list_worker_messages',
      'register_session_watch',
      'unregister_session_watch',
      'register_repository_watch',
      'unregister_repository_watch',
      'register_conductor_message_listen',
      'unregister_conductor_message_listen',
      'set_report_hold',
      'release_reports',
      'request_session_reports',
      'list_pending_reports',
      'set_session_focus',
      'send_operator_message',
      'shutdown_issue_session',
      'list_operator_workspace_files',
      'move_operator_workspace_file',
      'delete_operator_workspace_file',
      'read_operator_workspace_file',
      'write_operator_workspace_file',
      'get_operator_workspace_move_status',
    ]);
    await expect(
      listOperatorAgentStates(join(fixture.repoRoot, '.ensemble')),
    ).resolves.toEqual([]);
  });

  it('renders interleaved Pi session events through the real adapter', async () => {
    const input = createInteractiveInput();
    const output = createOutput();
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true, convertEol: true });
    output.on('data', (chunk: Buffer) => terminal.write(chunk));
    let listener: ((event: unknown) => void) | undefined;
    let finishPrompt!: () => void;
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    const promptGate = new Promise<void>((resolve) => { finishPrompt = resolve; });
    const session = {
      subscribe: (callback: (event: unknown) => void) => { listener = callback; return () => { listener = undefined; }; },
      prompt: async () => { promptStarted(); await promptGate; },
      state: { messages: [] },
      abort: async () => {},
      dispose: () => {},
    };
    const agent = new PiConductorAgent(
      session as never, {} as never, {} as never, {} as never, { value: '' },
      'pi-test', 'model-test', {} as never, { enabled: false } as never,
      {} as never, false, false,
    );
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot }, { stdin: input, stdout: output, agentFactory: {
      create: async () => agent, resume: async () => agent,
    } });
    const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n');
    const status = async (text: string) => vi.waitFor(() => expect(screen()).toContain(`operator: ${text}`));
    const message = { role: 'assistant', content: [] };
    const emit = (type: string, delta?: string) => listener?.({ type: 'message_update', message, assistantMessageEvent: { type, delta } });
    try {
      await status('待機中');
      input.write('hello\r');
      await started;
      await status('処理中');
      emit('text_start');
      await status('writing');
      emit('thinking_start');
      await status('thinking');
      emit('text_delta', 'private response fragment');
      await status('writing');
      emit('thinking_delta', 'private reasoning fragment');
      await status('thinking');
      listener?.({ type: 'tool_execution_start', toolName: 'inspect', toolCallId: 'call-1' });
      await status('calling inspect');
      input.write('draft');
      await vi.waitFor(() => expect(screen()).toContain('draft'));
      listener?.({ type: 'tool_execution_end', toolName: 'inspect', toolCallId: 'call-1', result: { content: [] }, isError: false });
      await status('処理中');
      emit('text_delta', 'another private fragment');
      await status('writing');
      expect(screen()).not.toContain('private reasoning fragment');
      expect(screen()).not.toContain('private response fragment');
      finishPrompt();
      await status('待機中');
      input.write('\u0015/exit\r');
      await run;
    } finally {
      finishPrompt();
      input.end();
      await run.catch(() => {});
      terminal.dispose();
    }
  });

  it('shows observed phases and overlapping tool calls in the current frame', async () => {
    const input = createInteractiveInput();
    const output = createOutput();
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true, convertEol: true });
    output.on('data', (chunk: Buffer) => terminal.write(chunk));
    let callbacks: Parameters<ConductorAgent['send']>[1];
    let finish!: (result: Awaited<ReturnType<ConductorAgent['send']>>) => void;
    const agent = createFakeAgent({ send: async (_prompt, cb) => {
      callbacks = cb;
      return await new Promise((resolve) => { finish = resolve; });
    } });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot }, { stdin: input, stdout: output, agentFactory: { create: async () => agent, resume: async () => agent } });
    const lines = () => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '');
    const screen = () => lines().slice(terminal.buffer.active.viewportY, terminal.buffer.active.viewportY + terminal.rows).join('\n');
    const status = async (text: string) => vi.waitFor(() => expect(screen()).toContain(`operator: ${text}`));
    try {
      await status('待機中');
      input.write('hello\r');
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      expect(callbacks!.history).toEqual({ sendCount: 1, dispatchSource: 'user' });
      await status('処理中');
      callbacks!.onOutputPhase?.('writing');
      await status('writing');
      callbacks!.onOutputPhase?.('thinking');
      await status('thinking');
      callbacks!.onOutputPhase?.('writing');
      await status('writing');
      callbacks!.onOutputPhase?.('thinking');
      await status('thinking');
      const earlier = Date.now() - 60_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(earlier);
      callbacks!.onToolCallStarted?.({ runId: 'run', tool: 'same', callId: 'a' });
      clock.mockRestore();
      await vi.waitFor(() => expect(screen()).toMatch(/calling same \([1-9]\d*s\)/), { timeout: 2500 });
      const firstElapsed = Number(screen().match(/calling same \((\d+)s\)/)![1]);
      callbacks!.onToolCallStarted?.({ runId: 'run', tool: 'same', callId: 'b' });
      await vi.waitFor(() => {
        const elapsed = Number(screen().match(/calling same \((\d+)s\)/)?.[1] ?? Infinity);
        expect(elapsed).toBeLessThan(firstElapsed);
      });
      callbacks!.onOutputPhase?.('writing');
      expect(screen()).not.toContain('operator: writing');
      callbacks!.onToolCallStarted?.({ runId: 'run', tool: 'other', callId: 'c' });
      await vi.waitFor(() => {
        const elapsed = Number(screen().match(/calling other \((\d+)s\)/)?.[1] ?? Infinity);
        expect(elapsed).toBeLessThan(firstElapsed);
      });
      callbacks!.onToolCallCompleted?.({ runId: 'run', tool: 'same', callId: 'b' });
      expect(screen()).toContain('calling other');
      callbacks!.onToolCallCompleted?.({ runId: 'run', tool: 'other', callId: 'c' });
      await vi.waitFor(() => expect(screen()).toMatch(/calling same \([1-9]/));
      callbacks!.onToolCallCompleted?.({ runId: 'run', tool: 'same', callId: 'a' });
      await status('処理中');
      callbacks!.onOutputPhase?.('writing');
      await status('writing');
      input.write('next');
      await vi.waitFor(() => expect(screen()).toContain('next'));
      finish({ runId: 'run', status: 'completed', result: 'done' });
      await status('待機中');
      expect(lines().join('\n')).not.toContain('operator: thinking');
      expect(lines().join('\n')).not.toMatch(/operator: calling same \(\d+s\)/g);
      input.write('\u0015/exit\r');
      await run;
      expect(lines().join('\n')).not.toMatch(/operator: calling same \(\d+s\)/g);
    } finally {
      input.end();
      terminal.dispose();
    }
  });

  it('shows current status through automatic recovery, rejected send and manual reconnect failure', async () => {
    const input = createInteractiveInput();
    const output = createOutput();
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true, convertEol: true });
    output.on('data', (chunk: Buffer) => terminal.write(chunk));
    let resolveAutomatic!: () => void;
    let rejectManual!: () => void;
    const automatic = new Promise<void>((resolve) => { resolveAutomatic = resolve; });
    const manual = new Promise<void>((resolve) => { rejectManual = resolve; });
    const initial = createFakeAgent({ send: async () => ({ runId: 'a', status: 'error', error: { code: 'auth', message: 'authentication failed' } }) });
    const resumed = createFakeAgent({ send: async () => { throw new Error('failed'); } });
    let resumes = 0;
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot }, { stdin: input, stdout: output, agentFactory: {
      create: async () => initial,
      resume: async () => { resumes++; if (resumes === 1) { await automatic; return resumed; } if (resumes === 2) { await manual; throw new Error('failed'); } return resumed; },
    } });
    const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n');
    const status = async (text: string) => vi.waitFor(() => expect(screen()).toContain(`operator: ${text}`));
    try {
      await status('待機中');
      input.write('hello\r');
      await status('reconnecting');
      resolveAutomatic();
      await status('待機中');
      input.write('/recovery continue\r');
      input.write('again\r');
      await vi.waitFor(() => expect(output.capturedText()).toContain('status=send_rejected'));
      await status('待機中');
      input.write('/reconnect\r');
      await status('reconnecting');
      rejectManual();
      await vi.waitFor(() => expect(output.capturedText()).toContain('conductor の再接続に失敗しました。'));
      await status('待機中');
      input.write('/reconnect\r');
      await vi.waitFor(() => expect(resumes).toBe(3));
      await vi.waitFor(() => expect(output.capturedText()).toContain('conductor に再接続しました。'));
      await status('待機中');
      input.write('/exit\r');
      await run;
    } finally { resolveAutomatic(); rejectManual(); input.end(); terminal.dispose(); }
  });

  it('renders Pi compaction and retry notifications without blocking input', async () => {
    const input = createInteractiveInput();
    const output = createOutput();
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true, convertEol: true });
    output.on('data', (chunk: Buffer) => terminal.write(chunk));
    let options: ConductorAgentCreateOptions | undefined;
    let finish!: (result: Awaited<ReturnType<ConductorAgent['send']>>) => void;
    const agent = createFakeAgent({ send: async () => await new Promise((resolve) => { finish = resolve; }) });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, backend: 'pi' }, { stdin: input, stdout: output, agentFactory: {
      create: async (value) => { options = value; return agent; }, resume: async () => agent,
    } });
    const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n');
    const status = async (text: string) => vi.waitFor(() => expect(screen()).toContain(`operator: ${text}`));
    try {
      await status('待機中');
      input.write('hello\r');
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      options!.onCompactionEvent!({ type: 'start', reason: 'threshold' });
      await status('compacting');
      options!.onRetryEvent!({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: 'failed' });
      await status('retrying (1/3)');
      input.write('draft');
      await vi.waitFor(() => expect(screen()).toContain('draft'));
      options!.onRetryEvent!({ type: 'summarization_retry_finished' });
      await status('compacting');
      options!.onCompactionEvent!({ type: 'end', reason: 'threshold', outcome: 'failed', errorMessage: 'failed' });
      await status('処理中');
      options!.onRetryEvent!({ type: 'summarization_retry_attempt_start', source: 'compaction' });
      await status('retrying');
      options!.onRetryEvent!({ type: 'summarization_retry_finished' });
      await status('処理中');
      options!.onRetryEvent!({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 10, errorMessage: 'failed' });
      await status('retrying (2/3)');
      options!.onRetryEvent!({ type: 'auto_retry_end', success: false, attempt: 2, finalError: 'failed' });
      await status('処理中');
      finish({ runId: 'one', status: 'completed', result: 'done' });
      await status('待機中');
      input.write('\u0015/exit\r');
      await run;
    } finally { input.end(); terminal.dispose(); }
  });

  it('shows compaction outcomes while a send and next input continue', async () => {
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    let options: ConductorAgentCreateOptions | undefined;
    let finishFirst: ((result: Awaited<ReturnType<ConductorAgent['send']>>) => void) | undefined;
    const prompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) return await new Promise((resolve) => { finishFirst = resolve; });
        return { runId: 'second', status: 'completed', result: 'second done' };
      },
    });
    const run = runOperatorAgent({ repoRoot: fixture.repoRoot, backend: 'pi' }, {
      stdin: input, stdout: output,
      agentFactory: {
        create: async (value) => { options = value; return fakeAgent; },
        resume: async (id, value) => { options = value; return fakeAgent; },
      },
    });
    input.write('first\n');
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    const emit = options!.onCompactionEvent!;
    emit({ type: 'start', reason: 'threshold' });
    emit({ type: 'end', reason: 'threshold', outcome: 'success', tokensBefore: 200 });
    emit({ type: 'start', reason: 'manual' });
    emit({ type: 'end', reason: 'manual', outcome: 'failed', errorMessage: 'failure detail' });
    emit({ type: 'start', reason: 'overflow' });
    emit({ type: 'end', reason: 'overflow', outcome: 'aborted' });
    input.write('second\n');
    finishFirst!({ runId: 'first', status: 'completed', result: 'first done' });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await vi.waitFor(() => expect(output.capturedText()).toContain('second done'));
    const transcript = output.capturedText();
    expect(transcript).toContain('compaction 開始（自動）');
    expect(transcript).toContain('compaction 成功（このプロセスで 1 回、圧縮前 200 tokens）');
    expect(transcript).toContain('compaction 失敗: failure detail');
    expect(transcript).toContain('compaction 中断');
    input.write('/exit\n');
    input.end();
    await run;
  });

  it('shows send and tool activity while preserving the TTY prompt', async () => {
    const input = createInteractiveInput();
    input.isTTY = true;
    const output = createOutput();
    let finishSend:
      | ((result: Awaited<ReturnType<ConductorAgent['send']>>) => void)
      | undefined;
    let reportPhase: ((phase: 'thinking' | 'writing') => void) | undefined;
    let completeTool: (() => void) | undefined;
    const fakeAgent = createFakeAgent({
      send: async (_prompt, callbacks) => {
        reportPhase = callbacks?.onOutputPhase;
        completeTool = () => callbacks?.onToolCallCompleted?.({ runId: 'run-1', tool: 'list_operator_sessions', callId: 'call-1' });
        callbacks?.onToolCallStarted?.({
          runId: 'run-1',
          tool: 'list_operator_sessions',
          callId: 'call-1',
        });
        return await new Promise<
          Awaited<ReturnType<ConductorAgent['send']>>
        >((resolve) => {
          finishSend = resolve;
        });
      },
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => fakeAgent,
          resume: async () => fakeAgent,
        },
      },
    );

    input.write('hello\n');
    await vi.waitFor(() => expect(finishSend).toBeTypeOf('function'));

    const pendingTranscript = output.capturedText();
    expect(pendingTranscript).toContain(
      '[harness] operator: 処理中',
    );
    expect(pendingTranscript).toContain(
      '[harness] operator: calling list_operator_sessions',
    );
    expect(pendingTranscript.lastIndexOf('user>')).toBeGreaterThan(
      pendingTranscript.indexOf('operator: calling list_operator_sessions'),
    );
    expect(pendingTranscript).not.toContain('operator>\n');
    expect(pendingTranscript).toContain('operator: calling list_operator_sessions');
    completeTool?.();
    reportPhase?.('thinking');
    await vi.waitFor(() => expect(output.capturedText()).toContain('operator: thinking'));
    reportPhase?.('writing');
    await vi.waitFor(() => expect(output.capturedText()).toContain('operator: writing'));

    finishSend!({
      runId: 'run-1',
      status: 'completed',
      result: 'Done.',
    });
    await vi.waitFor(() => {
      const transcript = output.capturedText();
      const responseLabel = transcript.indexOf('operator>');
      const responseBody = transcript.indexOf('Done.');
      expect(responseLabel).toBeGreaterThan(-1);
      expect(responseBody).toBeGreaterThan(responseLabel);
    });
    input.write('/exit\n');
    input.end();
    await run;
  });

  it('submits a multiline paste once and preserves its whitespace', async () => {
    const input = createInteractiveInput();
    const output = createOutput();
    const sentPrompts: string[] = [];
    const fakeAgent = createFakeAgent({
      send: async (prompt) => {
        sentPrompts.push(prompt);
        return {
          runId: `run-${sentPrompts.length}`,
          status: 'completed',
          result: 'Received.',
        };
      },
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => fakeAgent,
          resume: async () => fakeAgent,
        },
      },
    );

    input.write('\u001b[200~  first line\n    second line  \u001b[201~');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('second line'),
    );
    expect(sentPrompts).toEqual([]);

    input.write('\r');
    await vi.waitFor(() =>
      expect(sentPrompts).toEqual(['  first line\n    second line  ']),
    );
    input.write('/resume-watch');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('/resume-watch'),
    );
    input.write('\r');
    await vi.waitFor(() => {
      const text = output.capturedText();
      expect(text.split('/resume-watch').length - 1).toBeGreaterThan(1);
    });
    input.write('/exit');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('/exit'),
    );
    input.write('\r');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('session ended.'),
    );
    input.end();
    await run;

    expect(sentPrompts).toEqual(['  first line\n    second line  ']);
    expect(output.capturedText()).toContain('/resume-watch');
    expect(output.capturedText()).toContain('[observation]');
    expect(input.isRaw).toBe(false);
  });

  it('routes Ctrl+C through runner shutdown while waiting for input', async () => {
    const previousExitCode = process.exitCode;
    const previousSigintListeners = process.listenerCount('SIGINT');
    const input = createInteractiveInput();
    const output = createOutput();
    const agent = createFakeAgent({
      send: async () => ({ runId: 'unused', status: 'completed' }),
    });
    const close = vi.spyOn(agent, 'close');
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => agent,
          resume: async () => agent,
        },
      },
    );

    try {
      await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
      input.write('\u0003');
      await run;

      expect(process.exitCode).toBe(130);
      expect(close).toHaveBeenCalledOnce();
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount('readable')).toBe(0);
      expect(output.listenerCount('resize')).toBe(0);
      expect(process.listenerCount('SIGINT')).toBe(previousSigintListeners);
    } finally {
      process.exitCode = previousExitCode;
      input.end();
      await run.catch(() => {});
    }
  });

  it('routes Ctrl+C through runner shutdown while a send is pending', async () => {
    const previousExitCode = process.exitCode;
    const previousSigintListeners = process.listenerCount('SIGINT');
    const input = createInteractiveInput();
    const output = createOutput();
    const terminal = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true, convertEol: true });
    output.on('data', (chunk: Buffer) => terminal.write(chunk));
    let callbacks: Parameters<ConductorAgent['send']>[1];
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const agent = createFakeAgent({
      send: async (_prompt, cb) => {
        callbacks = cb;
        callbacks?.onOutputPhase?.('thinking');
        sendStarted();
        return await new Promise<Awaited<ReturnType<ConductorAgent['send']>>>(
          () => {},
        );
      },
    });
    const close = vi.spyOn(agent, 'close');
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => agent,
          resume: async () => agent,
        },
      },
    );

    try {
      await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
      input.write('start send');
      input.write('\r');
      await started;
      await vi.waitFor(() => expect(output.capturedText()).toContain('operator: thinking'));
      input.write('\u0003');
      await run;
      callbacks?.onOutputPhase?.('writing');
      await new Promise<void>((resolve) => terminal.write('', resolve));
      const screen = Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n');
      expect(screen).toContain('operator: 待機中');
      expect(screen).not.toContain('operator: writing');

      expect(process.exitCode).toBe(130);
      expect(close).toHaveBeenCalledOnce();
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount('readable')).toBe(0);
      expect(output.listenerCount('resize')).toBe(0);
      expect(process.listenerCount('SIGINT')).toBe(previousSigintListeners);
    } finally {
      process.exitCode = previousExitCode;
      input.end();
      terminal.dispose();
      await run.catch(() => {});
    }
  });

  it('keeps terminal scrollback when the TUI exits', async () => {
    const input = createInteractiveInput();
    const output = createOutput();
    const agent = createFakeAgent({
      send: async () => ({ runId: 'unused', status: 'completed' }),
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => agent,
          resume: async () => agent,
        },
      },
    );

    await vi.waitFor(() => expect(output.capturedText()).toContain('user>'));
    input.write('/exit');
    input.write('\r');
    await run;

    const transcript = output.capturedText();
    expect(transcript).toContain('ready — enter /exit');
    expect(transcript).toContain('session ended.');
    expect(transcript).not.toContain('\u001b[3J');
    expect(input.isRaw).toBe(false);
    expect(output.listenerCount('resize')).toBe(0);
  });

  it('preserves a draft cursor through async logs and terminal resize while responding', async () => {
    const input = createInteractiveInput();
    const output = createOutput();
    const sentPrompts: string[] = [];
    let finishFirstSend!: (
      result: Awaited<ReturnType<ConductorAgent['send']>>,
    ) => void;
    let firstSendStarted!: () => void;
    let appendToolActivity!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstSendStarted = resolve;
    });
    const fakeAgent = createFakeAgent({
      send: async (prompt, callbacks) => {
        sentPrompts.push(prompt);
        if (sentPrompts.length === 1) {
          appendToolActivity = () =>
            callbacks?.onToolCallStarted?.({
              runId: 'run-1',
              tool: 'list_operator_sessions',
              callId: 'call-1',
            });
          firstSendStarted();
          return await new Promise<
            Awaited<ReturnType<ConductorAgent['send']>>
          >((resolve) => {
            finishFirstSend = resolve;
          });
        }
        return {
          runId: 'run-2',
          status: 'completed',
          result: 'Draft received.',
        };
      },
    });
    const run = runOperatorAgent(
      { repoRoot: fixture.repoRoot },
      {
        stdin: input,
        stdout: output,
        agentFactory: {
          create: async () => fakeAgent,
          resume: async () => fakeAgent,
        },
      },
    );

    await vi.waitFor(
      () => {
        const text = output.capturedText();
        if (!text.includes('user>')) {
          throw new Error(`input TUI not rendered yet: ${text.slice(-300)}`);
        }
      },
      { timeout: 1000 },
    );
    input.write('start');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('start'),
    );
    input.write('\r');
    await firstStarted;
    input.write('draft');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('draft'),
    );
    input.write('\u001b[D');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    input.write('\u001b[D');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    output.columns = 40;
    output.rows = 12;
    output.emit('resize');
    appendToolActivity();
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('list_operator_sessions'),
    );

    input.write('X');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('draXft'),
    );
    input.write('\r');
    finishFirstSend({
      runId: 'run-1',
      status: 'completed',
      result: 'First turn complete.',
    });
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(2));
    expect(sentPrompts[1]).toBe('draXft');

    input.write('/exit');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('/exit'),
    );
    input.write('\r');
    await vi.waitFor(() =>
      expect(output.capturedText()).toContain('session ended.'),
    );
    input.end();
    await run;
    expect(input.isRaw).toBe(false);
  });
});


function createInput(text: string, isTTY = true): OperatorAgentInput {
  const input = createInteractiveInput();
  input.isTTY = isTTY;
  input.write(text.replace(/\n/g, '\r'));
  input.endWhenReady();
  return input;
}

function normalizeTtyText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}


function waitForOutput(
  output: ReturnType<typeof createOutput>,
  text: string,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      output.off('data', check);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error(`output did not contain: ${text}`));
    };
    const check = () => {
      if (!normalizeTtyText(output.capturedText()).includes(text)) return;
      cleanup();
      resolve();
    };
    output.on('data', check);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    check();
  });
}


// Exercise the real Pi conductor event and send handling with a deterministic
// AgentSession boundary; no provider or network is needed.
function createScriptedPiAgent(
  options: ConductorAgentCreateOptions,
  prompt: (emit: (event: any) => void, text: string) => Promise<{ error?: string; text?: string }>,
) {
  let listener: (event: any) => void = () => {};
  const messages: any[] = [];
  const branch: any[] = [];
  const results: Awaited<ReturnType<ConductorAgent['send']>>[] = [];
  const session = {
    state: { messages },
    sessionManager: { getBranch: () => branch, appendCustomEntry: () => {} },
    subscribe: (next: typeof listener) => { listener = next; return () => {}; },
    prompt: async (text: string) => {
      const outcome = await prompt((event) => listener(event), text);
      const message = {
        role: 'assistant', content: outcome.text ? [{ type: 'text', text: outcome.text }] : [],
        stopReason: outcome.error ? 'error' : 'stop', errorMessage: outcome.error,
        model: 'smoke-model', usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
      };
      messages.push(message);
      branch.push({ type: 'message', id: 'user', message: { role: 'user', content: text } });
      branch.push({ type: 'message', id: 'assistant', message });
      listener({ type: 'agent_end', messages: [message] });
    },
    abort: async () => {}, dispose: () => {},
  };
  const agent = new PiConductorAgent(
    session as never, {} as never, {} as never, {} as never, { value: '' },
    'operator-agent-id', 'smoke-model', {}, { enabled: false }, { active: false },
    false, false, undefined, undefined, options.onRetryEvent, options.onCompactionEvent,
  );
  const send = agent.send.bind(agent);
  agent.send = async (...args) => {
    const result = await send(...args);
    results.push(result);
    return result;
  };
  return { agent, results, emit: (event: any) => listener(event) };
}


function canonicalBaseResumeStorePath(repoRoot: string): string {
  return resolveEnsemblePaths({ repoRoot }).canonicalSessionResumeStorePath(
    'https://github.com/example/project/issues/12',
    'conductor-one',
  );
}

function baseWatchStatePath(repoRoot: string): string {
  return operatorWatchStatePath(
    join(repoRoot, '.ensemble'),
    'smoke',
    'https://github.com/example/project/issues/12',
  );
}


async function writeUserMcpConfig(
  repoRoot: string,
  servers: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(repoRoot, '.ensemble', MCP_CONFIG_FILE),
    JSON.stringify({ mcpServers: servers }),
  );
}
