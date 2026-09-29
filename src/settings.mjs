import { mkdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRoutingPolicy } from './routing-policy.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  fallback: { model: 'gpt-6-sol', effort: 'medium' },
  timeoutMs: 2000,
  retentionDays: 30,
  threads: {}
});

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function getDataDir(dataDir) {
  return resolve(dataDir ?? process.env.JEV_ROUTER_DATA_DIR ?? join(homedir(), '.codex', 'jev-router'));
}

export function settingsPath(dataDir) {
  return join(getDataDir(dataDir), 'settings.json');
}

function validModel(value) {
  return typeof value === 'string' && /^gpt-[a-z0-9][a-z0-9.-]{1,80}$/i.test(value);
}

const validEffort = value => EFFORTS.has(value);

export function validateThreadId(threadId) {
  if (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > 256 || /[\x00-\x1f]/.test(threadId)) {
    throw new TypeError('threadId must be a nonempty string of at most 256 printable characters');
  }
  return threadId;
}

function validateModelEffort(pair, label) {
  if (!pair || typeof pair !== 'object' || Array.isArray(pair) || !validModel(pair.model) || !validEffort(pair.effort)) {
    throw new TypeError(`${label} must be {model, effort} with a Codex model and valid effort`);
  }
  return { model: pair.model, effort: pair.effort };
}

function parseGlobalPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['enabled', 'fallback', 'timeoutMs', 'routingPolicy'].includes(key))) {
    throw new TypeError('unknown global settings field');
  }
  const result = {};
  if ('routingPolicy' in patch) result.routingPolicy = validateRoutingPolicy(patch.routingPolicy);
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    result.enabled = patch.enabled;
  }
  if ('fallback' in patch) result.fallback = validateModelEffort(patch.fallback, 'fallback');
  if ('timeoutMs' in patch) {
    if (!Number.isInteger(patch.timeoutMs) || patch.timeoutMs < 100 || patch.timeoutMs > 10000) throw new TypeError('timeoutMs must be 100..10000');
    result.timeoutMs = patch.timeoutMs;
  }
  return result;
}

function parseThreadPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['enabled', 'mode', 'manualModel', 'manualEffort'].includes(key))) {
    throw new TypeError('unknown thread settings field');
  }
  const result = {};
  if ('enabled' in patch) {
    if (patch.enabled !== null && typeof patch.enabled !== 'boolean') throw new TypeError('thread enabled must be boolean or null');
    result.enabled = patch.enabled;
  }
  if ('mode' in patch) {
    if (patch.mode !== 'auto' && patch.mode !== 'manual') throw new TypeError('mode must be auto or manual');
    result.mode = patch.mode;
  }
  if ('manualModel' in patch) {
    if (!validModel(patch.manualModel)) throw new TypeError('manualModel must be a Codex model');
    result.manualModel = patch.manualModel;
  }
  if ('manualEffort' in patch) {
    if (!validEffort(patch.manualEffort)) throw new TypeError('manualEffort must be a valid effort');
    result.manualEffort = patch.manualEffort;
  }
  return result;
}

async function readSettings(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(dataDir), 'utf8'));
    const { threads: rawThreads, retentionDays: _oldRetentionDays, ...rawGlobal } = parsed;
    const global = parseGlobalPatch(rawGlobal);
    const threads = {};
    if (rawThreads && typeof rawThreads === 'object' && !Array.isArray(rawThreads)) {
      for (const [id, value] of Object.entries(rawThreads)) {
        validateThreadId(id);
        threads[id] = parseThreadPatch(value);
      }
    }
    return { ...structuredClone(DEFAULT_SETTINGS), ...global, threads };
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(DEFAULT_SETTINGS);
    throw error;
  }
}

export async function loadSettings({ dataDir } = {}) { return readSettings(dataDir); }

export async function withDataLock(dataDir, operation) {
  const dir = getDataDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.write-lock');
  const deadline = Date.now() + 3000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > 30000) await rm(lock, { recursive: true, force: true });
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      if (Date.now() > deadline) throw new Error('Jev router data is busy');
      await new Promise(done => setTimeout(done, 20));
    }
  }
  try { return await operation(dir); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function persist(settings, dir) {
  const path = settingsPath(dir);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function updateSettings(patch, { dataDir } = {}) {
  const validated = parseGlobalPatch(patch);
  return withDataLock(dataDir, async dir => {
    const next = { ...await readSettings(dir), ...validated };
    await persist(next, dir);
    return next;
  });
}

export async function updateThreadSettings(threadId, patch, { dataDir } = {}) {
  validateThreadId(threadId);
  const validated = parseThreadPatch(patch);
  return withDataLock(dataDir, async dir => {
    const current = await readSettings(dir);
    const thread = { ...current.threads[threadId], ...validated };
    if (thread.enabled === null) delete thread.enabled;
    if (thread.mode === 'manual' && (!thread.manualModel || !thread.manualEffort)) {
      throw new TypeError('manual mode requires manualModel and manualEffort');
    }
    if (Object.keys(thread).length) current.threads[threadId] = thread;
    else delete current.threads[threadId];
    await persist(current, dir);
    return effective(current, threadId);
  });
}

function effective(settings, threadId) {
  const thread = settings.threads[threadId] ?? {};
  const manual = thread.mode === 'manual';
  return {
    enabled: thread.enabled ?? settings.enabled,
    mode: thread.mode ?? 'auto',
    manualModel: manual ? thread.manualModel : null,
    manualEffort: manual ? thread.manualEffort : null,
    fallbackModel: settings.fallback.model,
    fallbackEffort: settings.fallback.effort,
    timeoutMs: settings.timeoutMs,
    retentionDays: settings.retentionDays,
    ...(settings.routingPolicy ? { routingPolicy: structuredClone(settings.routingPolicy) } : {})
  };
}

export async function getThreadSettings(threadId, { dataDir } = {}) {
  validateThreadId(threadId);
  return effective(await readSettings(dataDir), threadId);
}
