import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveUserEnsembleRoot } from '@agents-ensemble/core/operator-runtime';
import {
  operatorAgentProfileDirectory,
  resolveOperatorAgentConfigScope,
} from '@agents-ensemble/operator-agent/config';

type Event = Record<string, unknown> & { type: string; ts: number };

export async function readSchedulingStats(options: { profile?: string; since?: string; until?: string; root?: string; configPath?: string }) {
  const userRoot = options.root ?? resolveUserEnsembleRoot();
  const configScope = await resolveOperatorAgentConfigScope(
    userRoot,
    options.configPath,
  );
  const operatorAgentsRoot = join(userRoot, 'operator-agents');
  const parseDate = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid date: ${value}`);
    return parsed;
  };
  const since = parseDate(options.since, -Infinity);
  const until = parseDate(options.until, Infinity);
  if (since >= until) throw new Error('--since must precede --until');
  if (options.profile && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.profile) || options.profile === '.' || options.profile === '..')) throw new Error('Invalid profile name');
  let profiles: string[];
  try {
    profiles = options.profile
      ? [options.profile]
      : (
          await readdir(
            configScope
              ? join(operatorAgentsRoot, '.config-scopes', configScope)
              : operatorAgentsRoot,
            { withFileTypes: true },
          )
        )
          .filter(
            (entry) =>
              entry.isDirectory() &&
              (configScope !== undefined || entry.name !== '.config-scopes'),
          )
          .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    profiles = [];
  }
  const all: Array<Event & { profile: string }> = [];
  let malformed = 0;
  for (const profile of profiles) {
    const profileDirectory = operatorAgentProfileDirectory(
      userRoot,
      profile,
      configScope,
    );
    for (const suffix of ['.1', '']) {
      let text: string;
      try { text = await readFile(join(profileDirectory, `scheduling-events.jsonl${suffix}`), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== 'object' || typeof (value as Event).type !== 'string' || typeof (value as Event).ts !== 'number' || !Number.isFinite((value as Event).ts)) throw new Error('invalid');
          all.push({ ...(value as Event), profile });
        } catch { malformed++; }
      }
    }
  }
  const window = all.filter((event) => event.ts >= since && event.ts < until);
  const key = (profile: string, id: unknown) => `${profile}\0${String(id)}`;
  let duplicates = 0;
  const indexById = (type: string, field: string) => {
    const result = new Map<string, Event & { profile: string }>();
    for (const event of all) {
      if (event.type !== type || typeof event[field] !== 'string') continue;
      const id = key(event.profile, event[field]);
      if (result.has(id)) { duplicates++; continue; }
      result.set(id, event);
    }
    return result;
  };
  const queued = indexById('report.queued', 'reportId');
  const committed = indexById('batch.committed', 'batchId');
  const deferred = new Map<string, number>();
  const hasInstance = (event: Event): event is Event & { schedulingInstanceId: string } =>
    typeof event.schedulingInstanceId === 'string' && event.schedulingInstanceId.length > 0;
  const focusKey = (profile: string, instance: string, reportId: string) => JSON.stringify([profile, instance, reportId]);
  for (const event of all) {
    if (event.type !== 'report.deferred_by_focus' || typeof event.reportId !== 'string' ||
        event.evidence !== 'selection_counterfactual' || !hasInstance(event)) continue;
    const id = focusKey(event.profile, event.schedulingInstanceId, event.reportId);
    deferred.set(id, Math.min(deferred.get(id) ?? Infinity, event.ts));
  }
  const sends = window.filter((e) => e.type === 'batch.sent');
  const reasons: Record<string, number> = {};
  const deadlines: Record<string, number> = {};
  const deliveries = { initial: 0, frozenReplay: 0, unknown: 0 };
  for (const event of sends) {
    if (event.deliveryKind === 'initial') deliveries.initial++;
    else if (event.deliveryKind === 'frozen_replay') deliveries.frozenReplay++;
    else deliveries.unknown++;
  }
  const uniqueBatches = new Set<string>();
  for (const event of committed.values()) {
    if (event.ts < since || event.ts >= until || typeof event.batchId !== 'string') continue;
    const id = key(event.profile, event.batchId);
    if (uniqueBatches.has(id)) continue;
    uniqueBatches.add(id);
    const reason = String(event.readyReason ?? 'unknown');
    const deadline = String(event.deadlineReason ?? 'unknown');
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    deadlines[deadline] = (deadlines[deadline] ?? 0) + 1;
  }
  const waits: Record<string, number[]> = {};
  const focusWaits: Record<string, number[]> = {};
  const focusPresenceWaits: Record<string, number[]> = {};
  let matched = 0, missing = 0, members = 0;
  for (const send of sends) {
    const batch = committed.get(key(send.profile, send.batchId));
    if (!batch || !Array.isArray(batch.reportIds)) { missing++; continue; }
    members += batch.reportIds.length;
    for (const id of batch.reportIds) {
      const report = queued.get(key(send.profile, id));
      if (!report || typeof report.firstQueuedAt !== 'number' || typeof send.startedAt !== 'number' || send.startedAt < report.firstQueuedAt) { missing++; continue; }
      matched++;
      const focusStatus = hasInstance(send) && typeof id === 'string' &&
        (deferred.get(focusKey(send.profile, send.schedulingInstanceId, id)) ?? Infinity) <= send.startedAt
        ? 'deferred' : 'unknown_deferred';
      const group = `${String(report.reportType ?? 'unknown')}/${focusStatus}`;
      const wait = send.startedAt - report.firstQueuedAt;
      (waits[group] ??= []).push(wait);
      const sendFocus = hasInstance(send) && (send.focusState === 'focused_session' || send.focusState === 'other_session' || send.focusState === 'off')
        ? send.focusState : 'unknown';
      const reportType = String(report.reportType ?? 'unknown');
      (focusWaits[`${reportType}/${sendFocus}`] ??= []).push(wait);
      const presence = sendFocus === 'focused_session' || sendFocus === 'other_session' ? 'on' : sendFocus;
      (focusPresenceWaits[`${reportType}/${presence}`] ??= []).push(wait);
    }
  }
  const percentiles = (groups: Record<string, number[]>) => Object.fromEntries(Object.entries(groups).map(([group, values]) => {
    values.sort((a, b) => a - b);
    const percentile = (p: number) => values[Math.ceil(values.length * p) - 1];
    return [group, { count: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: values.at(-1) }];
  }));
  const latency = percentiles(waits);
  const latencyByFocus = percentiles(focusWaits);
  const latencyByFocusPresence = percentiles(focusPresenceWaits);
  const clears = window.filter((e) => e.type === 'focus.clear');
  const timeout = clears.filter((e) => e.reason === 'timeout').length;
  const knownDeadline = (deadlines.cap ?? 0) + (deadlines.quiet ?? 0);
  const idle = window.filter((e) => e.type === 'report.queued' && e.reportType === 'idle_candidate');
  const evidenceDistribution: Record<string, number> = {};
  for (const event of idle) {
    const evidence = event.evidence;
    const group = evidence && typeof evidence === 'object'
      ? `${String((evidence as Record<string, unknown>).phase ?? 'unknown')}/${String((evidence as Record<string, unknown>).thresholdMs ?? 'unknown')}`
      : 'unknown/unknown';
    evidenceDistribution[group] = (evidenceDistribution[group] ?? 0) + 1;
  }
  return { profiles, since: options.since ?? null, until: options.until ?? null, queued: window.filter((e) => e.type === 'report.queued').length, sends: sends.length, deliveries, aggregationRate: sends.length ? members / sends.length : null, committedBatches: uniqueBatches.size, readyReasons: reasons, deadlineReasons: deadlines, capFraction: knownDeadline ? (deadlines.cap ?? 0) / knownDeadline : null, latency, latencyByFocus, latencyByFocusPresence, focus: { clears: clears.length, timeout, timeoutFraction: clears.length ? timeout / clears.length : null, deferred: window.filter((e) => e.type === 'report.deferred_by_focus' && e.evidence === 'selection_counterfactual' && hasInstance(e)).length, unverified: window.filter((e) => e.type === 'report.deferred_by_focus' && (e.evidence !== 'selection_counterfactual' || !hasInstance(e))).length }, idle: { count: idle.length, evidenceDistribution, evidence: idle.map((e) => e.evidence ?? null) }, correlation: { matched, missing, malformed, duplicates } };
}
