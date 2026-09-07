import { Box, Static, useInput } from 'ink';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { OperatorInputSubmitOptions } from '@agents-ensemble/core';
import type { TuiViewModel } from './tui-view-model.js';
import {
  advanceOpenQuestionSelection,
  clampOpenQuestionSelectionIndex,
  resolveOpenQuestionsPaneLayout,
} from './open-questions-pane.js';
import {
  INPUT_PANE_TITLE,
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
  formatOperatorContextHint,
  prependIssueReference,
  type IssueLinkMode,
} from './format-operator-context.js';
import { buildActivityLogDisplayLines, type ActivityLogEntry } from './activity-log.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';
import { resolveStreamPaneHeights } from './stream-layout.js';
import { TitledBorderPane } from './titled-border-pane.js';

export interface IssueSessionTuiStreamProps {
  viewModel: TuiViewModel;
  onSubmit: (text: string, options?: OperatorInputSubmitOptions) => void;
  issueUrl?: string;
  issueLinkMode?: IssueLinkMode;
}

function useStreamContentWidth(): number {
  return getPaneContentWidth({
    columns: process.stdout.columns ?? 80,
    paddingX: PANE_PADDING_X,
    borderWidth: ROUND_BORDER_WIDTH,
  });
}

function useStreamActivityLogWidth(): number {
  return Math.max(1, process.stdout.columns ?? 80);
}

function StaticActivityLog({
  activityLog,
  contentWidth,
}: {
  activityLog: ActivityLogEntry[];
  contentWidth: number;
}) {
  return (
    <Static<ActivityLogEntry> items={activityLog}>
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
}: IssueSessionTuiStreamProps) {
  const snapshot = useSyncExternalStore(
    viewModel.subscribe,
    viewModel.getSnapshot,
    viewModel.getSnapshot,
  );
  const [inputValue, setInputValue] = useState('');
  const [inputDisplayLineCount, setInputDisplayLineCount] = useState(1);
  const [selectedQuestionIndex, setSelectedQuestionIndex] = useState(0);
  const contentWidth = useStreamContentWidth();
  const activityLogContentWidth = useStreamActivityLogWidth();
  const terminalRows = process.stdout.rows ?? 24;
  const operatorPrompt = 'operator> ';
  const maxInputDisplayLines = computeMaxInputDisplayLines(terminalRows);
  const openQuestions = snapshot.displayState.openQuestions;
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
  const contextHint = snapshot.shuttingDown
    ? '終了しています…'
    : snapshot.postLoopWaiting
      ? 'post-loop 待機中 — 追加指示を入力するか /exit で終了'
      : formatOperatorContextHint(
          snapshot.operatorContext,
          selectedQuestion
            ? {
                id: selectedQuestion.id,
                index: openQuestionsLayout.selectedIndex,
                total: openQuestions.length,
              }
            : undefined,
        );
  const contextHintText = prependIssueReference(
    issueUrl,
    contextHint,
    issueLinkMode === 'url' ? 'url' : 'label',
  );
  const visibleInputDisplayLineCount = Math.min(inputDisplayLineCount, maxInputDisplayLines);
  const hintLineCount = wrapTextToWidth(contextHintText, contentWidth).length;
  const desiredInputPaneHeight = computeInputPaneHeight({
    hintLineCount,
    inputDisplayLineCount: visibleInputDisplayLineCount,
  });
  const streamPaneHeights = useMemo(
    () =>
      resolveStreamPaneHeights({
        terminalRows,
        openQuestionsPaneHeight: openQuestionsLayout.paneHeight,
        inputPaneHeight: desiredInputPaneHeight,
    }),
    [terminalRows, openQuestionsLayout.paneHeight, desiredInputPaneHeight],
  );
  const cursorStart = {
    x: computeOperatorInputCursorX(operatorPrompt),
    y: computeStreamOperatorInputCursorY({
      workerPaneHeight: streamPaneHeights.workerPaneHeight,
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

  useInput((_input, key) => {
    if (openQuestions.length === 0 || !key.shift) {
      return;
    }

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
        activityLog={snapshot.activityLog}
        contentWidth={activityLogContentWidth}
      />
      <Box
        flexDirection="column"
        height={streamPaneHeights.dynamicFrameHeight}
        overflow="hidden"
      >
        <WorkerStatusPane
          workers={snapshot.displayState.workers}
          height={streamPaneHeights.workerPaneHeight}
        />
        <OpenQuestionsPane layout={streamOpenQuestionsLayout} />
        <TitledBorderPane
          title={INPUT_PANE_TITLE}
          borderStyle="single"
          borderColor="white"
          paddingX={PANE_PADDING_X}
          height={streamPaneHeights.inputPaneHeight}
        >
          <WrappedTextLines
            text={contextHintText}
            width={contentWidth}
            dimColor
            issueUrl={issueUrl}
            issueLinkMode={issueLinkMode}
          />
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
    </>
  );
}
