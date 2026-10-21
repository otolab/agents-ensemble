import { describe, expect, it } from 'vitest';
import { OperatorInputHistory } from './operator-input-history.js';

describe('OperatorInputHistory', () => {
  it('keeps a draft while browsing and restores it after reaching the newest entry', () => {
    const history = new OperatorInputHistory();
    history.submit('A');

    expect(history.older('B draft')).toBe('A');
    expect(history.newer()).toBe('B draft');
    expect(history.newer()).toBeUndefined();
  });

  it('adds an edited past entry without changing the original and keeps the draft across submit', () => {
    const history = new OperatorInputHistory();
    history.submit('A');
    expect(history.older('B draft')).toBe('A');

    history.submit("A'");
    expect(history.newer()).toBe('B draft');
    expect(history.older('next draft')).toBe("A'");
    expect(history.older("A'")).toBe('A');
  });

  it('abandons the saved draft when new input starts after a historical submit', () => {
    const history = new OperatorInputHistory();
    history.submit('A');
    expect(history.older('B draft')).toBe('A');
    history.submit("A'");
    history.abandonDeferredDraftOnInput();

    expect(history.newer()).toBeUndefined();
    expect(history.older('new draft')).toBe("A'");
    expect(history.newer()).toBe('new draft');
  });
});
