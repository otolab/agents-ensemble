import { Box, Text, useBoxMetrics, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  getTuiOpenQuestions,
  type TuiViewModel,
  type TuiViewSnapshot,
} from './tui-view-model.js';
import type { WorkerDisplayStatus } from '../display/session-display-state.js';
import {
  formatIssueLabel,
  formatIssueReference,
  resolveOperatorInputDisplayMode,
  type IssueLinkMode,
} from './format-operator-context.js';
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
import type { OperatorInputSubmitOptions } from '@agents-ensemble/core';
import {
  advanceOpenQuestionSelection,
  clampOpenQuestionSelectionIndex,
  resolveOpenQuestionsPaneLayout,
  type OpenQuestionsPaneLayout,
} from './open-questions-pane.js';
import {
  INPUT_PANE_TITLE,
  INPUT_PANE_BORDER_COLOR,
  INPUT_PANE_HINT_COLOR,
  MAIN_PANE_TITLE,
  PANE_PADDING_X,
  ROUND_BORDER_WIDTH,
  WORKER_PANE_HEIGHT,
  WORKER_PANE_TITLE,
} from './tui-layout-constants.js';
import { OperatorTextArea } from './operator-text-area.js';
import { TitledBorderPane } from './titled-border-pane.js';
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
  onSubmit: (text: string, options?: OperatorInputSubmitOptions) => void;
  issueUrl?: string;
  issueLinkMode?: IssueLinkMode;
}

function usePaneContentWidth(): number {
  return getPaneContentWidth({
    columns: process.stdout.columns ?? 80,
    paddingX: PANE_PADDING_X,
    borderWidth: ROUND_BORDER_WIDTH,
  });
}

export function WrappedTextLines({
  text,
  width,
  dimColor = false,
  color,
  issueUrl,
  issueLinkMode = 'label',
}: {
  text: string;
  width: number;
  dimColor?: boolean;
  color?: string;
  issueUrl?: string;
  issueLinkMode?: IssueLinkMode;
}) {
  const lines = wrapTextToWidth(text, width);
  const issueLabel = issueUrl ? formatIssueLabel(issueUrl) : undefined;
  const issueLink =
    issueUrl && issueLabel && issueLinkMode === 'osc8'
      ? formatIssueReference(issueUrl, 'osc8')
      : undefined;
  return (
    <>
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`} color={color} dimColor={dimColor}>
          {index === 0 && issueLink && issueLabel && line.startsWith(issueLabel) ? (
            <>
              <Text>{issueLink}</Text>
              <Text>{line.slice(issueLabel.length)}</Text>
            </>
          ) : (
            line
          )}
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

export function ActivityLogDisplayLineRow({ line }: { line: ActivityLogDisplayLine }) {
  if (line.layout === 'separator') {
    return <Text> </Text>;
  }

  if (line.layout === 'body-row') {
    // Ink は空 <Text> の行高 0 になる。separator と同様スペース 1 文字で可視の空行にする。
    return line.text === '' ? <Text> </Text> : <Text>{line.text}</Text>;
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

function formatConductorWorkerStatusLine(
  name: string,
  worker: { kind: string; status: WorkerDisplayStatus; activity?: string },
): string {
  if (worker.kind === 'conductor') {
    if (worker.status === 'running') {
      const label = worker.activity ?? 'thinking';
      return `conductor: ${label}`;
    }
    return `conductor: ${worker.status}`;
  }
  if (worker.status === 'running' && worker.activity) {
    return `${name} (${worker.kind}): running (${worker.activity})`;
  }
  return `${name} (${worker.kind}): ${worker.status}`;
}

function sortWorkerEntries(
  entries: [string, { kind: string; status: WorkerDisplayStatus }][],
): [string, { kind: string; status: WorkerDisplayStatus }][] {
  return [...entries].sort(([nameA], [nameB]) => {
    if (nameA === 'conductor') {
      return -1;
    }
    if (nameB === 'conductor') {
      return 1;
    }
    return nameA.localeCompare(nameB);
  });
}

export function WorkerStatusPane({
  workers,
  dispatchHold,
  height = WORKER_PANE_HEIGHT,
  issueUrl,
  issueLinkMode = 'label',
}: {
  workers: TuiViewSnapshot['displayState']['workers'];
  dispatchHold?: TuiViewSnapshot['displayState']['dispatchHold'];
  height?: number;
  issueUrl?: string;
  issueLinkMode?: IssueLinkMode;
}) {
  const entries = sortWorkerEntries(Object.entries(workers));
  const issueTitleRight = issueUrl ? formatIssueLabel(issueUrl) : undefined;
  const dispatchHoldSuffix = dispatchHold?.hold
    ? ` — conductor dispatch 保留中（${dispatchHold.heldEventCount} 件）`
    : undefined;
  return (
    <TitledBorderPane
      title={WORKER_PANE_TITLE}
      titleSuffix={dispatchHoldSuffix}
      titleRight={issueTitleRight}
      titleRightIssueUrl={issueUrl}
      titleRightLinkMode={issueLinkMode}
      borderStyle="round"
      borderColor="cyan"
      paddingX={PANE_PADDING_X}
      height={height}
    >
      {entries.length === 0 ? (
        <Text dimColor>(待機中)</Text>
      ) : (
        entries.map(([name, worker]) => (
          <Text key={name}>{formatConductorWorkerStatusLine(name, worker)}</Text>
        ))
      )}
    </TitledBorderPane>
  );
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
    ? undefined
    : ' (PgUp/PgDn でスクロール · 最新へは End · 入力中は Ctrl+PgUp/PgDn)';
  const estimatedLogLineCount = computeOrchestrationLogVisibleLineCount(paneHeight);
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
    <TitledBorderPane
      title={MAIN_PANE_TITLE}
      titleSuffix={scrollHint}
      borderStyle="round"
      borderColor="green"
      paddingX={PANE_PADDING_X}
      height={paneHeight}
    >
      <Box ref={logAreaRef} flexGrow={1} flexDirection="column" overflow="hidden">
        {activityLog.length === 0 ? (
          <Text dimColor>(活動ログなし)</Text>
        ) : (
          visibleLines.map((line, index) => (
            <ActivityLogDisplayLineRow key={`log-line-${index}`} line={line} />
          ))
        )}
      </Box>
    </TitledBorderPane>
  );
}

export function OpenQuestionsPane({
  layout,
}: {
  layout: OpenQuestionsPaneLayout;
}) {
  if (layout.paneHeight === 0 || layout.items.length === 0) {
    return null;
  }

  return (
    <TitledBorderPane
      title={layout.titleText}
      titleSuffix={layout.titleSuffix}
      borderStyle="round"
      borderColor="magenta"
      paddingX={PANE_PADDING_X}
      height={layout.paneHeight}
      titleBold={false}
    >
      {layout.items.flatMap((item) =>
        item.lines.map((line, lineIndex) => (
          <Text key={`${item.id}-${lineIndex}`} dimColor={item.compact && !item.isSelected}>
            {line}
          </Text>
        )),
      )}
    </TitledBorderPane>
  );
}

export function IssueSessionTui({
  viewModel,
  onSubmit,
  issueUrl,
  issueLinkMode = 'osc8',
}: IssueSessionTuiProps) {
  const snapshot = useSyncExternalStore(
    viewModel.subscribe,
    viewModel.getSnapshot,
    viewModel.getSnapshot,
  );
  const [inputValue, setInputValue] = useState('');
  const [inputDisplayLineCount, setInputDisplayLineCount] = useState(1);
  const [linesFromBottom, setLinesFromBottom] = useState(0);
  const [selectedQuestionIndex, setSelectedQuestionIndex] = useState(0);
  const contentWidth = usePaneContentWidth();
  const terminalRows = process.stdout.rows ?? 24;
  const operatorPrompt = 'operator> ';
  const maxInputDisplayLines = computeMaxInputDisplayLines(terminalRows);
  const openQuestions = getTuiOpenQuestions(snapshot);
  const openQuestionsLayout = useMemo(
    () =>
      resolveOpenQuestionsPaneLayout({
        openQuestions,
        selectedIndex: selectedQuestionIndex,
        contentWidth,
        terminalRows,
      }),
    [openQuestions, selectedQuestionIndex, contentWidth, terminalRows],
  );
  const selectedQuestion = openQuestions[openQuestionsLayout.selectedIndex];
  const operatorInputDisplay = resolveOperatorInputDisplayMode({
    openQuestions,
    selection: selectedQuestion
      ? {
          id: selectedQuestion.id,
          index: openQuestionsLayout.selectedIndex,
          total: openQuestions.length,
        }
      : undefined,
    postLoopWaiting: snapshot.postLoopWaiting,
    shuttingDown: snapshot.shuttingDown,
  });
  const openQuestionsPaneHeight =
    operatorInputDisplay.mode === 'withQuestions' ? openQuestionsLayout.paneHeight : 0;
  const hintLineCount = operatorInputDisplay.hintLines.reduce(
    (lineCount, hintLine) => lineCount + wrapTextToWidth(hintLine, contentWidth).length,
    0,
  );
  const visibleInputDisplayLineCount = Math.min(inputDisplayLineCount, maxInputDisplayLines);
  const inputPaneHeight = computeInputPaneHeight({
    hintLineCount,
    inputDisplayLineCount: visibleInputDisplayLineCount,
  });
  const activityPaneHeight = computeActivityPaneHeight({
    terminalRows,
    hintLineCount,
    inputDisplayLineCount: visibleInputDisplayLineCount,
    openQuestionsPaneHeight,
  });
  const visibleLineCount = computeOrchestrationLogVisibleLineCount(activityPaneHeight);
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
      openQuestionsPaneHeight,
      cursorLineOffset: 0,
    }),
  };
  const handleDisplayLineCountChange = useCallback((lineCount: number) => {
    setInputDisplayLineCount(Math.max(1, lineCount));
  }, []);

  useEffect(() => {
    setLinesFromBottom((current) => Math.min(current, maxLinesFromBottom));
  }, [maxLinesFromBottom]);

  useEffect(() => {
    setSelectedQuestionIndex((current) =>
      clampOpenQuestionSelectionIndex(current, openQuestions.length),
    );
  }, [openQuestions]);

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
    if (openQuestions.length > 0 && key.shift) {
      if (key.upArrow) {
        setSelectedQuestionIndex((current) =>
          advanceOpenQuestionSelection(current, 'up', openQuestions.length),
        );
        return;
      }
      if (key.downArrow) {
        setSelectedQuestionIndex((current) =>
          advanceOpenQuestionSelection(current, 'down', openQuestions.length),
        );
        return;
      }
    }

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
    if (snapshot.shuttingDown) {
      return;
    }

    const trimmed = trimBlankLinesOnly(value);
    if (!trimmed) {
      return;
    }

    onSubmit(
      trimmed,
      selectedQuestion && openQuestions.length > 0
        ? { targetOpenQuestionId: selectedQuestion.id }
        : undefined,
    );
    setInputValue('');
    setInputDisplayLineCount(1);
  };

  return (
    <Box flexDirection="column" height={terminalRows}>
      <WorkerStatusPane
        workers={snapshot.displayState.workers}
        dispatchHold={snapshot.displayState.dispatchHold}
        issueUrl={issueUrl}
        issueLinkMode={issueLinkMode}
      />
      <OrchestrationPane
        activityLog={snapshot.activityLog}
        contentWidth={contentWidth}
        paneHeight={activityPaneHeight}
        linesFromBottom={linesFromBottom}
      />
      {operatorInputDisplay.mode === 'withQuestions' ? (
        <OpenQuestionsPane layout={openQuestionsLayout} />
      ) : null}
      <TitledBorderPane
        title={INPUT_PANE_TITLE}
        borderStyle="single"
        borderColor={INPUT_PANE_BORDER_COLOR}
        paddingX={PANE_PADDING_X}
        height={inputPaneHeight}
      >
        {operatorInputDisplay.hintLines.map((hintLine, index) => (
          <WrappedTextLines
            key={`context-hint-${index}`}
            text={hintLine}
            width={contentWidth}
            color={INPUT_PANE_HINT_COLOR}
          />
        ))}
        <OperatorTextArea
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          focus={!snapshot.shuttingDown}
          contentWidth={contentWidth}
          promptPrefix={operatorPrompt}
          maxDisplayLines={maxInputDisplayLines}
          onDisplayLineCountChange={handleDisplayLineCountChange}
          cursorStart={cursorStart}
        />
      </TitledBorderPane>
    </Box>
  );
}
