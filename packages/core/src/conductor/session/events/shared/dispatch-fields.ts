import type { DispatchMode } from '../../dispatch-mode.js';

/** SessionEvent に載せうる dispatch モード（#148）。既定は trigger。 */
export interface SessionEventDispatchFields {
  dispatchMode?: DispatchMode;
}
