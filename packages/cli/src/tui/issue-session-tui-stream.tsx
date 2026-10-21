import { Box, Static, Text, useInput } from 'ink';
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
  OPERATOR_INPUT_PROMPT,
  PANE_PADDING_X,
  ROUND_BORDER_WIDTH,
} from './tui-layout-constants.js';
import { OperatorTextArea } from './operator-text-area.js';
import {
  advanceOperatorCommandSelection,
  getOperatorCommandSuggestionLines,
  getOperatorCommandSuggestions,
} from './operator-command-suggestions.js';
import {
  advanceOpenQuestionAnswerSuggestionSelection,
  getOpenQuestionAnswerSuggestionLines,
  getOpenQuestionAnswerSuggestions,
} from './open-question-answer-suggestions.js';
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
import { computeWorkerPaneHeight } from './pane-layout.js';
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
  issueLinkMode,
}: {
  activityLog: ActivityLogEntry[];
  contentWidth: number;
  replayGeneration: number;
  issueLinkMode: IssueLinkMode;
}) {
  return (
    <Static<ActivityLogEntry> key={replayGeneration} items={activityLog}>
      {(entry, index) => (
        <Box key={`activity-log-${index}`} flexDirection="column">
          {buildActivityLogDisplayLines([entry], contentWidth).map((line, lineIndex) => (
            <ActivityLogDisplayLineRow
              key={`activity-line-${index}-${lineIndex}`}
              line={line}
              issueLinkMode={issueLinkMode}
            />
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
  const [inputCursorPosition, setInputCursorPosition] = useState<[number, number]>([0, 0]);
  const [inputDisplayLineCount, setInputDisplayLineCount] = useState(1);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [selectedAnswerSuggestionIndex, setSelectedAnswerSuggestionIndex] = useState(0);
  const [selectedQuestionIndex, setSelectedQuestionIndex] = useState(0);
  const [hiddenAnswerSuggestionQuestionId, setHiddenAnswerSuggestionQuestionId] =
    useState<string>();
  const [scrollbackState, setScrollbackState] = useState(() =>
    createStreamScrollbackState(snapshot.activityLog.length),
  );
  const terminalSize = useTuiTerminalSize(terminalSizeStore);
  const { columns: terminalColumns, rows: terminalRows } = terminalSize;
  const contentWidth = useStreamContentWidth(terminalColumns);
  const activityLogContentWidth = useStreamActivityLogWidth(terminalColumns);
  const operatorPrompt = OPERATOR_INPUT_PROMPT;
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
  const commandSuggestions = getOperatorCommandSuggestions(inputValue);
  const commandSuggestionLines = getOperatorCommandSuggestionLines(
    inputValue,
    contentWidth,
    selectedCommandIndex,
  );
  const operatorInputDisplay = resolveOperatorInputDisplayMode({
    openQuestions,
    selection: selectedQuestion
      ? {
          id: selectedQuestion.id,
          index: openQuestionsLayout.selectedIndex,
          total: openQuestions.length,
        }
      : undefined,
    shuttingDown: snapshot.shuttingDown,
  });
  const isSlashInput = /^[\t ]*\//u.test(inputValue);
  const answerSuggestions =
    operatorInputDisplay.mode === 'withQuestions' &&
    !snapshot.shuttingDown &&
    !isSlashInput &&
    selectedQuestion?.id !== hiddenAnswerSuggestionQuestionId
      ? getOpenQuestionAnswerSuggestions(inputValue, selectedQuestion)
      : [];
  const answerSuggestionLines = getOpenQuestionAnswerSuggestionLines(
    answerSuggestions,
    contentWidth,
    selectedAnswerSuggestionIndex,
  );
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
    commandSuggestionLines.length + answerSuggestionLines.length,
  );
  const desiredInputPaneHeight = computeInputPaneHeight({
    hintLineCount,
    inputDisplayLineCount: visibleInputDisplayLineCount,
  });
  const openQuestionsPaneHeight =
    operatorInputDisplay.mode === 'withQuestions' ? openQuestionsLayout.paneHeight : 0;
  const workerPaneHeight = computeWorkerPaneHeight(
    Object.keys(snapshot.displayState.workers).length,
  );
  const streamPaneHeights = useMemo(
    () =>
      resolveStreamPaneHeights({
        terminalRows,
        workerPaneHeight,
        openQuestionsPaneHeight,
        inputPaneHeight: desiredInputPaneHeight,
      }),
    [terminalRows, workerPaneHeight, openQuestionsPaneHeight, desiredInputPaneHeight],
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
    setSelectedAnswerSuggestionIndex(0);
  }, [selectedQuestion?.id]);

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

    if (commandSuggestions.length > 0) {
      if (key.upArrow) {
        setSelectedCommandIndex((current) =>
          advanceOperatorCommandSelection(current, 'up', commandSuggestions.length),
        );
        return;
      }
      if (key.downArrow) {
        setSelectedCommandIndex((current) =>
          advanceOperatorCommandSelection(current, 'down', commandSuggestions.length),
        );
        return;
      }
    }

    if (answerSuggestions.length > 0) {
      if (key.upArrow) {
        setSelectedAnswerSuggestionIndex((current) =>
          advanceOpenQuestionAnswerSuggestionSelection(
            current,
            'up',
            answerSuggestions.length,
          ),
        );
        return;
      }
      if (key.downArrow) {
        setSelectedAnswerSuggestionIndex((current) =>
          advanceOpenQuestionAnswerSuggestionSelection(
            current,
            'down',
            answerSuggestions.length,
          ),
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

  const applyAnswerSuggestion = () => {
    const selectedSuggestion = answerSuggestions[selectedAnswerSuggestionIndex];
    if (!selectedQuestion || !selectedSuggestion) {
      return;
    }

    setInputValue(selectedSuggestion.value);
    setInputCursorPosition([0, selectedSuggestion.value.length]);
    setHiddenAnswerSuggestionQuestionId(selectedQuestion.id);
    setSelectedAnswerSuggestionIndex(0);
    setInputDisplayLineCount(1);
  };

  const handleSubmit = (value: string) => {
    if (snapshot.shuttingDown) {
      return;
    }

    if (answerSuggestions.length > 0) {
      applyAnswerSuggestion();
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
    setInputCursorPosition([0, 0]);
    setSelectedCommandIndex(0);
    setSelectedAnswerSuggestionIndex(0);
    setHiddenAnswerSuggestionQuestionId(undefined);
    setInputDisplayLineCount(1);
  };

  const handleInputChange = (value: string) => {
    setInputValue(value);
    setSelectedCommandIndex(0);
    setSelectedAnswerSuggestionIndex(0);
    setHiddenAnswerSuggestionQuestionId(undefined);
  };

  const handleSuggestionTab = (shift: boolean) => {
    if (shift) {
      return;
    }

    if (commandSuggestions.length > 0) {
      const selectedCommand = commandSuggestions[selectedCommandIndex];
      if (!selectedCommand) {
        return;
      }
      setInputValue(selectedCommand.name);
      setInputCursorPosition([0, selectedCommand.name.length]);
      setSelectedCommandIndex(0);
      return;
    }

    applyAnswerSuggestion();
  };

  return (
    <>
      <StaticActivityLog
        activityLog={snapshot.activityLog.slice(0, committedActivityCount)}
        contentWidth={activityLogContentWidth}
        replayGeneration={snapshot.activityLogGeneration}
        issueLinkMode={issueLinkMode}
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
            issueLinkMode={issueLinkMode}
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
          {commandSuggestionLines.map((line) => (
            <Text
              key={`operator-command-suggestion-${line.id}`}
              color={line.isSelected ? 'cyan' : INPUT_PANE_HINT_COLOR}
              bold={line.isSelected}
            >
              {line.text}
            </Text>
          ))}
          {answerSuggestionLines.map((line) => (
            <Text
              key={`open-question-answer-suggestion-${line.id}`}
              color={line.isSelected ? 'cyan' : INPUT_PANE_HINT_COLOR}
              bold={line.isSelected}
            >
              {line.text}
            </Text>
          ))}
          <OperatorTextArea
            value={inputValue}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            focus={!snapshot.shuttingDown}
            contentWidth={contentWidth}
            promptPrefix={operatorPrompt}
            maxDisplayLines={maxInputDisplayLines}
            onDisplayLineCountChange={handleDisplayLineCountChange}
            suggestionsActive={
              commandSuggestions.length > 0 || answerSuggestions.length > 0
            }
            onTab={
              commandSuggestions.length > 0 || answerSuggestions.length > 0
                ? handleSuggestionTab
                : undefined
            }
            cursorPosition={inputCursorPosition}
            onCursorChange={setInputCursorPosition}
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
