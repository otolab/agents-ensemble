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
  dispose: () => void;
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

  setInputEnabled(inputEnabled: boolean): void {
    if (this.snapshot.inputEnabled === inputEnabled) return;
    this.update({ inputEnabled });
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

const ANSI_RED = '\u001b[31m';
const MAX_INPUT_DISPLAY_LINES = 6;

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
  const [cursorPosition, setCursorPosition] = React.useState<[number, number]>([
    0,
    0,
  ]);
  // Keep one row outside Ink's live frame so unmounting does not trigger its
  // fullscreen terminal clear, which also clears scrollback.
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
    Math.min(MAX_INPUT_DISPLAY_LINES, liveFrameRows - 3),
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
      <Static<ActivityEntry> items={[...snapshot.entries]}>
        {(entry) => (
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
        height={liveFrameRows}
        flexDirection="column"
        overflowY="hidden"
      >
        <Box flexGrow={1} />
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
  const ink = render(
    <OperatorAgentTui
      model={model}
      onSubmit={options.onSubmit}
      onInterrupt={options.onInterrupt}
    />,
    {
      stdin: options.stdin as NodeJS.ReadStream,
      stdout: options.stdout as NodeJS.WriteStream,
      alternateScreen: false,
      exitOnCtrlC: false,
      interactive: true,
    },
  );
  const handleResize = () => {
    const nextSize = readTerminalSize(options.stdout);
    model.setTerminalSize(nextSize.columns, nextSize.rows);
  };
  options.stdout.on('resize', handleResize);

  return {
    appendChannel: (channel, detail, logOptions) =>
      model.appendChannel(channel, detail, logOptions),
    appendUserMessage: (message) => model.appendDialogue('user', message),
    appendOperatorResponse: (response) =>
      model.appendDialogue('operator', response),
    setInputEnabled: (enabled) => model.setInputEnabled(enabled),
    dispose: () => {
      options.stdout.off('resize', handleResize);
      ink.unmount();
    },
  };
}
