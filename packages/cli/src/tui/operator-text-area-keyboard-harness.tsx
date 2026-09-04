/**
 * `react-ink-textarea` TextArea と同じ keyboard フック配線を再現するテスト用ハーネス。
 *
 * ink-testing-library では実 TextArea の measureElement 連鎖により stdin が
 * useKeyboardInput に届かないため、TextArea が内部で呼ぶ useKeyboardInput /
 * useKillRing / useUndo 経路を直接検証する。
 */
import React, { useState } from 'react';
import { Text, usePaste } from 'ink';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/react-ink-textarea',
);

type SetValueUpdater = string | ((previous: string) => string);
type SetCursorUpdater = number | ((previous: number) => number);

export type ForkKeyboardModules = {
  readonly useKeyboardInput: (options: {
    isActive: boolean;
    value: string;
    cursor: number;
    keybindings: Readonly<Record<string, boolean>>;
    autoNewLineLimit: number;
    onSubmit: (value: string) => void;
    onFirstLineUp: (() => void) | undefined;
    onLastLineDown: (() => void) | undefined;
    onFirstCharacterLeft: (() => void) | undefined;
    onLastCharacterRight: (() => void) | undefined;
    onTab: ((shift: boolean) => void) | undefined;
    setValue: (updater: SetValueUpdater) => void;
    setCursor: (updater: SetCursorUpdater, valueForCalculation?: string) => void;
    pushUndo: (type: 'insert' | 'delete', value: string, cursor: number) => void;
    undo: (
      value: string,
      cursor: number,
    ) => { value: string; cursor: number } | undefined;
    pushKill: (text: string, append?: boolean) => void;
    yank: () => string;
    yankPop: () => string;
    getLastYankLength: () => number;
    setLastYankLength: (length: number) => void;
    resetYankState: () => void;
    resetMutationTracking: () => void;
    resetBlink: () => void;
    lineWidth: number;
    visualRows: readonly unknown[];
  }) => void;
  readonly useKillRing: () => {
    pushKill: (text: string, append?: boolean) => void;
    yank: () => string;
    yankPop: () => string;
    getLastYankLength: () => number;
    setLastYankLength: (length: number) => void;
    resetYankState: () => void;
  };
  readonly useUndo: (options: {
    maxUndo: number;
    undoGroupDelay: number;
  }) => {
    pushUndo: (type: 'insert' | 'delete', value: string, cursor: number) => void;
    undo: (
      value: string,
      cursor: number,
    ) => { value: string; cursor: number } | undefined;
    resetMutationTracking: () => void;
  };
  readonly DEFAULT_KEYBINDINGS: Readonly<Record<string, boolean>>;
};

let forkModulesPromise: Promise<ForkKeyboardModules> | undefined;

export async function loadForkKeyboardModules(): Promise<ForkKeyboardModules> {
  forkModulesPromise ??= Promise.all([
    import(pathToFileURL(path.join(packageRoot, 'dist/hooks/useKeyboardInput.js')).href),
    import(pathToFileURL(path.join(packageRoot, 'dist/hooks/useKillRing.js')).href),
    import(pathToFileURL(path.join(packageRoot, 'dist/hooks/useUndo.js')).href),
    import(pathToFileURL(path.join(packageRoot, 'dist/constants.js')).href),
  ]).then(([keyboard, killRing, undo, constants]) => ({
    useKeyboardInput: keyboard.useKeyboardInput as ForkKeyboardModules['useKeyboardInput'],
    useKillRing: killRing.useKillRing as ForkKeyboardModules['useKillRing'],
    useUndo: undo.useUndo as ForkKeyboardModules['useUndo'],
    DEFAULT_KEYBINDINGS: constants.DEFAULT_KEYBINDINGS as ForkKeyboardModules['DEFAULT_KEYBINDINGS'],
  }));
  return forkModulesPromise;
}

export type KeyboardHarnessProps = {
  readonly modules: ForkKeyboardModules;
  readonly onValueChange?: (value: string) => void;
  readonly onCursorPosition?: (position: readonly [line: number, column: number]) => void;
};

export function OperatorTextAreaKeyboardHarness({
  modules,
  onValueChange,
  onCursorPosition,
}: KeyboardHarnessProps) {
  const { useKeyboardInput, useKillRing, useUndo, DEFAULT_KEYBINDINGS } = modules;
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const { pushUndo, undo, resetMutationTracking } = useUndo({
    maxUndo: 128,
    undoGroupDelay: 750,
  });
  const killRing = useKillRing();

  usePaste(() => {}, { isActive: true });

  useKeyboardInput({
    isActive: true,
    value,
    cursor,
    keybindings: DEFAULT_KEYBINDINGS,
    autoNewLineLimit: 3,
    onSubmit: () => {},
    onFirstLineUp: undefined,
    onLastLineDown: undefined,
    onFirstCharacterLeft: undefined,
    onLastCharacterRight: undefined,
    onTab: undefined,
    setValue: (updater: SetValueUpdater) => {
      setValue((previous) => {
        const next = typeof updater === 'function' ? updater(previous) : updater;
        onValueChange?.(next);
        return next;
      });
    },
    setCursor: (updater: SetCursorUpdater, valueForCalculation?: string) => {
      setCursor((previous) => {
        const baseValue = valueForCalculation ?? value;
        const next = typeof updater === 'function' ? updater(previous) : updater;
        const line = baseValue.slice(0, next).split('\n').length - 1;
        const column = next - (baseValue.lastIndexOf('\n', next - 1) + 1);
        onCursorPosition?.([line, column]);
        return next;
      });
    },
    pushUndo,
    undo,
    pushKill: killRing.pushKill,
    yank: killRing.yank,
    yankPop: killRing.yankPop,
    getLastYankLength: killRing.getLastYankLength,
    setLastYankLength: killRing.setLastYankLength,
    resetYankState: killRing.resetYankState,
    resetMutationTracking,
    resetBlink: () => {},
    lineWidth: 0,
    visualRows: [],
  });

  return <Text>{value}</Text>;
}
