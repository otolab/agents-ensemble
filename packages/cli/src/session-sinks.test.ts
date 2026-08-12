import { describe, expect, it, vi } from 'vitest';
import {
  createDialogueSink,
  createHarnessSink,
  createObservationSink,
} from './session-sinks.js';

describe('session sinks', () => {
  it('formats worker prompt harness events on stderr', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sink = createHarnessSink();
    sink({
      type: 'harness.worker.prompt.started',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'harness',
    });
    sink({
      type: 'harness.worker.prompt.completed',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'harness',
      stopReason: 'end_turn',
    });
    sink({
      type: 'harness.worker.prompt.failed',
      name: 'implementer',
      kind: 'implementer',
      workerId: 'w-1',
      source: 'harness',
      error: 'attach failed',
    });

    expect(stderr).toHaveBeenCalledWith(
      '[harness] worker.prompt.started name=implementer kind=implementer source=harness',
    );
    expect(stderr).toHaveBeenCalledWith(
      '[harness] worker.prompt.completed name=implementer kind=implementer source=harness stopReason=end_turn',
    );
    expect(stderr).toHaveBeenCalledWith(
      '[harness] worker.prompt.failed name=implementer kind=implementer source=harness error=attach failed',
    );

    stderr.mockRestore();
  });

  it('formats harness events on stderr', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    createHarnessSink()({
      type: 'conductor.send',
      sendCount: 2,
      runId: 'run-2',
      status: 'error',
      error: { message: 'Model Blocked' },
      workerDispatches: 0,
      workerFailures: 0,
    });

    expect(stderr).toHaveBeenCalledWith(
      '[harness] conductor.send n=2 status=error workerDone=0 workerFailed=0 error=Model Blocked',
    );
    expect(stderr).toHaveBeenCalledTimes(1);

    stderr.mockRestore();
  });

  it('formats dialogue for operator and conductor', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const sink = createDialogueSink();
    sink({ type: 'operator.input', conductorTurn: 1, text: 'hello' });
    sink({
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'finished',
      result: 'conductor-ok',
      workerDispatches: 0,
      workerFailures: 0,
    });
    sink({
      type: 'worker.round',
      dispatch: {
        name: 'w',
        kind: 'w',
        issue: {
          owner: 'o',
          repo: 'r',
          number: 1,
          url: 'https://github.com/o/r/issues/1',
        },
        worktree: {
          path: '/wt',
          branch: 'b',
          issue: {
            owner: 'o',
            repo: 'r',
            number: 1,
            url: 'https://github.com/o/r/issues/1',
          },
        },
        prompt: 'p',
        promptResult: { stopReason: 'end_turn', responseText: 'hidden' },
        acpSessionId: 's',
      },
    });

    expect(write).toHaveBeenCalledWith('\noperator> hello\n');
    expect(write).toHaveBeenCalledWith('\nconductor> conductor-ok\n');
    expect(write).toHaveBeenCalledTimes(2);

    write.mockRestore();
  });

  it('shows auth-specific dialogue message on auth conductor error', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    createDialogueSink()({
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'error',
      error: {
        message: 'Authentication error If you are logged in, try logging out and back in.',
      },
      workerDispatches: 0,
      workerFailures: 0,
    });

    expect(write).toHaveBeenCalledWith(
      '\nconductor> 認証エラーが発生しました。stderr の [auth] 手順に従って再認証してください。\n',
    );

    write.mockRestore();
  });

  it('prints auth recovery hint from observation sink', () => {
    const writeStderr = vi.fn();

    createObservationSink({ writeStderr })({
      type: 'conductor.auth.recovery',
      agentId: 'agent-1',
      hint: '[auth] test recovery hint',
    });

    expect(writeStderr).toHaveBeenCalledWith('[auth] test recovery hint');
  });

  it('formats worker stderr on harness stderr', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    createHarnessSink()({
      type: 'worker.process.stderr',
      line: 'shell-parser: tree-sitter natives are unavailable',
      stream: 'stderr',
      workerName: 'implementer',
    });

    expect(stderr).toHaveBeenCalledWith(
      '[harness] worker.stderr name=implementer shell-parser: tree-sitter natives are unavailable',
    );

    stderr.mockRestore();
  });

  it('uses injected stderr writer for harness sink', () => {
    const writeStderr = vi.fn();

    createHarnessSink({ writeStderr })({
      type: 'session.stop',
      stopReason: 'completed',
    });

    expect(writeStderr).toHaveBeenCalledWith('[harness] session.stop reason=completed');
  });

  it('uses injected stdout writer for dialogue sink', () => {
    const writeStdout = vi.fn();

    createDialogueSink({ writeStdout })({
      type: 'operator.input',
      conductorTurn: 1,
      text: 'hello',
    });

    expect(writeStdout).toHaveBeenCalledWith('\noperator> hello\n');
  });

  it('formats observation events on stderr', () => {
    const writeStderr = vi.fn();
    const sink = createObservationSink({ writeStderr });

    sink({
      type: 'open.question.enqueued',
      question: {
        id: 'inq-1',
        question: 'approve merge?',
        responseType: 'yes_no',
        source: 'conductor',
        status: 'open',
        askedAt: 1,
      },
    });
    sink({
      type: 'escalation.recorded',
      record: {
        question: 'approve merge?',
        responseType: 'yes_no',
        answer: 'yes',
      },
    });
    sink({ type: 'session.worktree.notice', mode: 'in_repo' });
    sink({ type: 'session.continue', conductorAgentId: 'agent-1' });
    sink({ type: 'session.post_loop_wait' });

    expect(writeStderr).toHaveBeenCalledWith(
      '[open question] inq-1 [yes_no] approve merge?',
    );
    expect(writeStderr).toHaveBeenCalledWith(
      '[operator answer] approve merge? → yes',
    );
    expect(writeStderr).toHaveBeenCalledWith(
      '[worktree] 特別モード: メイン worktree で直接作業します（isolated worktree は作りません）',
    );
    expect(writeStderr).toHaveBeenCalledWith(
      '[continue] resuming session: conductorAgentId=agent-1',
    );
    expect(writeStderr).toHaveBeenCalledWith(
      '\n自律作業が一段落しました。追加の指示を入力するか、/exit で終了してください。\n',
    );
  });
});
