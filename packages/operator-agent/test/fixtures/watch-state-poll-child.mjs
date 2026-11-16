import { createOperatorDispatchQueue } from '../../dist/operator-dispatch.js';
import { createOperatorWatchPool } from '../../dist/operator-watch-pool.js';

const [userEnsembleRoot, conductorAgentId] = process.argv.slice(2);
if (!userEnsembleRoot || !conductorAgentId || !process.send) {
  throw new Error('userEnsembleRoot, conductorAgentId, and IPC are required');
}

let pool;
try {
  pool = await createOperatorWatchPool({
    userEnsembleRoot,
    dispatchQueue: createOperatorDispatchQueue(),
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
