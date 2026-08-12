import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { useSyncExternalStore, useState } from 'react';
import type { TuiViewModel, TuiViewSnapshot } from './tui-view-model.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import { formatActivityLogLine } from './activity-log.js';
import {
  INPUT_PANE_BORDER_ROWS,
  OPEN_QUESTIONS_PANE_HEIGHT,
  PANE_PADDING_X,
  ROUND_BORDER_WIDTH,
  WORKER_PANE_HEIGHT,
} from './tui-layout-constants.js';
import { ImeTextInput } from './ime-text-input.js';
import { computeOperatorInputCursorY } from './compute-operator-input-cursor-y.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';

export interface IssueSessionTuiProps {
  viewModel: TuiViewModel;
  onSubmit: (text: string) => void;
}

function usePaneContentWidth(): number {
  return getPaneContentWidth({
    columns: process.stdout.columns ?? 80,
    paddingX: PANE_PADDING_X,
    borderWidth: ROUND_BORDER_WIDTH,
  });
}

function WrappedTextLines({ text, width }: { text: string; width: number }) {
  const lines = wrapTextToWidth(text, width);
  return (
    <>
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`} wrap="wrap">
          {line}
        </Text>
      ))}
    </>
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
}: {
  activityLog: TuiViewSnapshot['activityLog'];
  contentWidth: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={PANE_PADDING_X} flexGrow={1}>
      <Text bold>Session</Text>
      {activityLog.length === 0 ? (
        <Text dimColor>(活動ログなし)</Text>
      ) : (
        activityLog.map((entry, index) => (
          <Box key={`log-${index}`} flexDirection="column">
            <WrappedTextLines text={formatActivityLogLine(entry)} width={contentWidth} />
          </Box>
        ))
      )}
    </Box>
  );
}

function OpenQuestionsPane({
  openQuestions,
  contentWidth,
}: {
  openQuestions: TuiViewSnapshot['displayState']['openQuestions'];
  contentWidth: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={PANE_PADDING_X}
      height={OPEN_QUESTIONS_PANE_HEIGHT}
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
  const contentWidth = usePaneContentWidth();
  const terminalRows = process.stdout.rows ?? 24;
  const operatorPrompt = 'operator> ';
  const contextHint = snapshot.postLoopWaiting
    ? 'post-loop 待機中 — 追加指示を入力するか /exit で終了'
    : formatOperatorContextHint(snapshot.operatorContext);
  // IME カーソル Y 算出用。表示は Ink の wrap="wrap"（折り返し幅が wrapTextToWidth と微妙に異なる可能性あり）
  const hintLineCount = wrapTextToWidth(contextHint, contentWidth).length;
  const inputPaneHeight = INPUT_PANE_BORDER_ROWS + hintLineCount + 1;
  const inputCursorY = computeOperatorInputCursorY({
    terminalRows,
    hintLineCount,
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
    <Box flexDirection="column" height={terminalRows}>
      <WorkerStatusPane workers={snapshot.displayState.workers} />
      <ActivityLogPane activityLog={snapshot.activityLog} contentWidth={contentWidth} />
      <OpenQuestionsPane
        openQuestions={snapshot.displayState.openQuestions}
        contentWidth={contentWidth}
      />
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="white"
        paddingX={1}
        height={inputPaneHeight}
      >
        <Text dimColor wrap="wrap">
          {contextHint}
        </Text>
        <Text>
          {operatorPrompt}
          <ImeTextInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
            cursorStart={{
              x: stringWidth(operatorPrompt),
              y: inputCursorY,
            }}
          />
        </Text>
      </Box>
    </Box>
  );
}
