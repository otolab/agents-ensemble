import { describe, expect, it, vi } from 'vitest';
import { SessionDialogueLog } from './dialogue-log.js';
import {
  ensureMaxTurnsOpenQuestion,
  MAX_TURNS_OPEN_QUESTION_TEXT,
} from './enqueue-max-turns-question.js';
import { OpenQuestionRegistry } from './open-question.js';

describe('ensureMaxTurnsOpenQuestion', () => {
  it('enqueues a max_turns open question', () => {
    const registry = new OpenQuestionRegistry();
    const dialogueLog = new SessionDialogueLog();

    const entry = ensureMaxTurnsOpenQuestion(registry, dialogueLog, {
      issueUrl: 'https://github.com/org/repo/issues/1',
      autonomousTurns: 5,
      maxTurns: 5,
      turnCount: 5,
      workerDispatchCount: 1,
      workerFailureCount: 0,
      lastResult: 'done for now',
    });

    expect(entry.question).toBe(MAX_TURNS_OPEN_QUESTION_TEXT);
    expect(entry.source).toBe('max_turns');
    expect(registry.openCount).toBe(1);
    expect(dialogueLog.list()[0]?.kind).toBe('registry_update');
  });

  it('does not duplicate an existing max_turns open question', () => {
    const registry = new OpenQuestionRegistry();
    const dialogueLog = new SessionDialogueLog();
    const onEnqueued = vi.fn();
    const input = {
      issueUrl: 'https://github.com/org/repo/issues/1',
      autonomousTurns: 5,
      maxTurns: 5,
      turnCount: 5,
      workerDispatchCount: 0,
      workerFailureCount: 0,
    };

    const first = ensureMaxTurnsOpenQuestion(
      registry,
      dialogueLog,
      input,
      onEnqueued,
    );
    const second = ensureMaxTurnsOpenQuestion(
      registry,
      dialogueLog,
      input,
      onEnqueued,
    );

    expect(second.id).toBe(first.id);
    expect(registry.openCount).toBe(1);
    expect(onEnqueued).toHaveBeenCalledOnce();
  });
});
