import { Box, Text, useBoxMetrics, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { TuiViewModel, TuiViewSnapshot } from './tui-view-model.js';
import { formatOperatorContextHint } from './format-operator-context.js';
import {
  ACTIVITY_LOG_LABEL_COLORS,
  advanceActivityLogScrollOffset,
  buildActivityLogDisplayLines,
  sliceActivityLogDisplayLines,
  type ActivityLogDisplayLine,
  type ActivityLogEntry,
  type ActivityLogLabel,
  type ActivityLogScrollAction,
} from './activity-log.js';
import {
  MAIN_PANE_TITLE,
  OPEN_QUESTIONS_PANE_HEIGHT,
  ORCHESTRATION_PANE_TITLE_ROWS,
  PANE_PADDING_X,
  ROUND_BORDER_WIDTH,
  WORKER_PANE_HEIGHT,
} from './tui-layout-constants.js';
import { ImeTextInput } from './ime-text-input.js';
import {
  computeActivityPaneHeight,
  computeInputPaneHeight,
  computeOperatorInputCursorX,
  computeOperatorInputCursorY,
  computeOrchestrationLogVisibleLineCount,
} from './compute-operator-input-cursor-y.js';
import {
  computeMaxInputDisplayLines,
  trimBlankLinesOnly,
} from './operator-input-layout.js';
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

function WrappedTextLines({
  text,
  width,
  dimColor = false,
}: {
  text: string;
  width: number;
  dimColor?: boolean;
}) {
  const lines = wrapTextToWidth(text, width);
  return (
    <>
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`} dimColor={dimColor}>
          {line}
        </Text>
      ))}
    </>
  );
}

function renderActivityLogLabel(label: ActivityLogLabel): ReactNode {
  if (label === 'harness') {
    return (
      <Text color="yellow" dimColor>
        [{label}]
      </Text>
    );
  }

  const color = ACTIVITY_LOG_LABEL_COLORS[label];
  return color ? <Text color={color}>[{label}]</Text> : <Text>[{label}]</Text>;
}

function ActivityLogDisplayLineRow({ line }: { line: ActivityLogDisplayLine }) {
  if (line.layout === 'separator') {
    return <Text> </Text>;
  }

  if (line.layout === 'body-row') {
    return <Text>{line.text}</Text>;
  }

  if (line.layout === 'label-row') {
    if (line.label === 'separator') {
      return <Text> </Text>;
    }
    return <Text>{renderActivityLogLabel(line.label)}</Text>;
  }

  if (line.label === 'separator') {
    return <Text> </Text>;
  }

  return (
    <Text>
      {renderActivityLogLabel(line.label)}
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      height={WORKER_PANE_HEIGHT}
      overflow="hidden"
    >
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

function getOrchestrationTitleLineCount(
  scrollHint: string,
  contentWidth: number,
): number {
  return wrapTextToWidth(`${MAIN_PANE_TITLE}${scrollHint}`, contentWidth).length;
}

function OrchestrationPane({
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
  const logAreaRef = useRef(null);
  const { height: measuredLogAreaHeight, hasMeasured } = useBoxMetrics(logAreaRef);
  const pinnedToBottom = linesFromBottom === 0;
  const scrollHint = pinnedToBottom
    ? ''
    : ' (PgUp/PgDn でスクロール · 最新へは End · 入力中は Ctrl+PgUp/PgDn)';
  const titleLineCount = getOrchestrationTitleLineCount(scrollHint, contentWidth);
  const estimatedLogLineCount = computeOrchestrationLogVisibleLineCount(
    paneHeight,
    titleLineCount,
  );
  const visibleCount =
    hasMeasured && measuredLogAreaHeight > 0
      ? Math.max(1, Math.floor(measuredLogAreaHeight))
      : estimatedLogLineCount;
  const displayLines = useMemo(
    () => buildActivityLogDisplayLines(activityLog, contentWidth),
    [activityLog, contentWidth],
  );
  const visibleLines = sliceActivityLogDisplayLines(
    displayLines,
    visibleCount,
    linesFromBottom,
  );

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
        {MAIN_PANE_TITLE}
        {scrollHint}
      </Text>
      <Box ref={logAreaRef} flexGrow={1} flexDirection="column" overflow="hidden">
        {activityLog.length === 0 ? (
          <Text dimColor>(活動ログなし)</Text>
        ) : (
          visibleLines.map((line, index) => (
            <ActivityLogDisplayLineRow key={`log-line-${index}`} line={line} />
          ))
        )}
      </Box>
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
  const [inputDisplayLineCount, setInputDisplayLineCount] = useState(1);
  const [linesFromBottom, setLinesFromBottom] = useState(0);
  const contentWidth = usePaneContentWidth();
  const terminalRows = process.stdout.rows ?? 24;
  const operatorPrompt = 'operator> ';
  const maxInputDisplayLines = computeMaxInputDisplayLines(terminalRows);
  const contextHint = snapshot.postLoopWaiting
    ? 'post-loop 待機中 — 追加指示を入力するか /exit で終了'
    : formatOperatorContextHint(snapshot.operatorContext);
  const hintLineCount = wrapTextToWidth(contextHint, contentWidth).length;
  const visibleInputDisplayLineCount = Math.min(inputDisplayLineCount, maxInputDisplayLines);
  const inputPaneHeight = computeInputPaneHeight({
    hintLineCount,
    inputDisplayLineCount: visibleInputDisplayLineCount,
  });
  const activityPaneHeight = computeActivityPaneHeight({
    terminalRows,
    hintLineCount,
    inputDisplayLineCount: visibleInputDisplayLineCount,
  });
  const visibleLineCount = computeOrchestrationLogVisibleLineCount(
    activityPaneHeight,
    ORCHESTRATION_PANE_TITLE_ROWS,
  );
  const displayLineCount = useMemo(
    () => buildActivityLogDisplayLines(snapshot.activityLog, contentWidth).length,
    [snapshot.activityLog, contentWidth],
  );
  const maxLinesFromBottom = Math.max(0, displayLineCount - visibleLineCount);
  const cursorStart = {
    x: computeOperatorInputCursorX(operatorPrompt),
    y: computeOperatorInputCursorY({
      terminalRows,
      hintLineCount,
      inputDisplayLineCount: visibleInputDisplayLineCount,
      cursorLineOffset: 0,
    }),
  };
  const handleDisplayLineCountChange = useCallback((lineCount: number) => {
    setInputDisplayLineCount(Math.max(1, lineCount));
  }, []);

  useEffect(() => {
    setLinesFromBottom((current) => Math.min(current, maxLinesFromBottom));
  }, [maxLinesFromBottom]);

  const applyScrollAction = (action: ActivityLogScrollAction) => {
    setLinesFromBottom((current) =>
      advanceActivityLogScrollOffset(
        current,
        action,
        visibleLineCount,
        maxLinesFromBottom,
      ),
    );
  };

  useInput((_input, key) => {
    const scrollWithModifier = key.ctrl;
    const scrollWithoutModifier = inputValue.length === 0;
    if (!scrollWithModifier && !scrollWithoutModifier) {
      return;
    }

    if (key.pageUp) {
      applyScrollAction('pageUp');
      return;
    }
    if (key.pageDown) {
      applyScrollAction('pageDown');
      return;
    }
    if (key.home) {
      applyScrollAction('home');
      return;
    }
    if (key.end) {
      applyScrollAction('end');
    }
  });

  const handleSubmit = (value: string) => {
    const trimmed = trimBlankLinesOnly(value);
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
    setInputValue('');
    setInputDisplayLineCount(1);
  };

  return (
    <Box flexDirection="column" height={terminalRows}>
      <WorkerStatusPane workers={snapshot.displayState.workers} />
      <OrchestrationPane
        activityLog={snapshot.activityLog}
        contentWidth={contentWidth}
        paneHeight={activityPaneHeight}
        linesFromBottom={linesFromBottom}
      />
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
        overflow="hidden"
      >
        <WrappedTextLines text={contextHint} width={contentWidth} dimColor />
        <ImeTextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          contentWidth={contentWidth}
          promptPrefix={operatorPrompt}
          maxDisplayLines={maxInputDisplayLines}
          onDisplayLineCountChange={handleDisplayLineCountChange}
          cursorStart={cursorStart}
        />
      </Box>
    </Box>
  );
}
