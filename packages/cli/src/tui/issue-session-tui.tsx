import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { useSyncExternalStore, useState } from 'react';
import type { TuiViewModel, TuiViewSnapshot } from './tui-view-model.js';
import { formatOperatorContextHint } from './format-operator-context.js';

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

function ConductorPane({
  conductorOutput,
  operatorLines,
}: {
  conductorOutput: string | null;
  operatorLines: string[];
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} flexGrow={1}>
      <Text bold>Conductor</Text>
      {operatorLines.map((line, index) => (
        <Text key={`op-${index}`} color="yellow">
          operator&gt; {line}
        </Text>
      ))}
      <Text>{conductorOutput ?? '(応答待ち)'}</Text>
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
      {snapshot.postLoopWaiting ? (
        <Text color="blueBright">
          自律作業が一段落しました。追加の指示を入力するか、/exit で終了してください。
        </Text>
      ) : null}
      <WorkerStatusPane workers={snapshot.displayState.workers} />
      <ConductorPane
        conductorOutput={snapshot.displayState.conductorOutput}
        operatorLines={snapshot.operatorLines}
      />
      <OpenQuestionsPane openQuestions={snapshot.displayState.openQuestions} />
      <Box flexDirection="column" borderStyle="single" borderColor="white" paddingX={1}>
        <Text dimColor>{formatOperatorContextHint(snapshot.operatorContext)}</Text>
        <Text>
          operator&gt;{' '}
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
        </Text>
      </Box>
    </Box>
  );
}
