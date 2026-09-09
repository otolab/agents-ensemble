import { Box, Text, type BoxProps } from 'ink';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';
import {
  formatIssueReference,
  formatOsc8Link,
  type IssueLinkMode,
} from './format-operator-context.js';
import {
  buildTitledTopBorderParts,
  type TuiBorderStyle,
} from './titled-border-line.js';

export interface TitledBorderPaneProps {
  title: string;
  titleSuffix?: string;
  titleRight?: string;
  titleRightIssueUrl?: string;
  titleRightLinkMode?: IssueLinkMode;
  borderStyle: TuiBorderStyle;
  borderColor?: BoxProps['borderColor'];
  height: number;
  paddingX?: number;
  titleBold?: boolean;
  children: ReactNode;
}

function renderTitleRight(params: {
  titleRight?: string;
  titleRightIssueUrl?: string;
  titleRightLinkMode?: IssueLinkMode;
  borderColor?: BoxProps['borderColor'];
}): ReactNode {
  const { titleRight, titleRightIssueUrl, titleRightLinkMode, borderColor } = params;
  if (!titleRight) {
    return null;
  }

  if (titleRightIssueUrl && titleRightLinkMode === 'osc8') {
    return <Text>{formatOsc8Link(titleRight, titleRightIssueUrl)}</Text>;
  }

  return <Text color={borderColor}>{titleRight}</Text>;
}

/** 上枠線にタイトルを埋め込んだ Ink ペイン。内側タイトル行は持たない。 */
export function TitledBorderPane({
  title,
  titleSuffix,
  titleRight,
  titleRightIssueUrl,
  titleRightLinkMode = 'label',
  borderStyle,
  borderColor,
  height,
  paddingX = 1,
  titleBold = true,
  children,
}: TitledBorderPaneProps) {
  const totalWidth = process.stdout.columns ?? 80;
  const titleRightText =
    titleRightIssueUrl && titleRightLinkMode === 'url'
      ? formatIssueReference(titleRightIssueUrl, 'url')
      : titleRight;
  const parts = buildTitledTopBorderParts({
    title,
    suffix: titleSuffix,
    titleRight: titleRightText,
    titleRightGap:
      titleRightIssueUrl && titleRightLinkMode === 'url' ? ' ' : undefined,
    preserveTitleRight: Boolean(titleRightIssueUrl && titleRightLinkMode === 'url'),
    totalWidth,
    borderStyle,
  });
  const bodyHeight = Math.max(1, height - 1);
  const titleRightPrefix = parts.titleRight ? ` ${parts.titleRight}` : '';
  const titleRightIndex = titleRightPrefix.length > 0 ? parts.right.lastIndexOf(titleRightPrefix) : -1;
  const rightBeforeTitleRight =
    titleRightIndex >= 0 ? parts.right.slice(0, titleRightIndex + 1) : parts.right;
  const rightAfterTitleRight =
    titleRightIndex >= 0 ? parts.right.slice(titleRightIndex + titleRightPrefix.length) : '';
  const topBorderLine = `${parts.left}${parts.title}${parts.right}`;
  const preserveUrlFallback = Boolean(titleRightIssueUrl && titleRightLinkMode === 'url');

  return (
    <Box flexDirection="column" height={height} overflowX="visible" overflowY="hidden">
      {/*
       * Keep the linked label and the surrounding border in sibling Text nodes.
       * Ink re-serializes ANSI text per cell; when the OSC 8 close sequence and
       * the following border share one Text node, the close can be carried to
       * the border cells and emitted again at the end of the line.
      */}
      <Box flexDirection="row" overflow="visible">
        {preserveUrlFallback ? (
          <Box flexShrink={0} width={stringWidth(topBorderLine)} overflow="visible">
            <Text color={borderColor}>{topBorderLine}</Text>
          </Box>
        ) : (
          <>
            <Text color={borderColor}>{parts.left}</Text>
            {titleBold ? (
              <Text bold color={borderColor}>
                {parts.title}
              </Text>
            ) : (
              <Text color={borderColor}>{parts.title}</Text>
            )}
            <Text color={borderColor}>{rightBeforeTitleRight}</Text>
            {renderTitleRight({
              titleRight: parts.titleRight,
              titleRightIssueUrl,
              titleRightLinkMode,
              borderColor,
            })}
            <Text color={borderColor}>{rightAfterTitleRight}</Text>
          </>
        )}
      </Box>
      <Box
        flexGrow={1}
        flexDirection="column"
        borderStyle={borderStyle}
        borderTop={false}
        borderColor={borderColor}
        paddingX={paddingX}
        height={bodyHeight}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}
