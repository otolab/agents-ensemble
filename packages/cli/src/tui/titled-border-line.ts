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
  right: string;
}

/**
 * 上枠線にタイトルを埋め込んだ行を組み立てる。
 * 形式: `╭─ Title ─────────────╮`（タイトル前後に隙間）。
 * suffix はタイトル直後に付与し、幅不足時は suffix から省略する。
 */
export function buildTitledTopBorderParts(params: {
  title: string;
  suffix?: string;
  totalWidth: number;
  borderStyle: TuiBorderStyle;
}): TitledTopBorderParts {
  const { title, borderStyle } = params;
  const suffix = params.suffix ?? '';
  const chars = getTuiBorderChars(borderStyle);
  const totalWidth = Math.max(4, params.totalWidth);

  const buildLine = (label: string): TitledTopBorderParts | null => {
    const left = `${chars.tl}${chars.h} `;
    const separator = ` ${chars.h}`;
    const labelWidth = stringWidth(label);
    const fixedWidth =
      stringWidth(left) + labelWidth + stringWidth(separator) + stringWidth(chars.tr);
    if (fixedWidth > totalWidth) {
      return null;
    }

    const fillCount = totalWidth - fixedWidth;
    const right = `${separator}${chars.h.repeat(Math.max(0, fillCount))}${chars.tr}`;
    return { left, title: label, right };
  };

  const fullLabel = `${title}${suffix}`;
  const full = buildLine(fullLabel);
  if (full) {
    return full;
  }

  if (suffix.length > 0) {
    for (let length = suffix.length; length > 0; length--) {
      const truncatedSuffix = `${suffix.slice(0, length - 1)}…`;
      const partial = buildLine(`${title}${truncatedSuffix}`);
      if (partial) {
        return partial;
      }
    }
  }

  for (let length = title.length; length > 0; length--) {
    const truncatedTitle = length < title.length ? `${title.slice(0, length - 1)}…` : title;
    const minimal = buildLine(truncatedTitle);
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
  totalWidth: number;
  borderStyle: TuiBorderStyle;
}): string {
  const parts = buildTitledTopBorderParts(params);
  return `${parts.left}${parts.title}${parts.right}`;
}
