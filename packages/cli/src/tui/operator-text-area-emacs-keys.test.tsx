import { afterEach, describe, expect, it } from 'vitest';
import React, { useEffect } from 'react';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from 'ink-testing-library';
import { flushInkStdin, INK_TEST_KEYS } from './ink-test-keys.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

  it('documents Ctrl+p/n/r as intentionally unsupported in constants', () => {
    const constantsPath = path.join(packageRoot, 'dist/constants.js');
    const source = readFileSync(constantsPath, 'utf8');
    expect(source).not.toContain('Ctrl+P');
    expect(source).not.toContain('Ctrl+N');
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
    expect(INK_TEST_KEYS.ctrlK).toBe('\x0b');
    expect(INK_TEST_KEYS.ctrlY).toBe('\x19');
    expect(INK_TEST_KEYS.altF).toBe('\x1bf');
  });
});
