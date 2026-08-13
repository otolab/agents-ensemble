import type { WorkerDisplayStatus } from './worker-display-state.js';
import type { WorkerLifecycleState } from './worker-lifecycle-state.js';

/** harness lifecycle 語彙を TUI / 表示 reducer 語彙へ変換する。 */
export function mapHarnessToDisplayStatus(
  lifecycle: WorkerLifecycleState,
): WorkerDisplayStatus {
  switch (lifecycle) {
    case 'attaching':
    case 'processing':
      return 'running';
    case 'idle':
      return 'idle';
    case 'failed':
      return 'failed';
    default: {
      const _exhaustive: never = lifecycle;
      return _exhaustive;
    }
  }
}
