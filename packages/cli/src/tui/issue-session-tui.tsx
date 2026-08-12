import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useSyncExternalStore, useState } from 'react';
import type { TuiViewModel, TuiViewSnapshot } from './tui-view-model.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import { formatActivityLogLine } from './activity-log.js';

export interface IssueSessionTuiProps {
  viewModel: TuiViewModel;
  onSubmit: (text: string) => void;
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
}: {
  activityLog: TuiViewSnapshot['activityLog'];
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} flexGrow={1}>
      <Text bold>Session</Text>
      {activityLog.length === 0 ? (
        <Text dimColor>(活動ログなし)</Text>
      ) : (
        activityLog.map((entry, index) => (
          <Text key={`log-${index}`}>{formatActivityLogLine(entry)}</Text>
        ))
      )}
    </Box>
  );
}

function OpenQuestionsPane({
  openQuestions,
}: {
  openQuestions: TuiViewSnapshot['displayState']['openQuestions'];
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} minHeight={4}>
      <Text bold>Open questions</Text>
      {openQuestions.length === 0 ? (
        <Text dimColor>(未回答なし)</Text>
      ) : (
        openQuestions.map((question) => (
          <Box key={question.id} flexDirection="column">
            <Text>
              - {question.id} [{question.responseType}] {question.question}
            </Text>
            {question.context ? <Text dimColor>  {question.context}</Text> : null}
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
      <ActivityLogPane activityLog={snapshot.activityLog} />
      <OpenQuestionsPane openQuestions={snapshot.displayState.openQuestions} />
      <Box flexDirection="column" borderStyle="single" borderColor="white" paddingX={1}>
        <Text dimColor>
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
