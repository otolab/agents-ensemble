import { INPUT_PANE_BORDER_ROWS } from './tui-layout-constants.js';

/** Fit the content actually rendered inside the allocated input pane. */
export function resolveInputContentLayout(input: {
  paneHeight: number;
  inputLines: number;
  hasQueue: boolean;
  desiredQueueRows: number;
  hintLines: number;
  suggestionLines: number;
}) {
  const available = Math.max(1, input.paneHeight - INPUT_PANE_BORDER_ROWS);
  const reservedQueue = input.hasQueue && available > 1 ? 1 : 0;
  const reservedSuggestion = input.suggestionLines > 0 && available > 1 + reservedQueue ? 1 : 0;
  const inputLines = Math.max(1, Math.min(input.inputLines, available - reservedQueue - reservedSuggestion));
  let remaining = Math.max(0, available - inputLines);
  const queueRows = Math.min(input.desiredQueueRows, Math.max(0, remaining - reservedSuggestion));
  remaining -= queueRows;
  const suggestionLines = Math.min(input.suggestionLines, remaining);
  remaining -= suggestionLines;
  const hintLines = Math.min(input.hintLines, remaining);
  return { inputLines, queueRows, suggestionLines, hintLines };
}
