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
  formatIssueLabel,
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
  const hasOpenQuestions = openQuestions.length > 0;
  const openQuestionsLayout = useMemo(
    () =>
      resolveOpenQuestionsPaneLayout({
        openQuestions,
        selectedIndex: selectedQuestionIndex,
        contentWidth,
        terminalRows,
        includeDiscretionaryInputHint: true,
      }),
    [openQuestions, selectedQuestionIndex, contentWidth, terminalRows],
  );
  const selectedQuestion = openQuestions[openQuestionsLayout.selectedIndex];
  const isPostLoopWaitingHint =
    !hasOpenQuestions && snapshot.postLoopWaiting && !snapshot.shuttingDown;
  const contextHint = hasOpenQuestions
    ? ''
    : snapshot.shuttingDown
      ? '終了しています…'
      : isPostLoopWaitingHint
        ? ''
        : snapshot.operatorContext
          ? formatOperatorContextHint(snapshot.operatorContext)
          : '';
  const contextHintText = contextHint
    ? prependIssueReference(
        issueUrl,
        contextHint,
        issueLinkMode === 'url' ? 'url' : 'label',
      )
    : '';
  const postLoopIssueReference = issueUrl?.trim()
    ? issueLinkMode === 'url'
      ? issueUrl.trim()
      : formatIssueLabel(issueUrl)
    : undefined;
  const contextHintLines = isPostLoopWaitingHint
    ? [
        '追加指示を入力するか /exit で終了',
        postLoopIssueReference
          ? `${postLoopIssueReference} — post-loop 待機中`
          : 'post-loop 待機中',
      ]
    : contextHintText
      ? [contextHintText]
      : [];
  const visibleInputDisplayLineCount = Math.min(inputDisplayLineCount, maxInputDisplayLines);
  const hintLineCount = contextHintLines.reduce(
    (lineCount, line) => lineCount + wrapTextToWidth(line, contentWidth).length,
    0,
  );
  const desiredInputPaneHeight = computeInputPaneHeight({
    hintLineCount,
    inputDisplayLineCount: visibleInputDisplayLineCount,
  });
  const openQuestionsPaneHeight = hasOpenQuestions ? openQuestionsLayout.paneHeight : 0;
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
        width={process.stdout.columns ?? 80}
        height={streamPaneHeights.dynamicFrameHeight}
        overflow="hidden"
      >
        {hasOpenQuestions ? <OpenQuestionsPane layout={streamOpenQuestionsLayout} /> : null}
        <TitledBorderPane
          title={INPUT_PANE_TITLE}
          borderStyle="single"
          borderColor={INPUT_PANE_BORDER_COLOR}
          paddingX={PANE_PADDING_X}
          height={streamPaneHeights.inputPaneHeight}
        >
          {contextHintLines.map((line, index) => (
            <WrappedTextLines
              key={`context-hint-${index}`}
              text={line}
              width={contentWidth}
              color={INPUT_PANE_HINT_COLOR}
              issueUrl={isPostLoopWaitingHint && index === 0 ? undefined : issueUrl}
              issueLinkMode={issueLinkMode}
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
          height={streamPaneHeights.workerPaneHeight}
        />
      </Box>
    </>
  );
}
