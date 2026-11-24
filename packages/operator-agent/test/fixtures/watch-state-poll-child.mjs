import { createOperatorDispatchQueue } from '../../dist/dispatch/operator-dispatch.js';
import { createOperatorWatchPool } from '../../dist/watch/operator-watch-pool.js';

const [userEnsembleRoot, conductorAgentId, mode] = process.argv.slice(2);
if (!userEnsembleRoot || !conductorAgentId || !process.send) {
  throw new Error('userEnsembleRoot, conductorAgentId, and IPC are required');
}

let pool;
try {
  const dispatchQueue = createOperatorDispatchQueue();
  if (mode === 'crash-after-persist') {
    const crashBeforeQueueHandoff = () => {
      process.send({ type: 'persisted-before-enqueue' }, () => {
        process.exit(73);
      });
    };
    if (dispatchQueue.reconcileReports) {
      dispatchQueue.reconcileReports = (reports) => {
        if (reports.length > 0) crashBeforeQueueHandoff();
      };
    } else {
      const enqueueReports = dispatchQueue.enqueueReports.bind(dispatchQueue);
      dispatchQueue.enqueueReports = (events, debounceMs) => {
        if (events.length > 0) {
          crashBeforeQueueHandoff();
          return;
        }
        enqueueReports(events, debounceMs);
      };
    }
  }
  pool = await createOperatorWatchPool({
    userEnsembleRoot,
    dispatchQueue,
  });
  process.send({ type: 'ready' });
  process.on('message', async (message) => {
    if (!message || typeof message !== 'object' || message.type !== 'poll') {
      return;
    }
    try {
      const count = await pool.pollOnce(conductorAgentId);
      process.send({ type: 'done', count }, () => {
        pool.close();
        process.disconnect();
      });
    } catch (error) {
      process.send(
        {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
        () => {
          pool.close();
          process.disconnect();
          process.exitCode = 1;
        },
      );
    }
  });
} catch (error) {
  process.send(
    {
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    },
    () => process.disconnect(),
  );
  process.exitCode = 1;
}
