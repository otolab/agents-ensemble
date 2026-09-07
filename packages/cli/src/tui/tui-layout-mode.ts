export type TuiLayoutMode = 'pane' | 'stream';

export const TUI_LAYOUT_ENV = 'ENSEMBLE_TUI_LAYOUT';

/**
 * Resolve the TUI layout without allowing stream mode to affect non-TTY output.
 * Unknown values intentionally keep the existing pane layout.
 */
export function resolveTuiLayoutMode(options: {
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
} = {}): TuiLayoutMode {
  if (options.isTty === false) {
    return 'pane';
  }

  const env = options.env ?? process.env;
  return env[TUI_LAYOUT_ENV] === 'stream' ? 'stream' : 'pane';
}
