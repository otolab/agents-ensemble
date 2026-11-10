import { Text } from 'ink';
import { PANE_PADDING_X, ROUND_BORDER_WIDTH } from './tui-layout-constants.js';
import { TitledBorderPane } from './titled-border-pane.js';
import { getPaneContentWidth, wrapTextToWidth } from './wrap-text-to-width.js';
import type { OperatorRecoveryInspection } from '../operator-recovery-command.js';

export function buildRecoveryInspectionLines(
  inspection: OperatorRecoveryInspection,
  contentWidth: number,
): string[] {
  return inspection.text
    .split('\n')
    .flatMap((line) => wrapTextToWidth(line, Math.max(1, contentWidth)));
}

export function sliceRecoveryInspectionLines(
  lines: string[],
  visibleLineCount: number,
  linesFromBottom: number,
): string[] {
  if (visibleLineCount < 1 || lines.length === 0) {
    return [];
  }
  const maxOffset = Math.max(0, lines.length - visibleLineCount);
  const offset = Math.min(Math.max(0, linesFromBottom), maxOffset);
  const end = lines.length - offset;
  return lines.slice(Math.max(0, end - visibleLineCount), end);
}

export function RecoveryInspectionPane({
  inspection,
  height,
  terminalColumns,
  visibleLineCount,
  linesFromBottom,
}: {
  inspection: OperatorRecoveryInspection;
  height: number;
  terminalColumns: number;
  visibleLineCount: number;
  linesFromBottom: number;
}) {
  const contentWidth = getPaneContentWidth({
    columns: terminalColumns,
    paddingX: PANE_PADDING_X,
    borderWidth: ROUND_BORDER_WIDTH,
  });
  const lines = buildRecoveryInspectionLines(inspection, contentWidth);
  const visibleLines = sliceRecoveryInspectionLines(
    lines,
    visibleLineCount,
    linesFromBottom,
  );
  const hasMore = lines.length > visibleLineCount;

  return (
    <TitledBorderPane
      title={inspection.title}
      titleSuffix={`${hasMore ? 'PgUp/PgDn で確認 · ' : ''}Esc で閉じる`}
      borderStyle="round"
      borderColor="yellow"
      paddingX={PANE_PADDING_X}
      height={height}
      terminalColumns={terminalColumns}
      titleBold={false}
    >
      {visibleLines.map((line, index) => (
        <Text key={`recovery-line-${index}`}>{line || ' '}</Text>
      ))}
    </TitledBorderPane>
  );
}
