import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React, { useEffect } from 'react';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from 'ink-testing-library';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadForkKeyboardModules,
  OperatorTextAreaKeyboardHarness,
  type ForkKeyboardModules,
} from './operator-text-area-keyboard-harness.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/react-ink-textarea',
);
const keyboardInputPath = path.join(packageRoot, 'dist/hooks/useKeyboardInput.js');
const killRingModulePath = path.join(packageRoot, 'dist/hooks/useKillRing.js');

describe('react-ink-textarea keymap audit (patched fork)', () => {
  it('implements required Emacs chords in useKeyboardInput', () => {
    const source = readFileSync(keyboardInputPath, 'utf8');
    for (const snippet of [
      'input === "a"',
      'input === "e"',
      'input === "f"',
      'input === "b"',
      'input === "d"',
      'input === "p"',
      'input === "n"',
      'input === "k"',
      'input === "u"',
      'input === "w"',
      'input === "y"',
      'meta && input === "b"',
      'meta && input === "f"',
      'meta && input === "y"',
      'pushKill',
      'yank()',
      'yankPop()',
    ]) {
      expect(source, `missing ${snippet}`).toContain(snippet);
    }
    expect(source).not.toMatch(/const entry = redo\(/);
  });

  it('enables Ctrl+p/n visual row motion and leaves Ctrl+r history unsupported', () => {
    const constantsPath = path.join(packageRoot, 'dist/constants.js');
    const source = readFileSync(constantsPath, 'utf8');
    expect(source).toContain('Ctrl+P');
    expect(source).toContain('Ctrl+N');
    expect(source).not.toContain('Ctrl+R');
  });
});

describe('useKillRing (patched fork)', () => {
  afterEach(() => {
    cleanup();
  });

  it('yanks the most recent kill and appends consecutive kills', async () => {
    const { useKillRing } = await import(pathToFileURL(killRingModulePath).href);
    type KillRingApi = ReturnType<typeof useKillRing>;

    let api: KillRingApi | undefined;
    function KillRingProbe({
      onReady,
    }: {
      readonly onReady: (readyApi: KillRingApi) => void;
    }) {
      const readyApi = useKillRing();
      useEffect(() => {
        onReady(readyApi);
      }, [readyApi, onReady]);
      return null;
    }

    render(
      <KillRingProbe
        onReady={(readyApi) => {
          api = readyApi;
        }}
      />,
    );
    await flushInkStdin();

    expect(api).toBeDefined();
    api!.pushKill('remove');
    api!.pushKill(' tail', true);
    expect(api!.yank()).toBe('remove tail');
  });

  it('rotates the kill ring with yankPop', async () => {
    const { useKillRing } = await import(pathToFileURL(killRingModulePath).href);
    type KillRingApi = ReturnType<typeof useKillRing>;

    let api: KillRingApi | undefined;
    function KillRingProbe({
      onReady,
    }: {
      readonly onReady: (readyApi: KillRingApi) => void;
    }) {
      const readyApi = useKillRing();
      useEffect(() => {
        onReady(readyApi);
      }, [readyApi, onReady]);
      return null;
    }

    render(
      <KillRingProbe
        onReady={(readyApi) => {
          api = readyApi;
        }}
      />,
    );
    await flushInkStdin();

    api!.pushKill('first');
    api!.pushKill('second');
    expect(api!.yank()).toBe('second');
    expect(api!.yankPop()).toBe('first');
    expect(api!.yankPop()).toBe('second');
  });
});

describe('ink-test-keys Emacs sequences', () => {
  it('maps Readline control bytes', () => {
    expect(INK_TEST_KEYS.ctrlA).toBe('\x01');
    expect(INK_TEST_KEYS.ctrlD).toBe('\x04');
    expect(INK_TEST_KEYS.ctrlP).toBe('\x10');
    expect(INK_TEST_KEYS.ctrlN).toBe('\x0e');
    expect(INK_TEST_KEYS.ctrlK).toBe('\x0b');
    expect(INK_TEST_KEYS.ctrlY).toBe('\x19');
    expect(INK_TEST_KEYS.altF).toBe('\x1bf');
  });
});

type CursorPosition = readonly [line: number, column: number];

async function typeAndKeys(
  stdin: { write: (chunk: string) => void },
  ...keys: string[]
): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await flushInkStdin();
  }
}

function lastCursorPosition(
  onCursorPosition: ReturnType<typeof vi.fn>,
): CursorPosition | undefined {
  return onCursorPosition.mock.calls.at(-1)?.[0] as CursorPosition | undefined;
}

describe('TextArea keyboard path Emacs keys (ink stdin integration)', () => {
  let harnessModules: ForkKeyboardModules;

  beforeAll(async () => {
    harnessModules = await loadForkKeyboardModules();
  });

  afterEach(() => {
    cleanup();
  });

  function renderHarness(options: {
    readonly onValueChange?: (value: string) => void;
    readonly onCursorPosition?: (position: CursorPosition) => void;
    readonly lineWidth?: number;
  }) {
    return render(<OperatorTextAreaKeyboardHarness modules={harnessModules} {...options} />);
  }

  it('Ctrl+a and Ctrl+e move cursor to line start and end', async () => {
    const onCursorPosition = vi.fn();
    const { stdin } = renderHarness({ onCursorPosition });

    await typeAndKeys(stdin, 'hello', INK_TEST_KEYS.ctrlA);
    expect(lastCursorPosition(onCursorPosition)).toEqual([0, 0]);

    await typeAndKeys(stdin, INK_TEST_KEYS.ctrlE);
    expect(lastCursorPosition(onCursorPosition)).toEqual([0, 5]);
  });

  it('Ctrl+f and Ctrl+b move cursor by one character', async () => {
    const onCursorPosition = vi.fn();
    const { stdin } = renderHarness({ onCursorPosition });

    await typeAndKeys(stdin, 'abcde', INK_TEST_KEYS.ctrlA, INK_TEST_KEYS.ctrlF, INK_TEST_KEYS.ctrlF);
    expect(lastCursorPosition(onCursorPosition)).toEqual([0, 2]);

    await typeAndKeys(stdin, INK_TEST_KEYS.ctrlB);
    expect(lastCursorPosition(onCursorPosition)).toEqual([0, 1]);
  });

  it('Ctrl+d deletes the character after the cursor', async () => {
    const onValueChange = vi.fn();
    const { stdin } = renderHarness({ onValueChange });

    await typeAndKeys(stdin, 'abc', INK_TEST_KEYS.ctrlA, INK_TEST_KEYS.ctrlD);
    expect(onValueChange).toHaveBeenLastCalledWith('bc');
  });

  it('Ctrl+p/n move by visual row and are no-ops at the textarea boundaries', async () => {
    const onCursorPosition = vi.fn();
    const { stdin } = renderHarness({ onCursorPosition, lineWidth: 80 });

    await typeAndKeys(stdin, 'one\ntwo\nsix', INK_TEST_KEYS.ctrlP);
    expect(lastCursorPosition(onCursorPosition)).toEqual([1, 3]);

    await typeAndKeys(stdin, INK_TEST_KEYS.ctrlP);
    expect(lastCursorPosition(onCursorPosition)).toEqual([0, 3]);
    const atTop = lastCursorPosition(onCursorPosition);
    await typeAndKeys(stdin, INK_TEST_KEYS.ctrlP);
    expect(lastCursorPosition(onCursorPosition)).toEqual(atTop);

    await typeAndKeys(stdin, INK_TEST_KEYS.ctrlN);
    expect(lastCursorPosition(onCursorPosition)).toEqual([1, 3]);
    await typeAndKeys(stdin, INK_TEST_KEYS.ctrlN);
    expect(lastCursorPosition(onCursorPosition)).toEqual([2, 3]);
    const atBottom = lastCursorPosition(onCursorPosition);
    await typeAndKeys(stdin, INK_TEST_KEYS.ctrlN);
    expect(lastCursorPosition(onCursorPosition)).toEqual(atBottom);
  });

  it('Ctrl+k then Ctrl+y yanks the killed line via kill ring', async () => {
    const onValueChange = vi.fn();
    const { stdin } = renderHarness({ onValueChange });

    await typeAndKeys(stdin, 'hello world', INK_TEST_KEYS.ctrlA, INK_TEST_KEYS.ctrlK);
    expect(onValueChange).toHaveBeenLastCalledWith('');

    onValueChange.mockClear();
    await typeAndKeys(stdin, INK_TEST_KEYS.ctrlY);
    expect(onValueChange).toHaveBeenLastCalledWith('hello world');
  });

  it('Alt+f and Alt+b move cursor by word', async () => {
    const onCursorPosition = vi.fn();
    const { stdin } = renderHarness({ onCursorPosition });

    await typeAndKeys(stdin, 'hello world', INK_TEST_KEYS.ctrlA, INK_TEST_KEYS.altF);
    expect(lastCursorPosition(onCursorPosition)).toEqual([0, 6]);

    await typeAndKeys(stdin, INK_TEST_KEYS.altB);
    expect(lastCursorPosition(onCursorPosition)).toEqual([0, 0]);
  });
});
