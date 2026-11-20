import { createOperatorDispatchQueue } from '@agents-ensemble/operator-agent';

const [id, weight, focus] = process.argv.slice(2);
const events = [];
const now = 100;
const clock = { now: () => now, setTimeout, clearTimeout };
const queue = createOperatorDispatchQueue({
  batchMaxWaitMs: 1000, idleAgingMs: 1000, focusInactivityTimeoutMs: 10000,
  pushThreshold: 10, reportWeights: { session_state: Number(weight), open_question: 10, conductor_message: 5, idle_candidate: 1 },
}, clock, (event) => events.push(event));
queue.enqueueReport({ type: 'report', reportType: 'session_state', reportId: id, conductorAgentId: id, issueUrl: 'https://example.com/1', text: 'secret' }, 0);
events.push({ type: 'report.queued', ts: now, reportId: id, reportType: 'session_state', firstQueuedAt: now });
if (focus === 'yes') queue.setFocus(id, now);
queue.selectBatch({ continuationConsumed: false }, now);
queue.requestReports(id);
const batch = queue.selectBatch({ continuationConsumed: false }, now);
if (!batch) throw new Error('expected requested batch');
queue.commitBatch(batch);
events.push({ type: 'batch.committed', ts: now, batchId: id, reportIds: [id] });
events.push({ type: 'batch.sent', ts: now, batchId: id, startedAt: now });
process.stdout.write(JSON.stringify(events));
