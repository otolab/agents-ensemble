import { Box, Text, type BoxProps } from 'ink';
import type { ReactNode } from 'react';
import {
  buildTitledTopBorderParts,
  type TuiBorderStyle,
} from './titled-border-line.js';

export interface TitledBorderPaneProps {
  title: string;
  titleSuffix?: string;
  borderStyle: TuiBorderStyle;
  borderColor?: BoxProps['borderColor'];
  height: number;
  /** 親ペインへネストするときの総幅。省略時は端末幅を使う。 */
  width?: number;
  paddingX?: number;
  titleBold?: boolean;
  children: ReactNode;
}

/** 上枠線にタイトルを埋め込んだ Ink ペイン。内側タイトル行は持たない。 */
export function TitledBorderPane({
  title,
  titleSuffix,
  borderStyle,
  borderColor,
  height,
  width,
  paddingX = 1,
  titleBold = true,
  children,
}: TitledBorderPaneProps) {
  const totalWidth = width ?? process.stdout.columns ?? 80;
  const parts = buildTitledTopBorderParts({
    title,
    suffix: titleSuffix,
    totalWidth,
    borderStyle,
  });
  const bodyHeight = Math.max(1, height - 1);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text>
        <Text color={borderColor}>{parts.left}</Text>
        {titleBold ? (
          <Text bold color={borderColor}>
            {parts.title}
          </Text>
        ) : (
          <Text color={borderColor}>{parts.title}</Text>
        )}
        <Text color={borderColor}>{parts.right}</Text>
      </Text>
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
