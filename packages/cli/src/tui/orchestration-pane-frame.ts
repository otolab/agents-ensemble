export interface TuiPaneFrameStats {
  innerRows: string[];
  contentRows: string[];
  blankRows: string[];
  titleOnBorder: boolean;
}

/** Ink フレーム文字列から指定タイトルを持つペイン内側の行を抽出する。 */
export function extractTuiPaneFrameStats(
  frame: string,
  titleMarker: string,
): TuiPaneFrameStats {
  const lines = frame.split('\n');
  const topBorderIndex = lines.findIndex(
    (line) =>
      (line.startsWith('╭') || line.startsWith('┌')) && line.includes(titleMarker),
  );
  if (topBorderIndex < 0) {
    return { innerRows: [], contentRows: [], blankRows: [], titleOnBorder: false };
  }

  const innerRows: string[] = [];
  for (let index = topBorderIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.startsWith('╰') || line.startsWith('└')) {
      break;
    }
    if ((line.startsWith('╭') || line.startsWith('┌')) && index > topBorderIndex) {
      break;
    }
    if (line.startsWith('│') || line.startsWith('┃')) {
      innerRows.push(line);
    }
  }

  const titleOnBorder = (lines[topBorderIndex] ?? '').includes(titleMarker);
  const titleRows = innerRows.filter((line) => line.includes(titleMarker));
  const contentRows = innerRows.filter((line) => !titleRows.includes(line));
  const blankRows = innerRows.filter(
    (line) => line.replace(/[│┃]/g, '').trim().length === 0,
  );

  return { innerRows, contentRows, blankRows, titleOnBorder };
}

/** @deprecated {@link extractTuiPaneFrameStats} を使用 */
export interface OrchestrationPaneFrameStats {
  innerRows: string[];
  logRows: string[];
  blankRows: string[];
  titleRows: string[];
}

/** @deprecated {@link extractTuiPaneFrameStats} を使用 */
export function extractOrchestrationPaneFrameStats(frame: string): OrchestrationPaneFrameStats {
  const stats = extractTuiPaneFrameStats(frame, 'Orchestration');
  const logRows = stats.contentRows.filter((line) =>
    /\[(?:operator|conductor|harness|observation)\]/.test(line),
  );
  const titleRows = stats.titleOnBorder ? [] : stats.innerRows.filter((line) => line.includes('Orchestration'));
  return {
    innerRows: stats.innerRows,
    logRows,
    blankRows: stats.blankRows,
    titleRows,
  };
}
