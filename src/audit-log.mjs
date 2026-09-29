import { readFile, rename, writeFile } from 'node:fs/promises';
import { ROUTE_EVENTS, ROUTE_SCOPES, ROUTE_REASON_TEXT } from './route-presentation.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir, loadSettings, validateThreadId, withDataLock } from './settings.mjs';

const REASON_CODES = new Set(['simple_task', 'standard_task', 'complex_reasoning', 'high_impact', 'uncertain', 'plan_required', 'execution_subtask', 'fallback', 'manual', 'explicit', 'disabled', 'unknown']);
for (const code of ['aborted', 'catalog_unavailable', 'timeout', 'missing_key', 'service_error', 'context_incomplete', 'judgment', 'capability_limited', 'attempt_limit', 'completion_unknown', 'failure_environment', 'failure_permission', 'failure_plan', 'failure_missing_information', 'failure_unknown', 'transient_retry', 'capability_upgrade', 'capability_ceiling']) REASON_CODES.add(code);
for (const code of Object.keys(ROUTE_REASON_TEXT)) REASON_CODES.add(code);
const TASK_KINDS = new Set(['routine', 'code', 'diagnostic', 'writing', 'research', 'architecture', 'review', 'unknown']);
const NEXT_ACTIONS = new Set(['execute', 'repair_environment', 'needs_context', 'replan', 'stop']);
const FEEDBACK = new Set(['too_weak', 'overkill']);

function filePath(dataDir) { return join(getDataDir(dataDir), 'routes.json'); }

function cleanTimestamp(value, now) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed <= now + 60000 ? new Date(parsed).toISOString() : new Date(now).toISOString();
}

/** Whitelists route metadata; prompt, context, arbitrary reasons and credentials are discarded. */
export function normalizeRouteRecord(record, { now = Date.now() } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('route record must be an object');
  const threadId = validateThreadId(record.threadId);
  const model = typeof record.model === 'string' && /^gpt-[a-z0-9][a-z0-9.-]{1,80}$/i.test(record.model) ? record.model : null;
  const effort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(record.effort) ? record.effort : null;
  if (!model || !effort) throw new TypeError('route record requires valid model and effort');
  const source = ['jev', 'fallback', 'manual', 'explicit', 'disabled', 'policy'].includes(record.source) ? record.source : 'fallback';
  const reasonCode = REASON_CODES.has(record.reasonCode) ? record.reasonCode : source === 'jev' ? 'unknown' : source;
  return {
    id: typeof record.id === 'string' && /^[a-f0-9-]{36}$/i.test(record.id) ? record.id : randomUUID(),
    timestamp: cleanTimestamp(record.timestamp, now),
    threadId,
    model,
    effort,
    reasonCode,
    ...(ROUTE_SCOPES.includes(record.routeScope) ? { routeScope: record.routeScope } : {}),
    ...(ROUTE_EVENTS.includes(record.selectionEvent) ? { selectionEvent: record.selectionEvent } : {}),
    ...(typeof record.sameConfiguration === 'boolean' ? { sameConfiguration: record.sameConfiguration } : {}),
    ...(['direct', 'planning', 'execution', 'review'].includes(record.phase) ? { phase: record.phase } : {}),
    source,
    fallback: source === 'fallback' || record.fallback === true,
    elapsedMs: Number.isFinite(record.elapsedMs) ? Math.max(0, Math.min(60000, Math.round(record.elapsedMs))) : 0,
    ...(typeof record.escalated === 'boolean' ? { escalated: record.escalated } : {}),
    ...(FEEDBACK.has(record.feedback) ? { feedback: record.feedback } : {}),
    ...(TASK_KINDS.has(record.taskKind) ? { taskKind: record.taskKind } : {}),
    ...(NEXT_ACTIONS.has(record.nextAction) ? { nextAction: record.nextAction } : {}),
    ...(record.policyVersion === '2.0' ? { policyVersion: record.policyVersion } : {}),
    ...(typeof record.contextComplete === 'boolean' ? { contextComplete: record.contextComplete } : {}),
    ...(typeof record.capabilityLimited === 'boolean' ? { capabilityLimited: record.capabilityLimited } : {})
  };
}

export function pruneRouteRecords(records, { now = Date.now(), retentionDays = 30 } = {}) {
  const cutoff = now - retentionDays * 86400000;
  return records.filter(record => Number.isFinite(Date.parse(record.timestamp)) && Date.parse(record.timestamp) >= cutoff && Date.parse(record.timestamp) <= now + 60000);
}

async function readRecords(dir) {
  try {
    const parsed = JSON.parse(await readFile(filePath(dir), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('routes.json must contain an array');
    return parsed.flatMap(item => {
      try { return [normalizeRouteRecord(item)]; }
      catch { return []; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function persist(records, dir) {
  const path = filePath(dir);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function appendRouteRecord(record, { dataDir } = {}) {
  const now = Date.now();
  const clean = normalizeRouteRecord(record, { now });
  return withDataLock(dataDir, async dir => {
    const { retentionDays } = await loadSettings({ dataDir: dir });
    const records = pruneRouteRecords(await readRecords(dir), { now, retentionDays });
    records.push(clean);
    await persist(records, dir);
    return clean;
  });
}

export async function listRecentRoutes({ limit = 20, threadId, dataDir } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be 1..100');
  if (threadId !== undefined) validateThreadId(threadId);
  return withDataLock(dataDir, async dir => {
    const { retentionDays } = await loadSettings({ dataDir: dir });
    const before = await readRecords(dir);
    const records = pruneRouteRecords(before, { retentionDays });
    await persist(records, dir);
    return records.filter(record => threadId === undefined || record.threadId === threadId).slice(-limit).reverse();
  });
}

export async function addRouteFeedback(recordId, feedback, { dataDir } = {}) {
  if (typeof recordId !== 'string' || !/^[a-f0-9-]{36}$/i.test(recordId)) throw new TypeError('recordId must be a route UUID');
  if (!FEEDBACK.has(feedback)) throw new TypeError('feedback must be too_weak or overkill');
  return withDataLock(dataDir, async dir => {
    const { retentionDays } = await loadSettings({ dataDir: dir });
    const records = pruneRouteRecords(await readRecords(dir), { retentionDays });
    const target = records.find(record => record.id === recordId);
    if (!target) throw new Error('route record not found');
    target.feedback = feedback;
    await persist(records, dir);
    return target;
  });
}
