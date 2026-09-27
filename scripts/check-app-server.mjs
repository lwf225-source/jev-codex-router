#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { updateSettings } from '../src/settings.mjs';
import { listRecentRoutes } from '../src/audit-log.mjs';

const exerciseTurn = process.argv.includes('--turn');
const exerciseTwoTurns = process.argv.includes('--two-turns');
const exerciseQueue = process.argv.includes('--queue');
const useDesktopArgs = process.argv.includes('--desktop-args');
const useInstalledLauncher = process.argv.includes('--installed-launcher');
const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'jev-app-server-check-'));
let child;
let createdThreadId;
let queuedClientMessageId;
let nextId = 1;
const pending = new Map();
const notices = [];
const protocolEvents = [];

function rpc(method, params, timeoutMs = 10000) {
  return new Promise((resolveResult, rejectResult) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectResult(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) rejectResult(new Error(`${method}: ${message.error.message || 'unknown error'}`));
      else resolveResult(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

try {
  if (exerciseTurn || exerciseTwoTurns || exerciseQueue) await updateSettings({ enabled: true }, { dataDir: scratch });
  const cliArgs = useDesktopArgs
    ? ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true']
    : ['app-server'];
  const launcher = useInstalledLauncher ? join(homedir(), '.codex', 'jev-router', 'codex-app-server.sh') : process.execPath;
  const launchArgs = useInstalledLauncher ? cliArgs : [join(root, 'bin', 'codex-jev-app-server.mjs'), ...cliArgs];
  child = spawn(launcher, launchArgs, {
    cwd: root,
    env: { ...process.env, JEV_ROUTER_DATA_DIR: scratch, JEV_ROUTER_DISABLE_NOTIFICATIONS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 1000); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const completed = new Map();
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.hasOwn(message, 'id') && pending.has(message.id)) {
      const finish = pending.get(message.id);
      pending.delete(message.id);
      finish(message);
    } else if (message.method === 'warning') {
      notices.push(message.params?.message || '');
    } else if (message.method === 'turn/completed') {
      const turn = message.params?.turn;
      const listener = completed.get(turn?.id);
      if (typeof listener === 'function') listener(turn);
      else if (turn?.id) completed.set(turn.id, turn);
    }
    if (message.method?.startsWith('thread/queue/') || message.method === 'turn/started' || message.method === 'thread/settings/updated') {
      protocolEvents.push({ method: message.method, turnId: message.params?.turn?.id || null,
        ...(message.method === 'thread/settings/updated' ? { model: message.params?.threadSettings?.model, effort: message.params?.threadSettings?.effort } : {}) });
    }
  });

  await rpc('initialize', { clientInfo: { name: 'jev_router_check', title: 'Jev Router Check', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const listing = await rpc('model/list', { limit: 100, includeHidden: false }, 12000);
  const models = listing?.data || [];
  const summarized = models.map((model) => ({
    id: model.model || model.id,
    efforts: (model.supportedReasoningEfforts || []).map((entry) => entry.reasoningEffort || entry),
    modalities: model.inputModalities || null,
  }));
  process.stdout.write(`${JSON.stringify({ modelCount: summarized.length, models: summarized })}\n`);
  if (!exerciseTurn && !exerciseTwoTurns && !exerciseQueue) process.exitCode = summarized.length ? 0 : 1;
  else {
    const start = await rpc('thread/start', { ephemeral: !exerciseQueue, cwd: root, model: models.find((model) => /sol/i.test(model.model || model.id))?.model || models[0]?.model }, 20000);
    const threadId = start?.thread?.id;
    if (!threadId) throw new Error('thread/start returned no thread id');
    createdThreadId = threadId;
    const startTurn = async (prompt) => {
      const turn = await rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        model: models.find((model) => /sol/i.test(model.model || model.id))?.model || models[0]?.model,
        effort: 'medium',
      }, 30000);
      const turnId = turn?.turn?.id;
      if (!turnId) throw new Error('turn/start returned no turn id');
      return turnId;
    };
    const waitTurn = (turnId) => new Promise((resolveResult, rejectResult) => {
        const prior = completed.get(turnId);
        if (prior && typeof prior !== 'function') { resolveResult(prior); return; }
        const timer = setTimeout(() => rejectResult(new Error('turn/completed timed out')), 90000);
        completed.set(turnId, (value) => { clearTimeout(timer); resolveResult(value); });
      });
    const firstTurnId = await startTurn(exerciseQueue ? 'Reply with three short numbered lines and then OK.' : 'Reply with the single word OK.');
    const finished = [];
    if (exerciseQueue) {
      queuedClientMessageId = `jev-check-${Date.now()}`;
      const added = await rpc('thread/queue/add', { threadId, input: [{ type: 'text', text: 'Continue the same task by replying with the single word QUEUED.', text_elements: [] }], clientUserMessageId: queuedClientMessageId }, 10000);
      const queuedSubmissionId = added?.queuedSubmission?.id;
      if (!queuedSubmissionId) throw new Error('thread/queue/add returned no submission id');
      const pending = await rpc('thread/queue/list', { threadId, limit: 20 }, 10000);
      protocolEvents.push({ method: 'queue/list-result', queuedCount: pending?.data?.length ?? null });
      finished.push(await waitTurn(firstTurnId));
      const secondTurnId = await new Promise((resolveResult, rejectResult) => {
        const deadline = Date.now() + 15000;
        const poll = () => {
          const started = protocolEvents.find((event) => event.method === 'turn/started' && event.turnId && event.turnId !== firstTurnId);
          if (started) resolveResult(started.turnId);
          else if (Date.now() >= deadline) rejectResult(new Error(`queued submission ${queuedSubmissionId} was not automatically started`));
          else setTimeout(poll, 20);
        };
        poll();
      });
      finished.push(await waitTurn(secondTurnId));
      const queueAfter = await rpc('thread/queue/list', { threadId, limit: 20 }, 10000);
      protocolEvents.push({ method: 'queue/list-after', queuedCount: queueAfter?.data?.length ?? null });
    } else finished.push(await waitTurn(firstTurnId));
    if (exerciseTwoTurns) finished.push(await waitTurn(await startTurn('Continue the same task by replying with the single word DONE.')));
    const routes = await listRecentRoutes({ threadId, dataDir: scratch });
    const readback = await rpc('thread/read', { threadId, includeTurns: false }, 10000);
    const history = exerciseQueue ? await rpc('thread/read', { threadId, includeTurns: true }, 10000) : null;
    const historyClientIds = (history?.thread?.turns || []).flatMap((turn) => (turn.items || []).filter((item) => item.type === 'userMessage').map((item) => item.clientId));
    const queuedClientIdInHistory = exerciseQueue ? historyClientIds.includes(queuedClientMessageId) : null;
    process.stdout.write(`${JSON.stringify({ turnStatuses: finished.map((turn) => turn?.status), configuredModel: readback?.thread?.model, configuredEffort: readback?.thread?.reasoningEffort, queuedClientIdInHistory, routes, notices, protocolEvents })}\n`);
    const queueCleared = !exerciseQueue || protocolEvents.some((event) => event.method === 'queue/list-after' && event.queuedCount === 0);
    process.exitCode = finished.every((turn) => turn?.status === 'completed') && routes.length === finished.length && queueCleared && queuedClientIdInHistory !== false && readback?.thread?.model === routes[0]?.model && readback?.thread?.reasoningEffort === routes[0]?.effort ? 0 : 1;
  }
  if (stderr && process.exitCode) process.stderr.write(`Native app-server diagnostic: ${stderr.slice(0, 500)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  if (exerciseQueue) process.stderr.write(`${JSON.stringify({ protocolEvents })}\n`);
  process.exitCode = 1;
} finally {
  if (exerciseQueue && createdThreadId && child && !child.killed) {
    await rpc('thread/archive', { threadId: createdThreadId }, 10000).catch(() => {});
  }
  if (child) {
    child.stdin.end();
    if (!child.killed) child.kill('SIGTERM');
  }
  for (const finish of pending.values()) finish({ error: { message: 'app-server stopped' } });
  await rm(scratch, { recursive: true, force: true });
}
