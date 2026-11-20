import { randomUUID } from 'node:crypto';
import { createOperatorDispatchQueue } from '@agents-ensemble/operator-agent';

const [id, weight, focus, reportId = id] = process.argv.slice(2);
const schedulingInstanceId = randomUUID();
const events = [];
const now = 100;
const clock = { now: () => now, setTimeout, clearTimeout };
const queue = createOperatorDispatchQueue({
  batchMaxWaitMs: 1000, idleAgingMs: 1000, focusInactivityTimeoutMs: 10000,
  pushThreshold: 10, reportWeights: { session_state: Number(weight), open_question: 10, conductor_message: 5, idle_candidate: 1 },
}, clock, (event) => events.push({ ...event, schedulingInstanceId }));
queue.enqueueReport({ type: 'report', reportType: 'session_state', reportId, conductorAgentId: reportId, issueUrl: 'https://example.com/1', text: 'secret' }, 0);
events.push({ type: 'report.queued', ts: now, reportId, reportType: 'session_state', firstQueuedAt: now });
if (focus === 'yes') queue.setFocus(reportId, now);
queue.selectBatch({ continuationConsumed: false }, now);
queue.requestReports(reportId);
const batch = queue.selectBatch({ continuationConsumed: false }, now);
if (!batch) throw new Error('expected requested batch');
queue.commitBatch(batch);
events.push({ type: 'batch.committed', ts: now, batchId: id, reportIds: [reportId] });
events.push({ type: 'batch.sent', ts: now, batchId: id, startedAt: now, schedulingInstanceId });
process.stdout.write(JSON.stringify(events));
