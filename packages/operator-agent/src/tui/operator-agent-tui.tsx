import { ANSI_RED } from '../internal/operator-utils.js';
import { render, Box, Static, Text, useInput } from 'ink';
import { TextArea, type TLinePrefixProps } from 'react-ink-textarea';
import React, { useCallback, useSyncExternalStore } from 'react';

export type OperatorAgentTuiChannel = 'harness' | 'observation';

export interface OperatorAgentTuiLogOptions {
  readonly color?: string;
  readonly leadingBlank?: boolean;
}

export interface OperatorAgentTuiInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface OperatorAgentTuiOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

export interface OperatorAgentTuiHost {
  appendChannel: (
    channel: OperatorAgentTuiChannel,
    detail: string,
    options?: OperatorAgentTuiLogOptions,
  ) => void;
  appendUserMessage: (message: string) => void;
  appendOperatorResponse: (response: string) => void;
  setInputEnabled: (enabled: boolean) => void;
  setStatus: (status: string, since?: number) => void;
  setHarnessStatus: (status: string) => void;
  dispose: () => Promise<void>;
}

export interface CreateOperatorAgentTuiHostOptions {
  readonly stdin: OperatorAgentTuiInput;
  readonly stdout: OperatorAgentTuiOutput;
  readonly colorEnabled: boolean;
  readonly onSubmit: (message: string) => void;
  readonly onInterrupt: () => void;
}

type ActivityEntry =
  | {
      readonly id: number;
      readonly type: 'channel';
      readonly channel: OperatorAgentTuiChannel;
      readonly detail: string;
      readonly leadingBlank: boolean;
      readonly color?: 'red';
    }
  | {
      readonly id: number;
      readonly type: 'dialogue';
      readonly speaker: 'user' | 'operator';
      readonly detail: string;
    };

type NewActivityEntry = ActivityEntry extends infer Entry
  ? Entry extends { readonly id: number }
    ? Omit<Entry, 'id'>
    : never
  : never;

interface TuiSnapshot {
  readonly entries: readonly ActivityEntry[];
  readonly columns: number;
  readonly rows: number;
  readonly inputEnabled: boolean;
  readonly replayGeneration: number;
  readonly status: string;
  readonly statusSince: number;
  readonly harnessStatus: string;
}

class OperatorAgentTuiModel {
  private snapshot: TuiSnapshot;
  private readonly listeners = new Set<() => void>();
  private nextEntryId = 0;

  constructor(
    columns: number,
    rows: number,
    private readonly colorEnabled: boolean,
  ) {
    this.snapshot = {
      entries: [],
      columns,
      rows,
      inputEnabled: true,
      replayGeneration: 0,
      status: '待機中',
      harnessStatus: '',
      statusSince: Date.now(),
    };
  }

  readonly getSnapshot = (): TuiSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  appendChannel(
    channel: OperatorAgentTuiChannel,
    detail: string,
    options: OperatorAgentTuiLogOptions = {},
  ): void {
    this.append({
      type: 'channel',
      channel,
      detail,
      leadingBlank: options.leadingBlank !== false,
      ...(options.color === ANSI_RED ? { color: 'red' as const } : {}),
    });
  }

  appendDialogue(speaker: 'user' | 'operator', detail: string): void {
    this.append({ type: 'dialogue', speaker, detail });
  }

  setTerminalSize(columns: number, rows: number): void {
    if (
      this.snapshot.columns === columns &&
      this.snapshot.rows === rows
    ) {
      return;
    }
    this.update({ columns, rows });
  }

  replay(): void {
    this.update({ replayGeneration: this.snapshot.replayGeneration + 1 });
  }

  setInputEnabled(inputEnabled: boolean): void {
    if (this.snapshot.inputEnabled === inputEnabled) return;
    this.update({ inputEnabled });
  }

  setStatus(status: string, since?: number): void {
    if (since === undefined && this.snapshot.status === status) return;
    this.update({ status, statusSince: since ?? Date.now() });
  }

  setHarnessStatus(harnessStatus: string): void {
    if (this.snapshot.harnessStatus !== harnessStatus) this.update({ harnessStatus });
  }

  private append(entry: NewActivityEntry): void {
    this.update({
      entries: [
        ...this.snapshot.entries,
        { ...entry, id: this.nextEntryId++ } as ActivityEntry,
      ],
    });
  }

  private update(patch: Partial<TuiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  readonly colorsEnabled = (): boolean => this.colorEnabled;
}

const MAX_INPUT_DISPLAY_LINES = 6;
const RESIZE_SETTLE_MS = 150;
const SHUTDOWN_RESIZE_LIMIT_MS = 1_000;

function OperatorAgentTui({
  model,
  onSubmit,
  onInterrupt,
}: {
  readonly model: OperatorAgentTuiModel;
  readonly onSubmit: (message: string) => void;
  readonly onInterrupt: () => void;
}) {
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
  const colorEnabled = model.colorsEnabled();
  const [draft, setDraft] = React.useState('');
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, []);
  const [cursorPosition, setCursorPosition] = React.useState<[number, number]>([
    0,
    0,
  ]);
  // Limit the input viewport so the live frame stays below terminal height.
  const liveFrameRows = Math.max(1, snapshot.rows - 1);
  const handleInputChange = useCallback((value: string) => {
    setDraft(value);
  }, []);
  const promptPrefix = useCallback(
    ({ lineNumber, isContinuationLine }: TLinePrefixProps) =>
      lineNumber === 0 && !isContinuationLine ? (
        <Text dimColor={colorEnabled}>user&gt; </Text>
      ) : null,
    [colorEnabled],
  );
  const maxInputDisplayLines = Math.max(
    1,
    Math.min(MAX_INPUT_DISPLAY_LINES, liveFrameRows - 4),
  );
  const handleSubmit = useCallback(
    (value: string) => {
      if (!snapshot.inputEnabled || !value.trim()) return;
      onSubmit(value);
      setDraft('');
      setCursorPosition([0, 0]);
    },
    [onSubmit, snapshot.inputEnabled],
  );

  // Ctrl+C still exits cleanly while stdin is in Ink's raw mode.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') onInterrupt();
    },
    { isActive: snapshot.inputEnabled },
  );

  return (
    <>
      <Static<ActivityEntry | { readonly id: -1; readonly type: 'padding' }>
        key={snapshot.replayGeneration}
        items={[
          ...(snapshot.replayGeneration > 0
            ? [{ id: -1 as const, type: 'padding' as const }]
            : []),
          ...snapshot.entries,
        ]}
      >
        {(entry) => entry.type === 'padding' ? (
          <Text key="resize-padding">{'\n'.repeat(Math.max(0, snapshot.rows - 4))}</Text>
        ) : (
          <Box
            key={`operator-agent-log-${entry.id}`}
            flexDirection="column"
            marginTop={entry.type === 'channel' && entry.leadingBlank ? 1 : 0}
            marginBottom={1}
          >
            {entry.type === 'channel' ? (
              <Text>
                <Text
                  color={entry.color === 'red' && colorEnabled ? 'red' : undefined}
                  dimColor={entry.color !== 'red' && colorEnabled}
                >
                  [{entry.channel}]
                </Text>{' '}
                <Text color={entry.color === 'red' && colorEnabled ? 'red' : undefined}>
                  {entry.detail}
                </Text>
              </Text>
            ) : entry.speaker === 'operator' ? (
              <Text>
                <Text color={colorEnabled ? 'cyan' : undefined}>operator&gt;</Text>
                {'\n'}
                {entry.detail}
              </Text>
            ) : (
              <Text>
                <Text dimColor={colorEnabled}>user&gt;</Text> {entry.detail}
              </Text>
            )}
          </Box>
        )}
      </Static>
      <Box
        width={snapshot.columns}
        flexDirection="column"
        overflowY="hidden"
      >
        <Box width={snapshot.columns}>
          <Box flexShrink={1}>
            <Text wrap="truncate">operator: {snapshot.status}</Text>
          </Box>
          <Text> ({Math.max(0, Math.floor((now - snapshot.statusSince) / 1000))}s)</Text>
        </Box>
        {snapshot.harnessStatus && <Text wrap="truncate">harness: {snapshot.harnessStatus}</Text>}
        <Box
          width={snapshot.columns}
          borderStyle="round"
          paddingX={1}
          flexDirection="column"
        >
          <Box width={Math.max(1, snapshot.columns - 4)} flexDirection="column">
            <TextArea
              focus={snapshot.inputEnabled}
              value={draft}
              onChange={handleInputChange}
              onSubmit={handleSubmit}
              linePrefix={promptPrefix}
              viewportLines={maxInputDisplayLines}
              initialLineCount={1}
              cursorStart={snapshot.inputEnabled ? { x: 2, y: 2 } : undefined}
              cursorPosition={cursorPosition}
              onCursorChange={setCursorPosition}
            />
          </Box>
        </Box>
      </Box>
    </>
  );
}

function readTerminalSize(stdout: OperatorAgentTuiOutput): {
  columns: number;
  rows: number;
} {
  return {
    columns:
      typeof stdout.columns === 'number' && stdout.columns > 0
        ? stdout.columns
        : 80,
    rows:
      typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : 24,
  };
}

export function createOperatorAgentTuiHost(
  options: CreateOperatorAgentTuiHostOptions,
): OperatorAgentTuiHost {
  const size = readTerminalSize(options.stdout);
  const model = new OperatorAgentTuiModel(
    size.columns,
    size.rows,
    options.colorEnabled,
  );
  // Move the initial compact frame to the bottom; subsequent Static output
  // scrolls the terminal naturally and remains visible above the input.
  options.stdout.write('\n'.repeat(Math.max(0, size.rows - 4)));
  const frame = (
    <OperatorAgentTui
      model={model}
      onSubmit={options.onSubmit}
      onInterrupt={options.onInterrupt}
    />
  );
  const ink = render(
    frame,
    {
      stdin: options.stdin as NodeJS.ReadStream,
      stdout: options.stdout as NodeJS.WriteStream,
      alternateScreen: false,
      exitOnCtrlC: false,
      interactive: true,
    },
  );
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeRevision = 0;
  let recoveryNeeded = false;
  let disposing = false;
  const recoverResize = () => {
    ink.clear();
    options.stdout.write('\u001b[3J\u001b[2J\u001b[H');
    model.replay();
    recoveryNeeded = false;
  };
  const handleResize = () => {
    const nextSize = readTerminalSize(options.stdout);
    if (
      nextSize.columns === model.getSnapshot().columns &&
      nextSize.rows === model.getSnapshot().rows
    ) return;
    model.setTerminalSize(nextSize.columns, nextSize.rows);
    resizeRevision++;
    recoveryNeeded = true;
    if (disposing) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    // Let Ink and TextArea settle their new widths before replaying. Remount
    // only Static, preserving the editor's undo and kill ring state.
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      recoverResize();
    }, RESIZE_SETTLE_MS);
  };
  options.stdout.on('resize', handleResize);

  return {
    appendChannel: (channel, detail, logOptions) =>
      model.appendChannel(channel, detail, logOptions),
    appendUserMessage: (message) => model.appendDialogue('user', message),
    appendOperatorResponse: (response) =>
      model.appendDialogue('operator', response),
    setInputEnabled: (enabled) => model.setInputEnabled(enabled),
    setStatus: (status, since) => model.setStatus(status, since),
    setHarnessStatus: (status) => model.setHarnessStatus(status),
    dispose: async () => {
      disposing = true;
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = undefined;
      }
      const deadline = performance.now() + SHUTDOWN_RESIZE_LIMIT_MS;
      try {
        // Prefer a settled final frame, but never delay terminal restoration
        // indefinitely when the terminal keeps resizing.
        while (performance.now() < deadline) {
          if (recoveryNeeded) {
            const revision = resizeRevision;
            const remaining = deadline - performance.now();
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(RESIZE_SETTLE_MS, remaining)));
            if (performance.now() >= deadline) break;
            if (revision !== resizeRevision) continue;
            recoverResize();
          }
          const revision = resizeRevision;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const flushed = await Promise.race([
            ink.waitUntilRenderFlush().then(() => true),
            new Promise<false>((resolve) => {
              timeout = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
            }),
          ]);
          if (timeout) clearTimeout(timeout);
          if (!flushed) break;
          if (revision === resizeRevision) return;
        }
        // At the deadline, replay once at the last observed size. Further
        // terminal resizes can reflow this final frame after restoration.
        const size = readTerminalSize(options.stdout);
        model.setTerminalSize(size.columns, size.rows);
        recoverResize();
        ink.rerender(frame);
      } finally {
        options.stdout.off('resize', handleResize);
        ink.unmount();
      }
    },
  };
}
