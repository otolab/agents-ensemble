import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { TuiViewModel, TuiViewSnapshot } from './tui-view-model.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import {
  ACTIVITY_LOG_LABEL_COLORS,
  buildActivityLogDisplayLines,
  formatActivityLogLabelPrefix,
  sliceActivityLogDisplayLines,
  type ActivityLogDisplayLine,
  type ActivityLogEntry,
} from './activity-log.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';

export interface IssueSessionTuiProps {
  viewModel: TuiViewModel;
  onSubmit: (text: string) => void;
}

const ROUND_BORDER_WIDTH = 2;
const PANE_PADDING_X = 1;
const WORKER_PANE_HEIGHT = 6;
const INPUT_PANE_HEIGHT = 4;
const OPEN_QUESTIONS_MIN_HEIGHT = 4;
const OPEN_QUESTIONS_MAX_HEIGHT = 10;
const SESSION_PANE_MIN_HEIGHT = 6;
const SESSION_HEADER_LINES = 1;

function usePaneContentWidth(): number {
  return getPaneContentWidth({
    columns: process.stdout.columns ?? 80,
    paddingX: PANE_PADDING_X,
    borderWidth: ROUND_BORDER_WIDTH,
  });
}

function countWrappedLines(text: string, width: number): number {
  return wrapTextToWidth(text, width).length;
}

function estimateOpenQuestionsPaneHeight(
  openQuestions: TuiViewSnapshot['displayState']['openQuestions'],
  contentWidth: number,
): number {
  if (openQuestions.length === 0) {
    return OPEN_QUESTIONS_MIN_HEIGHT;
  }

  let contentLines = 1;
  for (const question of openQuestions) {
    contentLines += countWrappedLines(
      `- ${question.id} [${question.responseType}] ${question.question}`,
      contentWidth,
    );
    if (question.context) {
      contentLines += countWrappedLines(`  ${question.context}`, contentWidth);
    }
  }

  const withChrome = contentLines + 2;
  return Math.min(
    OPEN_QUESTIONS_MAX_HEIGHT,
    Math.max(OPEN_QUESTIONS_MIN_HEIGHT, withChrome),
  );
}

function computeSessionPaneHeight(
  totalRows: number,
  openQuestionsHeight: number,
): number {
  const used = WORKER_PANE_HEIGHT + openQuestionsHeight + INPUT_PANE_HEIGHT;
  return Math.max(SESSION_PANE_MIN_HEIGHT, totalRows - used);
}

function getActivityLogVisibleLineCount(paneHeight: number): number {
  return Math.max(1, paneHeight - SESSION_HEADER_LINES - 2);
}

function WrappedTextLines({ text, width }: { text: string; width: number }) {
  const lines = wrapTextToWidth(text, width);
  return (
    <>
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`}>{line}</Text>
      ))}
    </>
  );
}

function ActivityLogDisplayLineRow({ line }: { line: ActivityLogDisplayLine }) {
  if (line.label === 'separator') {
    return <Text> </Text>;
  }

  const color = ACTIVITY_LOG_LABEL_COLORS[line.label];
  const prefix = formatActivityLogLabelPrefix(line.label);
  const indent = ' '.repeat(prefix.length);

  if (line.isContinuation) {
    return (
      <Text>
        {indent}
        {line.text}
      </Text>
    );
  }

  if (line.label === 'harness') {
    return (
      <Text>
        <Text color="yellow" dimColor>
          [{line.label}]
        </Text>
        <Text> {line.text}</Text>
      </Text>
    );
  }

  return (
    <Text>
      {color ? <Text color={color}>[{line.label}]</Text> : <Text>[{line.label}]</Text>}
      <Text> {line.text}</Text>
    </Text>
  );
}

function WorkerStatusPane({
  workers,
}: {
  workers: TuiViewSnapshot['displayState']['workers'];
}) {
  const entries = Object.entries(workers);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={WORKER_PANE_HEIGHT}>
      <Text bold>Workers</Text>
      {entries.length === 0 ? (
        <Text dimColor>(待機中)</Text>
      ) : (
        entries.map(([name, worker]) => (
          <Text key={name}>
            {name} ({worker.kind}): {worker.status}
          </Text>
        ))
      )}
    </Box>
  );
}

function ActivityLogPane({
  activityLog,
  contentWidth,
  paneHeight,
  linesFromBottom,
}: {
  activityLog: ActivityLogEntry[];
  contentWidth: number;
  paneHeight: number;
  linesFromBottom: number;
}) {
  const displayLines = useMemo(
    () => buildActivityLogDisplayLines(activityLog, contentWidth),
    [activityLog, contentWidth],
  );
  const visibleCount = getActivityLogVisibleLineCount(paneHeight);
  const visibleLines = sliceActivityLogDisplayLines(
    displayLines,
    visibleCount,
    linesFromBottom,
  );
  const pinnedToBottom = linesFromBottom === 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      paddingX={PANE_PADDING_X}
      height={paneHeight}
      overflow="hidden"
    >
      <Text bold>
        Session
        {!pinnedToBottom ? ' (PgUp/PgDn でスクロール · 最新へは End)' : ''}
      </Text>
      {activityLog.length === 0 ? (
        <Text dimColor>(活動ログなし)</Text>
      ) : (
        visibleLines.map((line, index) => (
          <ActivityLogDisplayLineRow key={`log-line-${index}`} line={line} />
        ))
      )}
    </Box>
  );
}

function OpenQuestionsPane({
  openQuestions,
  contentWidth,
  paneHeight,
}: {
  openQuestions: TuiViewSnapshot['displayState']['openQuestions'];
  contentWidth: number;
  paneHeight: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={PANE_PADDING_X}
      height={paneHeight}
      overflow="hidden"
    >
      <Text bold>Open questions</Text>
      {openQuestions.length === 0 ? (
        <Text dimColor>(未回答なし)</Text>
      ) : (
        openQuestions.map((question) => (
          <Box key={question.id} flexDirection="column">
            <WrappedTextLines
              text={`- ${question.id} [${question.responseType}] ${question.question}`}
              width={contentWidth}
            />
            {question.context ? (
              <WrappedTextLines text={`  ${question.context}`} width={contentWidth} />
            ) : null}
          </Box>
        ))
      )}
    </Box>
  );
}

export function IssueSessionTui({ viewModel, onSubmit }: IssueSessionTuiProps) {
  const snapshot = useSyncExternalStore(
    viewModel.subscribe,
    viewModel.getSnapshot,
    viewModel.getSnapshot,
  );
  const [inputValue, setInputValue] = useState('');
  const [linesFromBottom, setLinesFromBottom] = useState(0);
  const contentWidth = usePaneContentWidth();
  const totalRows = process.stdout.rows ?? 24;
  const openQuestionsHeight = estimateOpenQuestionsPaneHeight(
    snapshot.displayState.openQuestions,
    contentWidth,
  );
  const sessionPaneHeight = computeSessionPaneHeight(totalRows, openQuestionsHeight);
  const visibleLineCount = getActivityLogVisibleLineCount(sessionPaneHeight);
  const displayLineCount = useMemo(
    () => buildActivityLogDisplayLines(snapshot.activityLog, contentWidth).length,
    [snapshot.activityLog, contentWidth],
  );
  const maxLinesFromBottom = Math.max(0, displayLineCount - visibleLineCount);

  useEffect(() => {
    setLinesFromBottom((current) => Math.min(current, maxLinesFromBottom));
  }, [maxLinesFromBottom]);

  useInput((_input, key) => {
    if (key.pageUp) {
      setLinesFromBottom((current) => Math.min(current + visibleLineCount, maxLinesFromBottom));
      return;
    }
    if (key.pageDown) {
      setLinesFromBottom((current) => Math.max(0, current - visibleLineCount));
      return;
    }
    if (key.home) {
      setLinesFromBottom(maxLinesFromBottom);
      return;
    }
    if (key.end) {
      setLinesFromBottom(0);
    }
  });

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
    setInputValue('');
  };

  return (
    <Box flexDirection="column" height={totalRows}>
      <WorkerStatusPane workers={snapshot.displayState.workers} />
      <ActivityLogPane
        activityLog={snapshot.activityLog}
        contentWidth={contentWidth}
        paneHeight={sessionPaneHeight}
        linesFromBottom={linesFromBottom}
      />
      <OpenQuestionsPane
        openQuestions={snapshot.displayState.openQuestions}
        contentWidth={contentWidth}
        paneHeight={openQuestionsHeight}
      />
      <Box flexDirection="column" borderStyle="single" borderColor="white" paddingX={1} height={INPUT_PANE_HEIGHT}>
        <Text dimColor wrap="wrap">
          {snapshot.postLoopWaiting
            ? 'post-loop 待機中 — 追加指示を入力するか /exit で終了'
            : formatOperatorContextHint(snapshot.operatorContext)}
        </Text>
        <Text>
          operator&gt;{' '}
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
        </Text>
      </Box>
    </Box>
  );
}
