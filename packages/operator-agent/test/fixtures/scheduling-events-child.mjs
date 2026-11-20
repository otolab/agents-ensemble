import { createOperatorDispatchQueue } from '../../dist/operator-dispatch.js';
import { createOperatorWatchPool } from '../../dist/operator-watch-pool.js';

const [root, producer] = process.argv.slice(2);
const pool = await createOperatorWatchPool({ userEnsembleRoot: root, profile: 'default', autoDiscoverSessions: false, dispatchQueue: createOperatorDispatchQueue() });
for (let index = 0; index < 24; index++) {
  pool.recordSchedulingEvent({ type: 'focus.set', ts: Date.now(), conductorAgentId: `${producer}-${index}` });
}
await pool.flushSchedulingEvents();
pool.close();
