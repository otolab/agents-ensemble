import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useSyncExternalStore, useState } from 'react';
import type { TuiViewModel, TuiViewSnapshot } from './tui-view-model.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import { formatActivityLogLine } from './activity-log.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';

export interface IssueSessionTuiProps {
  viewModel: TuiViewModel;
  onSubmit: (text: string) => void;
}

const ROUND_BORDER_WIDTH = 2;
const PANE_PADDING_X = 1;

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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={6}>
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
      minHeight={4}
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

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
    setInputValue('');
  };

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      <WorkerStatusPane workers={snapshot.displayState.workers} />
      <ActivityLogPane activityLog={snapshot.activityLog} contentWidth={contentWidth} />
      <OpenQuestionsPane
        openQuestions={snapshot.displayState.openQuestions}
        contentWidth={contentWidth}
      />
      <Box flexDirection="column" borderStyle="single" borderColor="white" paddingX={1}>
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
