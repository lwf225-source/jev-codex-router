#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listRecentRoutes } from '../src/audit-log.mjs';
import { updateSettings, updateThreadSettings, getThreadSettings } from '../src/settings.mjs';

const root = resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(join(tmpdir(), 'jev-controls-check-'));
await updateSettings({ enabled: true }, { dataDir });
const child = spawn(process.execPath, [join(root, 'bin', 'codex-jev-app-server.mjs'), 'app-server'], {
  cwd: root,
  env: { ...process.env, JEV_ROUTER_DATA_DIR: dataDir, JEV_ROUTER_DISABLE_NOTIFICATIONS: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
const completed = new Map();
let id = 1;
let threadId;
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 1000); });
createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (pending.has(message.id)) {
    const finish = pending.get(message.id);
    pending.delete(message.id);
    finish(message);
  }
  if (message.method === 'turn/completed') {
    const turn = message.params?.turn;
    const finish = completed.get(turn?.id);
    if (typeof finish === 'function') finish(turn);
    else if (turn?.id) completed.set(turn.id, turn);
  }
});

function rpc(method, params, timeoutMs = 15000) {
  return new Promise((resolveResult, rejectResult) => {
    const requestId = id++;
    const timeout = setTimeout(() => { pending.delete(requestId); rejectResult(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(requestId, (message) => {
      clearTimeout(timeout);
      if (message.error) rejectResult(new Error(`${method}: ${message.error.message || 'error'}`));
      else resolveResult(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
}

async function waitTurn(turnId) {
  return new Promise((resolveResult, rejectResult) => {
    const prior = completed.get(turnId);
    if (prior && typeof prior !== 'function') { resolveResult(prior); return; }
    const timeout = setTimeout(() => rejectResult(new Error('turn/completed timed out')), 90000);
    completed.set(turnId, (turn) => { clearTimeout(timeout); resolveResult(turn); });
  });
}

async function runCase(label, prompt, overrides = {}) {
  const started = await rpc('turn/start', {
    threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], ...overrides,
  }, 30000);
  const turnId = started?.turn?.id;
  if (!turnId) throw new Error(`${label}: missing turn id`);
  const finished = await waitTurn(turnId);
  const latest = (await listRecentRoutes({ threadId, dataDir })).at(0);
  const readback = (await rpc('thread/read', { threadId, includeTurns: false })).thread;
  return { label, status: finished?.status, model: readback?.model, effort: readback?.reasoningEffort, source: latest?.source, routeCount: (await listRecentRoutes({ threadId, dataDir, limit: 20 })).length };
}

try {
  await rpc('initialize', { clientInfo: { name: 'jev_controls_check', title: 'Jev Controls Check', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const start = await rpc('thread/start', { cwd: root, ephemeral: false, model: 'gpt-6-sol' });
  threadId = start?.thread?.id;
  if (!threadId) throw new Error('thread/start returned no id');
  const rows = [];
  rows.push(await runCase('auto', 'Reply with READY.', { model: 'gpt-6-sol', effort: 'medium' }));
  await rpc('thread/settings/update', { threadId, model: 'gpt-6-astra', effort: 'high' });
  const manualSettings = await getThreadSettings(threadId, { dataDir });
  rows.push(await runCase('manual', 'Reply with MANUAL.'));
  await updateThreadSettings(threadId, { mode: 'auto' }, { dataDir });
  rows.push(await runCase('auto-restored', 'Reply with AUTO.'));
  rows.push(await runCase('one-turn-override', '这次用 Astra，推理拉高。只回复 OVERRIDE。'));
  rows.push(await runCase('after-override', '只回复 RESET。'));
  await updateThreadSettings(threadId, { enabled: false }, { dataDir });
  rows.push(await runCase('task-disabled', 'Reply with DISABLED.', { model: 'gpt-6-sol', effort: 'medium' }));
  process.stdout.write(`${JSON.stringify({ threadId, manualModeDetected: manualSettings.mode === 'manual', rows })}\n`);
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  const passed = rows.every((row) => row.status === 'completed')
    && manualSettings.mode === 'manual'
    && byLabel.manual.model === 'gpt-6-astra' && byLabel.manual.effort === 'high'
    && byLabel['one-turn-override'].model === 'gpt-6-astra' && byLabel['one-turn-override'].effort === 'high'
    && ['jev', 'fallback'].includes(byLabel['after-override'].source) && byLabel['after-override'].model !== 'gpt-6-astra'
    && byLabel['task-disabled'].model === 'gpt-6-sol' && byLabel['task-disabled'].routeCount === byLabel['after-override'].routeCount;
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  if (stderr) process.stderr.write(`Native diagnostic: ${stderr.slice(0, 500)}\n`);
  process.exitCode = 1;
} finally {
  if (threadId && !child.killed) await rpc('thread/archive', { threadId }, 10000).catch(() => {});
  child.stdin.end();
  child.kill('SIGTERM');
  for (const finish of pending.values()) finish({ error: { message: 'check stopped' } });
  await rm(dataDir, { recursive: true, force: true });
}
