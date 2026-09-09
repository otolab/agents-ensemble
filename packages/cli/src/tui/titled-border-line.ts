import stringWidth from 'string-width';

export type TuiBorderStyle = 'round' | 'single';

export interface TuiBorderChars {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

export function getTuiBorderChars(style: TuiBorderStyle): TuiBorderChars {
  return style === 'round'
    ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
}

export interface TitledTopBorderParts {
  left: string;
  title: string;
  titleRight?: string;
  right: string;
}

/**
 * 上枠線にタイトルを埋め込んだ行を組み立てる。
 * 形式: `╭─ Title ─────────────╮`（タイトル前後に隙間）。
 * suffix はタイトル直後に付与し、titleRight は右寄せで閉じ角直前に配置する。
 * titleRightGap は右側ラベルと閉じ枠の間に追加する表示上の区切りである。
 * 幅不足時は titleRight → suffix → title の順で省略する。
 */
export function buildTitledTopBorderParts(params: {
  title: string;
  suffix?: string;
  titleRight?: string;
  titleRightGap?: string;
  totalWidth: number;
  borderStyle: TuiBorderStyle;
}): TitledTopBorderParts {
  const { title, borderStyle } = params;
  const suffix = params.suffix ?? '';
  const titleRight = params.titleRight ?? '';
  const titleRightGap = params.titleRightGap ?? '';
  const chars = getTuiBorderChars(borderStyle);
  const totalWidth = Math.max(4, params.totalWidth);

  const buildLine = (label: string, rightLabel: string): TitledTopBorderParts | null => {
    const left = `${chars.tl}${chars.h} `;
    const titleSeparator = ` ${chars.h}`;
    const rightSegment = rightLabel.length > 0 ? ` ${rightLabel}${titleRightGap}` : '';
    const closing = `${chars.h}${chars.tr}`;
    const fixedWidth =
      stringWidth(left) +
      stringWidth(label) +
      stringWidth(titleSeparator) +
      stringWidth(rightSegment) +
      stringWidth(closing);
    if (fixedWidth > totalWidth) {
      return null;
    }

    const fillCount = totalWidth - fixedWidth;
    const right = `${titleSeparator}${chars.h.repeat(Math.max(0, fillCount))}${rightSegment}${closing}`;
    return {
      left,
      title: label,
      titleRight: rightLabel.length > 0 ? rightLabel : undefined,
      right,
    };
  };

  const fullLabel = `${title}${suffix}`;
  const full = buildLine(fullLabel, titleRight);
  if (full) {
    return full;
  }

  if (titleRight.length > 0) {
    for (let length = titleRight.length; length > 0; length--) {
      const truncatedRight = length < titleRight.length ? `${titleRight.slice(0, length - 1)}…` : titleRight;
      const partial = buildLine(fullLabel, truncatedRight);
      if (partial) {
        return partial;
      }
    }
  }

  if (suffix.length > 0) {
    for (let length = suffix.length; length > 0; length--) {
      const truncatedSuffix = `${suffix.slice(0, length - 1)}…`;
      const partial = buildLine(`${title}${truncatedSuffix}`, titleRight);
      if (partial) {
        return partial;
      }
    }
  }

  for (let length = title.length; length > 0; length--) {
    const truncatedTitle = length < title.length ? `${title.slice(0, length - 1)}…` : title;
    const minimal = buildLine(truncatedTitle, titleRight);
    if (minimal) {
      return minimal;
    }
  }

  const left = chars.tl;
  const fillCount = Math.max(0, totalWidth - stringWidth(left) - stringWidth(chars.tr));
  return {
    left,
    title: '',
    right: `${chars.h.repeat(fillCount)}${chars.tr}`,
  };
}

export function buildTitledTopBorderLine(params: {
  title: string;
  suffix?: string;
  titleRight?: string;
  titleRightGap?: string;
  totalWidth: number;
  borderStyle: TuiBorderStyle;
}): string {
  const parts = buildTitledTopBorderParts(params);
  return `${parts.left}${parts.title}${parts.right}`;
}
