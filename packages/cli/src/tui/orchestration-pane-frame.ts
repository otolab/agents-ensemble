import { MAIN_PANE_TITLE } from './tui-layout-constants.js';

export interface OrchestrationPaneFrameStats {
  innerRows: string[];
  logRows: string[];
  blankRows: string[];
  titleRows: string[];
}

/** Ink フレーム文字列から Orchestration ペイン内側の行を抽出する。 */
export function extractOrchestrationPaneFrameStats(frame: string): OrchestrationPaneFrameStats {
  const lines = frame.split('\n');
  const titleIndex = lines.findIndex(
    (line) => line.startsWith('│') && line.includes(MAIN_PANE_TITLE),
  );
  if (titleIndex < 0) {
    return { innerRows: [], logRows: [], blankRows: [], titleRows: [] };
  }

  const innerRows: string[] = [];
  for (let index = titleIndex; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.startsWith('╰')) {
      break;
    }
    if (line.startsWith('╭') && index > titleIndex) {
      break;
    }
    if (line.startsWith('│')) {
      innerRows.push(line);
    }
  }

  const titleRows = innerRows.filter((line) => line.includes(MAIN_PANE_TITLE));
  const logRows = innerRows.filter((line) =>
    /\[(?:operator|conductor|harness|observation)\]/.test(line),
  );
  const blankRows = innerRows.filter(
    (line) => line.startsWith('│') && line.replace(/│/g, '').trim().length === 0,
  );

  return { innerRows, logRows, blankRows, titleRows };
}
