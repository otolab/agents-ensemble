import {
  resolveTuiLayoutSetting,
  TUI_LAYOUT_ENV,
  type EnsembleConfig,
  type TuiLayoutMode,
} from '@agents-ensemble/core';

export type { TuiLayoutMode };
export { TUI_LAYOUT_ENV };

/**
 * Resolve the TUI layout without allowing stream mode to affect non-TTY output.
 * Unknown env values intentionally keep the existing pane layout.
 */
export function resolveTuiLayoutMode(
  options: {
    env?: NodeJS.ProcessEnv;
    config?: EnsembleConfig;
    isTty?: boolean;
  } = {},
): TuiLayoutMode {
  if (options.isTty === false) {
    return 'pane';
  }

  return resolveTuiLayoutSetting({
    env: options.env ?? process.env,
    config: options.config,
  });
}
