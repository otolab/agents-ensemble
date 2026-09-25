import { Box, Static, useInput } from 'ink';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { OperatorInputSubmitOptions } from '@agents-ensemble/core';
import { getTuiOpenQuestions, type TuiViewModel } from './tui-view-model.js';
import {
  advanceOpenQuestionSelection,
  clampOpenQuestionSelectionIndex,
  resolveOpenQuestionsPaneLayout,
} from './open-questions-pane.js';
import {
  INPUT_PANE_TITLE,
  INPUT_PANE_BORDER_COLOR,
  INPUT_PANE_HINT_COLOR,
  PANE_PADDING_X,
  ROUND_BORDER_WIDTH,
} from './tui-layout-constants.js';
import { OperatorTextArea } from './operator-text-area.js';
import {
  ActivityLogDisplayLineRow,
  OpenQuestionsPane,
  WorkerStatusPane,
  WrappedTextLines,
} from './issue-session-tui.js';
import {
  computeInputPaneHeight,
  computeOperatorInputCursorX,
  computeStreamOperatorInputCursorY,
} from './compute-operator-input-cursor-y.js';
import { computeMaxInputDisplayLines, trimBlankLinesOnly } from './operator-input-layout.js';
import {
  resolveOperatorInputDisplayMode,
  type IssueLinkMode,
} from './format-operator-context.js';
import { buildActivityLogDisplayLines, type ActivityLogEntry } from './activity-log.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';
import { resolveStreamPaneHeights } from './stream-layout.js';
import { TitledBorderPane } from './titled-border-pane.js';
import {
  useTuiTerminalSize,
  type TuiTerminalSizeStore,
} from './tui-terminal-size.js';
import {
  createStreamScrollbackState,
  reduceStreamScrollback,
  type StreamScrollbackEvent,
} from './stream-scrollback.js';

export interface IssueSessionTuiStreamProps {
  viewModel: TuiViewModel;
  onSubmit: (text: string, options?: OperatorInputSubmitOptions) => void;
  issueUrl?: string;
  issueLinkMode?: IssueLinkMode;
  terminalSizeStore?: TuiTerminalSizeStore;
  /** Optional event injection point for a future terminal scrollback adapter. */
  scrollbackEvent?: StreamScrollbackEvent;
}

function useStreamContentWidth(columns: number): number {
  return getPaneContentWidth({
    columns,
    paddingX: PANE_PADDING_X,
    borderWidth: ROUND_BORDER_WIDTH,
  });
}

function useStreamActivityLogWidth(columns: number): number {
  return Math.max(1, columns);
}

function StaticActivityLog({
  activityLog,
  contentWidth,
  replayGeneration,
}: {
  activityLog: ActivityLogEntry[];
  contentWidth: number;
  replayGeneration: number;
}) {
  return (
    <Static<ActivityLogEntry> key={replayGeneration} items={activityLog}>
      {(entry, index) => (
        <Box key={`activity-log-${index}`} flexDirection="column">
          {buildActivityLogDisplayLines([entry], contentWidth).map((line, lineIndex) => (
            <ActivityLogDisplayLineRow key={`activity-line-${index}-${lineIndex}`} line={line} />
          ))}
        </Box>
      )}
    </Static>
  );
}

export function IssueSessionTuiStream({
  viewModel,
  onSubmit,
  issueUrl,
  issueLinkMode = 'osc8',
  terminalSizeStore,
  scrollbackEvent,
}: IssueSessionTuiStreamProps) {
  const snapshot = useSyncExternalStore(
    viewModel.subscribe,
    viewModel.getSnapshot,
    viewModel.getSnapshot,
  );
  const [inputValue, setInputValue] = useState('');
  const [inputDisplayLineCount, setInputDisplayLineCount] = useState(1);
  const [selectedQuestionIndex, setSelectedQuestionIndex] = useState(0);
  const [scrollbackState, setScrollbackState] = useState(() =>
    createStreamScrollbackState(snapshot.activityLog.length),
  );
  const terminalSize = useTuiTerminalSize(terminalSizeStore);
  const { columns: terminalColumns, rows: terminalRows } = terminalSize;
  const contentWidth = useStreamContentWidth(terminalColumns);
  const activityLogContentWidth = useStreamActivityLogWidth(terminalColumns);
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
  const committedActivityCount = Math.min(
    scrollbackState.detached
      ? scrollbackState.committedActivityCount
      : snapshot.activityLog.length,
    snapshot.activityLog.length,
  );
  const pendingActivityCount = scrollbackState.detached
    ? Math.max(0, snapshot.activityLog.length - committedActivityCount)
    : 0;
  const scrollbackHint =
    pendingActivityCount > 0
      ? `${pendingActivityCount} 件の新着 · End で最新へ`
      : undefined;
  const contextHintLines = scrollbackHint
    ? [scrollbackHint, ...operatorInputDisplay.hintLines]
    : operatorInputDisplay.hintLines;
  const visibleInputDisplayLineCount = Math.min(inputDisplayLineCount, maxInputDisplayLines);
  const hintLineCount = contextHintLines.reduce(
    (lineCount, line) => lineCount + wrapTextToWidth(line, contentWidth).length,
    0,
  );
  const desiredInputPaneHeight = computeInputPaneHeight({
    hintLineCount,
    inputDisplayLineCount: visibleInputDisplayLineCount,
  });
  const openQuestionsPaneHeight =
    operatorInputDisplay.mode === 'withQuestions' ? openQuestionsLayout.paneHeight : 0;
  const streamPaneHeights = useMemo(
    () =>
      resolveStreamPaneHeights({
        terminalRows,
        openQuestionsPaneHeight,
        inputPaneHeight: desiredInputPaneHeight,
      }),
    [terminalRows, openQuestionsPaneHeight, desiredInputPaneHeight],
  );
  const cursorStart = {
    x: computeOperatorInputCursorX(operatorPrompt),
    y: computeStreamOperatorInputCursorY({
      openQuestionsPaneHeight: streamPaneHeights.openQuestionsPaneHeight,
      hintLineCount,
    }),
  };
  const streamOpenQuestionsLayout = useMemo(
    () => ({
      ...openQuestionsLayout,
      paneHeight: streamPaneHeights.openQuestionsPaneHeight,
    }),
    [openQuestionsLayout, streamPaneHeights.openQuestionsPaneHeight],
  );
  const handleDisplayLineCountChange = useCallback((lineCount: number) => {
    setInputDisplayLineCount(Math.max(1, lineCount));
  }, []);

  useEffect(() => {
    setSelectedQuestionIndex((current) =>
      clampOpenQuestionSelectionIndex(current, openQuestions.length),
    );
  }, [openQuestions]);

  useEffect(() => {
    if (!scrollbackEvent) {
      return;
    }

    // The prop is an edge-triggered event. A future adapter should replace it
    // when it observes another viewport transition.
    setScrollbackState((current) =>
      reduceStreamScrollback(current, scrollbackEvent, snapshot.activityLog.length),
    );
  }, [scrollbackEvent]);

  const dispatchScrollbackEvent = (event: StreamScrollbackEvent) => {
    setScrollbackState((current) =>
      reduceStreamScrollback(current, event, snapshot.activityLog.length),
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
      dispatchScrollbackEvent({ type: 'detached', source: 'keyboard' });
      return;
    }

    if (key.end) {
      dispatchScrollbackEvent({ type: 'follow', source: 'keyboard' });
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
    <>
      <StaticActivityLog
        activityLog={snapshot.activityLog.slice(0, committedActivityCount)}
        contentWidth={activityLogContentWidth}
        replayGeneration={snapshot.activityLogGeneration}
      />
      <Box
        flexDirection="column"
        width={terminalColumns}
        height={streamPaneHeights.dynamicFrameHeight}
        overflowX="visible"
        overflowY="hidden"
      >
        {operatorInputDisplay.mode === 'withQuestions' ? (
          <OpenQuestionsPane
            layout={streamOpenQuestionsLayout}
            terminalColumns={terminalColumns}
          />
        ) : null}
        <TitledBorderPane
          title={INPUT_PANE_TITLE}
          borderStyle="single"
          borderColor={INPUT_PANE_BORDER_COLOR}
          paddingX={PANE_PADDING_X}
          height={streamPaneHeights.inputPaneHeight}
          terminalColumns={terminalColumns}
        >
          {contextHintLines.map((line, index) => (
            <WrappedTextLines
              key={`context-hint-${index}`}
              text={line}
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
        <WorkerStatusPane
          workers={snapshot.displayState.workers}
          dispatchHold={snapshot.displayState.dispatchHold}
          height={streamPaneHeights.workerPaneHeight}
          terminalColumns={terminalColumns}
          issueUrl={issueUrl}
          issueLinkMode={issueLinkMode}
        />
      </Box>
    </>
  );
}
