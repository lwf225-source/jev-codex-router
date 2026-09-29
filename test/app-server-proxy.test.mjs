import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServerProxy } from '../src/app-server-proxy.mjs';
import { createQueuedStore } from '../src/queued-submissions.mjs';
import { chooseRoute } from '../src/route-core.mjs';

const catalog = [
  { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
  { id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
  { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] },
];

async function until(predicate, timeoutMs = 1500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for app-server proxy message');
}

function harness({ route, settings, record, setThreadSettings, credential, announce, diagnostic, serverDelay = {}, dataDir, internalStartTimeoutMs } = {}) {
  const ownedDataDir = !dataDir;
  dataDir ??= mkdtempSync(join(tmpdir(), 'jev-proxy-test-'));
  const clientInput = new PassThrough();
  const clientOutput = new PassThrough();
  const child = { stdin: new PassThrough(), stdout: new PassThrough() };
  const upstream = [];
  const downstream = [];
  const queue = createQueuedStore({ dataDir });
  const threadRuntime = new Map();
  const nativeHistory = new Map();
  const childReader = createInterface({ input: child.stdin });
  const clientReader = createInterface({ input: clientOutput });
  childReader.on('line', (line) => {
    const message = JSON.parse(line);
    upstream.push(message);
    if (message.method === 'model/list') {
      const reply = () => child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: serverDelay.catalog || catalog, nextCursor: null } })}\n`);
      if (serverDelay.modelList !== Infinity) setTimeout(reply, serverDelay.modelList || 0);
    }
    if (message.method === 'thread/read') {
      if (serverDelay.read !== Infinity) setTimeout(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, turns: nativeHistory.get(message.params.threadId) || [] } } })}\n`), serverDelay.read || 0);
    }
    if (message.method === 'thread/resume') {
      const runtime = serverDelay.resumeSettings || { model: 'gpt-6-sol', reasoningEffort: 'medium', collaborationMode: null };
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, status: { type: serverDelay.resumeStatus || 'idle' }, turns: [{ id: 'old-turn', status: 'completed' }] }, ...runtime } })}\n`);
    }
    if (message.method === 'turn/start' && !serverDelay.turnStartFailure) {
      if (serverDelay.turnStartMode === 'started-no-response') {
        const turn = { id: `turn-${message.id}`, status: 'inProgress', items: [{ type: 'userMessage', id: `item-${message.id}`, clientId: message.params.clientUserMessageId, content: message.params.input }] };
        nativeHistory.set(message.params.threadId, [...(nativeHistory.get(message.params.threadId) || []), turn]);
        child.stdout.write(`${JSON.stringify({ method: 'item/started', params: { threadId: message.params.threadId, item: turn.items[0] } })}\n`);
      } else if (serverDelay.turnStartMode !== 'unknown-no-response') {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: `turn-${message.id}`, status: 'inProgress', items: [] } } })}\n`);
      }
    }
    if (message.method === 'turn/start' && serverDelay.turnStartFailure) {
      child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'native start rejected' } })}\n`);
    }
    if (message.method === 'thread/queue/add') {
      const item = { id: `queued-${message.id}`, input: message.params.input, clientUserMessageId: message.params.clientUserMessageId };
      queue.set(item.id, item);
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { queuedSubmission: item } })}\n`);
    }
    if (message.method === 'thread/queue/update') {
      queue.set(message.params.queuedSubmissionId, { ...queue.get(message.params.queuedSubmissionId), input: message.params.input });
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === 'thread/queue/delete') {
      queue.delete(message.params.queuedSubmissionId);
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === 'thread/queue/list') {
      const reply = () => child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [...queue.values()], nextCursor: null } })}\n`);
      if (serverDelay.queueList !== Infinity) setTimeout(reply, serverDelay.queueList || 0);
    }
    if (message.method === 'thread/settings/update') {
      threadRuntime.set(message.params.threadId, message.params);
      const reply = () => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      if (serverDelay.settingsUpdate !== Infinity) setTimeout(reply, serverDelay.settingsUpdate || 0);
    }
  });
  clientReader.on('line', (line) => downstream.push(JSON.parse(line)));
  const proxy = createAppServerProxy({
    child, clientInput, clientOutput, dataDir, queueStore: queue, internalStartTimeoutMs,
    route: route || (async () => ({ model: 'gpt-6-luna', effort: 'low', source: 'jev', reason: 'Jev 判断：任务简单且要求明确' })),
    credential: credential || (async () => 'test-only-key'),
    threadSettings: settings || (async () => ({ enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 500 })),
    setThreadSettings: setThreadSettings || (async (_id, patch) => ({ enabled: true, ...patch, fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 500 })),
    record: record || (async () => {}),
    announce: announce || (() => {}),
    diagnostic: diagnostic || (() => {}),
  });
  const send = (message) => clientInput.write(`${JSON.stringify(message)}\n`);
  const ready = async () => { send({ method: 'initialized' }); await until(() => proxy.models.length === 3); };
  const stop = () => { proxy.close(); clientInput.end(); child.stdout.end(); child.stdin.end(); clientOutput.end(); childReader.close(); clientReader.close(); if (ownedDataDir) rmSync(dataDir, { recursive: true, force: true }); };
  return { send, ready, stop, proxy, upstream, downstream, child, queue, threadRuntime, nativeHistory, dataDir };
}

test('routes each new user turn, keeps context, and passes steering through unchanged', async (t) => {
  const contexts = [];
  const records = [];
  const pickerPatches = [];
  const h = harness({
    route: async ({ context }) => { contexts.push(context); return { model: 'gpt-6-luna', effort: 'low', source: 'jev', reason: 'Jev 判断：任务简单且要求明确' }; },
    record: async (entry) => { records.push(entry); },
    setThreadSettings: async (_id, patch) => { pickerPatches.push(patch); return { enabled: true, ...patch, fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 500 }; },
  });
  t.after(h.stop);
  await h.ready();
  h.send({ id: 10, method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Rename a variable.' }], model: 'gpt-6-sol', effort: 'medium' } });
  await until(() => h.upstream.some((m) => m.id === 10));
  const first = h.upstream.find((m) => m.id === 10);
  assert.equal(first.params.model, 'gpt-6-luna');
  assert.equal(first.params.effort, 'low');
  assert.deepEqual(first.params.input, [{ type: 'text', text: 'Rename a variable.' }]);
  await until(() => records.length === 1);
  h.send({ id: 11, method: 'turn/steer', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Also update its comment.' }], expectedTurnId: 'turn-1' } });
  await until(() => h.upstream.some((m) => m.id === 11));
  assert.equal(h.upstream.find((m) => m.id === 11).params.model, undefined);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })}\n`);
  await until(() => h.downstream.some((m) => m.method === 'turn/completed'));
  h.send({ id: 12, method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Continue.' }], model: 'gpt-6-sol', effort: 'medium' } });
  await until(() => h.upstream.some((m) => m.id === 12));
  await until(() => records.length === 3);
  assert.equal(contexts.length, 2);
  assert.match(contexts[1].summary, /Rename a variable/);
  assert.equal(records.length, 3);
  assert.equal(records[1].selectionEvent, 'retained');
  assert.equal(records[1].source, 'policy');
  assert.equal(pickerPatches.length, 0);
  assert.equal(records[0].reasonCode, 'simple_task');
  assert.ok(!('prompt' in records[0]));
  assert.ok(!h.downstream.some((m) => m.method === 'warning'));
});

test('a picker change enters persistent manual mode', async (t) => {
  let manual = false;
  const patches = [];
  const h = harness({
    route: async ({ settings }) => settings.manualModel
      ? { model: settings.manualModel, effort: settings.manualEffort, source: 'manual', reason: '持续手动选择的模型' }
      : { model: 'gpt-6-luna', effort: 'low', source: 'jev', reason: 'Jev 判断：任务简单且要求明确' },
    settings: async () => ({ enabled: true, mode: manual ? 'manual' : 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 500 }),
    setThreadSettings: async (_id, patch) => { manual = true; patches.push(patch); return { enabled: true, ...patch, fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 500 }; },
  });
  t.after(h.stop);
  await h.ready();
  h.send({ id: 20, method: 'turn/start', params: { threadId: 'thread-2', input: [{ type: 'text', text: 'Fix a typo.' }], model: 'gpt-6-sol', effort: 'medium' } });
  await until(() => h.upstream.some((m) => m.id === 20));
  await until(() => h.proxy.contexts.get('thread-2')?.lastApplied);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-2', turn: { id: 'turn-20', status: 'completed' } } })}\n`);
  await until(() => h.downstream.some((m) => m.method === 'turn/completed'));
  h.send({ id: 21, method: 'turn/start', params: { threadId: 'thread-2', input: [{ type: 'text', text: 'Review the patch.' }], model: 'gpt-6-astra', effort: 'high' } });
  await until(() => h.upstream.some((m) => m.id === 21));
  assert.equal(patches[0].mode, 'manual');
  assert.equal(patches[0].manualModel, 'gpt-6-astra');
  assert.equal(h.upstream.find((m) => m.id === 21).params.model, 'gpt-6-astra');
});

test('a timed-out unfamiliar task uses quality-first strong planning', async (t) => {
  const records = [];
  const h = harness({
    route: async () => new Promise(() => {}),
    settings: async () => ({ enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 100 }),
    record: async (entry) => { records.push(entry); },
  });
  t.after(h.stop);
  await h.ready();
  h.send({ id: 30, method: 'turn/start', params: { threadId: 'thread-3', input: [{ type: 'text', text: 'Investigate a bug.' }], model: 'gpt-6-astra', effort: 'high' } });
  await until(() => h.upstream.some((m) => m.id === 30));
  assert.equal(h.upstream.find((m) => m.id === 30).params.model, 'gpt-6-astra');
  assert.equal(h.upstream.find((m) => m.id === 30).params.effort, 'high');
  await until(() => records.length === 1);
  assert.equal(records[0].source, 'fallback');
  assert.equal(records[0].reasonCode, 'timeout');
});

test('native completion starts the final edited queue input with a routed model', async (t) => {
  const seen = []; const records = []; const notices = [];
  const h = harness({ route: async ({ prompt }) => { seen.push(prompt); return { model: 'gpt-6-astra', effort: 'xhigh', source: 'jev', reason: '多步深入推理' }; },
    record: async entry => records.push(entry), announce: entry => notices.push(entry) });
  t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-q', turn: { id: 'first' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/started'));
  h.send({ id: 40, method: 'thread/queue/add', params: { threadId: 'thread-q', input: [{ type: 'text', text: 'old prompt', text_elements: [] }], clientUserMessageId: 'client-1' } });
  await until(() => h.downstream.some(m => m.id === 40));
  const id = h.downstream.find(m => m.id === 40).result.queuedSubmission.id;
  assert.equal(h.upstream.filter(m => m.method === 'thread/queue/add').length, 0);
  h.send({ id: 41, method: 'thread/queue/update', params: { threadId: 'thread-q', queuedSubmissionId: id, input: [{ type: 'text', text: 'new complex prompt', text_elements: [] }] } });
  await until(() => h.downstream.some(m => m.id === 41));
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-q', turn: { id: 'first', status: 'completed' } } })}\n`);
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-1'));
  const internal = h.upstream.find(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-1');
  assert.equal(internal.params.input[0].text, 'new complex prompt');
  assert.equal(internal.params.model, 'gpt-6-astra');
  assert.equal(internal.params.effort, 'xhigh');
  assert.deepEqual(seen, ['new complex prompt']);
  await until(() => records.length === 1 && notices.length === 1);
  assert.equal(await h.queue.peek('thread-q'), null);
  assert.ok(h.downstream.findIndex(m => m.method === 'turn/completed') < h.downstream.findLastIndex(m => m.method === 'thread/queue/changed'));
});

test('an edit during Jev judgment is routed again before queue launch', async (t) => {
  let releaseFirst;
  const firstDecision = new Promise(resolve => { releaseFirst = resolve; });
  const seen = [];
  const h = harness({ route: async ({ prompt }) => {
    seen.push(prompt);
    if (seen.length === 1) await firstDecision;
    return { model: 'gpt-6-astra', effort: 'high', source: 'jev', reason: 'complex' };
  } });
  t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-edit-race', turn: { id: 'first' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/started'));
  h.send({ id: 45, method: 'thread/queue/add', params: { threadId: 'thread-edit-race', input: [{ type: 'text', text: 'before', text_elements: [] }], clientUserMessageId: 'client-45' } });
  await until(() => h.downstream.some(m => m.id === 45));
  const id = h.downstream.find(m => m.id === 45).result.queuedSubmission.id;
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-edit-race', turn: { id: 'first', status: 'completed' } } })}\n`);
  await until(() => seen.length === 1);
  h.send({ id: 46, method: 'thread/queue/update', params: { threadId: 'thread-edit-race', queuedSubmissionId: id, input: [{ type: 'text', text: 'after', text_elements: [] }] } });
  await until(() => h.downstream.some(m => m.id === 46));
  releaseFirst();
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-45'));
  assert.deepEqual(seen, ['before', 'after']);
  assert.equal(h.upstream.find(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-45').params.input[0].text, 'after');
});

test('queue list, reorder, delete, and explicit start are served by the proxy', async (t) => {
  const h = harness(); t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-order', turn: { id: 'first' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/started'));
  for (const [requestId, word] of [[50, 'first'], [51, 'second']]) {
    h.send({ id: requestId, method: 'thread/queue/add', params: { threadId: 'thread-order', input: [{ type: 'text', text: word, text_elements: [] }], clientUserMessageId: `client-${requestId}` } });
    await until(() => h.downstream.some(m => m.id === requestId));
  }
  const first = h.downstream.find(m => m.id === 50).result.queuedSubmission.id;
  const second = h.downstream.find(m => m.id === 51).result.queuedSubmission.id;
  h.send({ id: 52, method: 'thread/queue/reorder', params: { threadId: 'thread-order', queuedSubmissionIds: [second, first] } });
  await until(() => h.downstream.some(m => m.id === 52));
  h.send({ id: 53, method: 'thread/queue/list', params: { threadId: 'thread-order' } });
  await until(() => h.downstream.some(m => m.id === 53));
  assert.deepEqual(h.downstream.find(m => m.id === 53).result.data.map(item => item.id), [second, first]);
  h.send({ id: 54, method: 'thread/queue/delete', params: { threadId: 'thread-order', queuedSubmissionId: first } });
  await until(() => h.downstream.some(m => m.id === 54));
  assert.deepEqual(h.downstream.find(m => m.id === 54).result, { deleted: true });
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-order', turn: { id: 'first', status: 'completed' } } })}\n`);
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-51'));
  h.send({ id: 55, method: 'thread/queue/start', params: { threadId: 'thread-order', queuedSubmissionId: second } });
  await until(() => h.downstream.some(m => m.id === 55));
  assert.ok(h.downstream.find(m => m.id === 55).result?.turn || h.downstream.find(m => m.id === 55).error);
  assert.equal(h.upstream.filter(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-51').length, 1);
});

test('collaboration settings receive routed model and effort while preserving mode details', async (t) => {
  const h = harness(); t.after(h.stop); await h.ready();
  const collaborationMode = { mode: 'default', settings: { model: 'gpt-6-sol', reasoning_effort: 'medium', developer_instructions: 'keep this' } };
  h.send({ id: 60, method: 'turn/start', params: { threadId: 'thread-mode', input: [{ type: 'text', text: 'Fix typo' }], model: 'gpt-6-sol', effort: 'medium', collaborationMode } });
  await until(() => h.upstream.some((m) => m.id === 60));
  const params = h.upstream.find((m) => m.id === 60).params;
  assert.equal(params.model, 'gpt-6-luna');
  assert.equal(params.effort, 'low');
  assert.deepEqual(params.collaborationMode, { mode: 'default', settings: { model: 'gpt-6-luna', reasoning_effort: 'low', developer_instructions: 'keep this' } });
});

test('staged route adds planner, reviewer, and Jev-routed native subagent handoff instructions', async (t) => {
  const h = harness({ route: async () => ({
    model: 'gpt-6-astra', effort: 'xhigh', source: 'jev', phase: 'plan_execute', needsSecondOpinion: true,
    verifierModel: 'gpt-6-sol', verifierEffort: 'high', reason: '先规划再执行',
  }) });
  t.after(h.stop); await h.ready();
  const collaborationMode = { mode: 'default', settings: { model: 'gpt-6-sol', reasoning_effort: 'medium', developer_instructions: 'keep this' } };
  h.send({ id: 61, method: 'turn/start', params: { threadId: 'thread-staged', input: [{ type: 'text', text: 'Build a multi-step feature' }], model: 'gpt-6-sol', effort: 'medium', collaborationMode } });
  await until(() => h.upstream.some((m) => m.id === 61));
  const params = h.upstream.find((m) => m.id === 61).params;
  assert.deepEqual([params.model, params.effort, params.collaborationMode.mode], ['gpt-6-astra', 'xhigh', 'default']);
  assert.match(params.collaborationMode.settings.developer_instructions, /keep this/);
  assert.equal(params.additionalContext.jev_routing.kind, 'application');
  assert.match(params.additionalContext.jev_routing.value, /register a distinct review unit FIRST/);
  assert.match(params.additionalContext.jev_routing.value, /structuredContext.stage="review".*plannerModel="gpt-6-astra".*requireIndependentReview=true/);
  assert.match(params.additionalContext.jev_routing.value, /register_execution_plan/);
  assert.match(params.additionalContext.jev_routing.value, /route_execution_subtask/);
  assert.match(params.additionalContext.jev_routing.value, /nextAction=execute/);
  assert.match(params.additionalContext.jev_routing.value, /record_execution_acceptance/);
  assert.match(params.additionalContext.jev_routing.value, /At most two execution attempts/);
  assert.match(params.additionalContext.jev_routing.value, /reused=true.*Never blindly spawn again/);
  assert.match(params.additionalContext.jev_routing.value, /complete, untruncated history proves not_dispatched/);
  assert.match(params.additionalContext.jev_routing.value, /lastResult.*attachmentStatus/);
  assert.match(params.additionalContext.jev_routing.value, /native spawn_agent/);
  assert.match(params.additionalContext.jev_routing.value, /routingToken.*task_name/);
  assert.match(params.additionalContext.jev_routing.value, /subtask_history.*threadId=thread-staged/);
  assert.match(params.additionalContext.jev_routing.value, /not per-turn execution telemetry/);
  assert.match(params.additionalContext.jev_routing.value, /fork_turns="none"/);
  assert.match(params.additionalContext.jev_routing.value, /threadId=thread-staged/);
  assert.match(params.additionalContext.jev_routing.value, /source and target types/);
  assert.match(params.additionalContext.jev_routing.value, /compare those exact values against the original user message/);
});

test('a user-selected Codex plan mode stays planning-only', async (t) => {
  const h = harness({ route: async () => ({ model: 'gpt-6-astra', effort: 'high', source: 'jev', phase: 'plan_execute', needsSecondOpinion: true }) });
  t.after(h.stop); await h.ready();
  const collaborationMode = { mode: 'plan', settings: { model: 'gpt-6-sol', reasoning_effort: 'medium', developer_instructions: 'plan only' } };
  h.send({ id: 62, method: 'turn/start', params: { threadId: 'thread-plan-only', input: [{ type: 'text', text: 'Plan a complex refactor' }], collaborationMode } });
  await until(() => h.upstream.some((m) => m.id === 62));
  const params = h.upstream.find((m) => m.id === 62).params;
  assert.equal(params.collaborationMode.mode, 'plan');
  assert.equal(params.collaborationMode.settings.developer_instructions, 'plan only');
});

test('disabling routing clears the owned handoff context while retaining other context', async (t) => {
  let enabled = true;
  const h = harness({
    settings: async () => ({ enabled, mode: 'auto', timeoutMs: 500 }),
    route: async () => ({ model: 'gpt-6-astra', effort: 'high', source: 'jev', phase: 'plan_execute' }),
  });
  t.after(h.stop); await h.ready();
  h.send({ id: 63, method: 'turn/start', params: { threadId: 'stage-clear', input: [{ type: 'text', text: 'Build feature' }] } });
  await until(() => h.upstream.some(m => m.id === 63));
  const old = h.upstream.find(m => m.id === 63).params.additionalContext;
  assert.ok(old.jev_routing.value);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'stage-clear', turn: { id: 'turn-63', status: 'completed' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/completed'));
  enabled = false;
  const attachment = { kind: 'untrusted', value: 'user supplied reference' };
  h.send({ id: 64, method: 'turn/start', params: { threadId: 'stage-clear', input: [{ type: 'text', text: 'Next' }], additionalContext: { ...old, attachment } } });
  await until(() => h.upstream.some(m => m.id === 64));
  const context = h.upstream.find(m => m.id === 64).params.additionalContext;
  assert.equal(context.jev_routing.value, '');
  assert.deepEqual(context.attachment, attachment);
});

test('native picker update persists manual mode and later model-less turn respects it', async (t) => {
  let current = { enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 500 };
  const patches = [];
  const h = harness({
    settings: async () => current,
    setThreadSettings: async (_id, patch) => { patches.push(patch); current = { ...current, ...patch }; return current; },
    route: async ({ settings }) => settings.mode === 'manual'
      ? { model: settings.manualModel, effort: settings.manualEffort, source: 'manual', reason: '持续手动选择的模型' }
      : { model: 'gpt-6-luna', effort: 'low', source: 'jev', reason: '任务简单' },
  });
  t.after(h.stop); await h.ready();
  h.send({ id: 70, method: 'turn/start', params: { threadId: 'thread-picker', input: [{ type: 'text', text: 'First' }], model: 'gpt-6-sol', effort: 'medium' } });
  await until(() => h.upstream.some((m) => m.id === 70));
  await until(() => h.proxy.contexts.get('thread-picker')?.lastApplied);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-picker', turn: { id: 'turn-70', status: 'completed' } } })}\n`);
  await until(() => h.downstream.some((m) => m.method === 'turn/completed'));
  h.send({ id: 71, method: 'thread/settings/update', params: { threadId: 'thread-picker', model: 'gpt-6-astra', effort: 'high' } });
  await until(() => h.upstream.some((m) => m.id === 71));
  assert.deepEqual(patches[0], { mode: 'manual', manualModel: 'gpt-6-astra', manualEffort: 'high' });
  h.send({ id: 72, method: 'turn/start', params: { threadId: 'thread-picker', input: [{ type: 'text', text: 'Next' }] } });
  await until(() => h.upstream.some((m) => m.id === 72));
  assert.equal(h.upstream.find((m) => m.id === 72).params.model, 'gpt-6-astra');
  assert.equal(h.upstream.find((m) => m.id === 72).params.effort, 'high');
});

test('active turn supplement and steering pass unchanged without routing', async (t) => {
  const records = [];
  const h = harness({ record: async (entry) => records.push(entry) });
  t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-active', turn: { id: 'turn-a' } } })}\n`);
  await until(() => h.downstream.some((m) => m.method === 'turn/started'));
  const supplement = { id: 80, method: 'turn/start', params: { threadId: 'thread-active', input: [{ type: 'text', text: 'also do this' }] } };
  h.send(supplement);
  h.send({ id: 81, method: 'turn/steer', params: { threadId: 'thread-active', input: [{ type: 'text', text: 'steer' }], expectedTurnId: 'turn-a' } });
  await until(() => h.upstream.some((m) => m.id === 81));
  assert.deepEqual(h.upstream.find((m) => m.id === 80), supplement);
  assert.equal(records.length, 0);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-active', turn: { id: 'turn-a', status: 'completed' } } })}\n`);
  await until(() => h.downstream.some((m) => m.method === 'turn/completed'));
  h.send({ id: 82, method: 'turn/start', params: { threadId: 'thread-active', input: [{ type: 'text', text: 'new turn' }] } });
  await until(() => h.upstream.some((m) => m.id === 82));
  assert.equal(h.upstream.find((m) => m.id === 82).params.model, 'gpt-6-luna');
});

test('a supplement arriving before turn/started is forwarded without a second route', async (t) => {
  let selections = 0;
  const h = harness({ route: async () => { selections += 1; return { model: 'gpt-6-luna', effort: 'low', source: 'jev', reason: '任务简单' }; } });
  t.after(h.stop); await h.ready();
  h.send({ id: 83, method: 'turn/start', params: { threadId: 'thread-race', input: [{ type: 'text', text: 'First turn' }], model: 'gpt-6-sol', effort: 'medium' } });
  h.send({ id: 84, method: 'turn/start', params: { threadId: 'thread-race', input: [{ type: 'text', text: 'Extra instruction' }], model: 'gpt-6-sol', effort: 'medium' } });
  await until(() => h.upstream.some((message) => message.id === 84));
  assert.equal(selections, 1);
  assert.equal(h.upstream.find((message) => message.id === 83).params.model, 'gpt-6-luna');
  assert.equal(h.upstream.find((message) => message.id === 84).params.model, 'gpt-6-sol');
});

test('slow credential is capped by configured total budget and cannot apply late route', async (t) => {
  const records = [];
  let routeCalls = 0;
  const h = harness({ credential: async () => new Promise(() => {}),
    route: async () => { routeCalls++; return { model: 'gpt-6-luna', effort: 'low', source: 'jev' }; },
    settings: async () => ({ enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 100 }),
    record: async (entry) => records.push(entry) });
  t.after(h.stop); await h.ready();
  const start = performance.now();
  h.send({ id: 90, method: 'turn/start', params: { threadId: 'thread-slow', input: [{ type: 'text', text: 'review' }] } });
  await until(() => h.upstream.some((m) => m.id === 90));
  assert.ok(performance.now() - start < 300);
  assert.equal(h.upstream.find((m) => m.id === 90).params.model, 'gpt-6-astra');
  await until(() => records.length === 1);
  assert.equal(records[0].source, 'fallback');
  assert.equal(routeCalls, 0);
});

test('native start failure retains queue and emits no route claim', async (t) => {
  const records = []; const notices = [];
  const h = harness({ serverDelay: { turnStartFailure: true }, record: async entry => records.push(entry), announce: entry => notices.push(entry) });
  t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-fail', turn: { id: 'first' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/started'));
  h.send({ id: 100, method: 'thread/queue/add', params: { threadId: 'thread-fail', input: [{ type: 'text', text: 'review', text_elements: [] }], clientUserMessageId: 'client-100' } });
  await until(() => h.downstream.some(m => m.id === 100));
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-fail', turn: { id: 'first', status: 'completed' } } })}\n`);
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-100'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await h.queue.list('thread-fail')).data.length, 1);
  assert.equal((await h.queue.listLaunchStates('thread-fail')).length, 0);
  assert.equal(records.length, 0); assert.equal(notices.length, 0);
});

test('interrupt bypasses a pending route and cancels native start', async (t) => {
  let finishRoute;
  let routeEntered = false;
  const records = [];
  const h = harness({
    route: async () => { routeEntered = true; return new Promise(resolve => { finishRoute = resolve; }); },
    record: async entry => records.push(entry),
  });
  t.after(h.stop); await h.ready();
  h.send({ id: 1010, method: 'turn/start', params: { threadId: 'thread-cancel', input: [{ type: 'text', text: 'slow request' }] } });
  await until(() => routeEntered);
  h.send({ id: 1011, method: 'turn/interrupt', params: { threadId: 'thread-cancel', turnId: 'pending' } });
  await until(() => h.upstream.some(m => m.id === 1011));
  assert.equal(h.upstream.some(m => m.id === 1010), false);
  finishRoute({ model: 'gpt-6-luna', effort: 'low', source: 'jev', reason: 'simple' });
  await until(() => h.downstream.some(m => m.id === 1010 && m.error));
  await h.proxy.drain();
  assert.equal(h.upstream.some(m => m.id === 1010), false);
  assert.equal(records.length, 0);
});

test('interrupt cancels a start still waiting behind an earlier ingress message', async (t) => {
  let releaseSettings;
  let settingsEntered = false;
  const h = harness({ settings: async () => {
    settingsEntered = true;
    return new Promise(resolve => { releaseSettings = resolve; });
  } });
  t.after(h.stop); await h.ready();
  h.send({ id: 1014, method: 'thread/settings/update', params: { threadId: 'thread-ingress', model: 'gpt-6-sol' } });
  await until(() => settingsEntered);
  h.send({ id: 1015, method: 'turn/start', params: { threadId: 'thread-ingress', input: [{ type: 'text', text: 'do not start' }] } });
  h.send({ id: 1016, method: 'turn/interrupt', params: { threadId: 'thread-ingress', turnId: 'pending' } });
  await until(() => h.upstream.some(m => m.id === 1016));
  releaseSettings({ enabled: true, mode: 'auto' });
  await h.proxy.drain();
  await until(() => h.downstream.some(m => m.id === 1014));
  assert.equal(h.upstream.some(m => m.id === 1015), false);
  assert.ok(h.downstream.some(m => m.id === 1015 && m.error));
});

test('ordinary native turn rejection produces no route record or announcement', async (t) => {
  const records = []; const notices = [];
  const h = harness({ serverDelay: { turnStartFailure: true }, record: async entry => records.push(entry), announce: entry => notices.push(entry) });
  t.after(h.stop); await h.ready();
  h.send({ id: 1012, method: 'turn/start', params: { threadId: 'thread-native-reject', input: [{ type: 'text', text: 'review' }] } });
  await until(() => h.downstream.some(m => m.id === 1012 && m.error));
  await h.proxy.drain();
  assert.equal(records.length, 0);
  assert.equal(notices.length, 0);
});

test('idle resume keeps top-level native model and effort for queued start when routing is disabled', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jev-proxy-resume-model-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await createQueuedStore({ dataDir }).add({ threadId: 'thread-resume-model', input: [{ type: 'text', text: 'queued request', text_elements: [] }], clientUserMessageId: 'resume-model' });
  const h = harness({ dataDir, settings: async () => ({ enabled: false }) });
  t.after(h.stop); await h.ready();
  h.send({ id: 1013, method: 'thread/resume', params: { threadId: 'thread-resume-model' } });
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'resume-model'));
  const started = h.upstream.find(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'resume-model');
  assert.equal(started.params.model, 'gpt-6-sol');
  assert.equal(started.params.effort, 'medium');
});

test('explicit native rejection clears uncertainty so an idle resume can retry', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jev-proxy-rejected-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const behavior = { turnStartFailure: true };
  const h = harness({ dataDir, serverDelay: behavior }); t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-rejected', turn: { id: 'first' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/started'));
  h.send({ id: 102, method: 'thread/queue/add', params: { threadId: 'thread-rejected', input: [{ type: 'text', text: 'retryable', text_elements: [] }], clientUserMessageId: 'client-rejected' } });
  await until(() => h.downstream.some(m => m.id === 102));
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-rejected', turn: { id: 'first', status: 'completed' } } })}\n`);
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-rejected'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await h.queue.listLaunchStates('thread-rejected')).length, 0);
  behavior.turnStartFailure = false;
  h.send({ id: 103, method: 'thread/resume', params: { threadId: 'thread-rejected' } });
  await until(() => h.upstream.filter(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-rejected').length === 2);
  await until(() => h.downstream.some(m => m.method === 'thread/queue/changed' && h.downstream.indexOf(m) > 3));
  assert.equal(await h.queue.peek('thread-rejected'), null);
});

test('lost native response with matching clientId is confirmed without replay', async (t) => {
  const records = [];
  const h = harness({ serverDelay: { turnStartMode: 'started-no-response' }, internalStartTimeoutMs: 40,
    record: async entry => records.push(entry) });
  t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-lost-reply', turn: { id: 'first' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/started'));
  h.send({ id: 105, method: 'thread/queue/add', params: { threadId: 'thread-lost-reply', input: [{ type: 'text', text: 'send payment', text_elements: [] }], clientUserMessageId: 'payment-once' } });
  await until(() => h.downstream.some(m => m.id === 105));
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-lost-reply', turn: { id: 'first', status: 'completed' } } })}\n`);
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'payment-once'));
  await until(() => records.length === 1);
  assert.equal(await h.queue.peek('thread-lost-reply'), null);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-lost-reply', turn: { id: 'second', status: 'completed' } } })}\n`);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(h.upstream.filter(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'payment-once').length, 1);
});

test('unknown launch is durable and restart does not replay without proof', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jev-proxy-unknown-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const records = [];
  const h = harness({ dataDir, internalStartTimeoutMs: 40, serverDelay: { turnStartMode: 'unknown-no-response' }, record: async entry => records.push(entry) });
  await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-unknown', turn: { id: 'first' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/started'));
  h.send({ id: 106, method: 'thread/queue/add', params: { threadId: 'thread-unknown', input: [{ type: 'text', text: 'external side effect', text_elements: [] }], clientUserMessageId: 'once-106' } });
  await until(() => h.downstream.some(m => m.id === 106));
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-unknown', turn: { id: 'first', status: 'completed' } } })}\n`);
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'once-106'));
  await until(() => h.proxy && records.length === 0 && h.upstream.some(m => m.method === 'thread/read' && m.params.threadId === 'thread-unknown'));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await h.queue.listLaunchStates('thread-unknown')).length, 1);
  h.stop();
  const resumed = harness({ dataDir }); t.after(resumed.stop); await resumed.ready();
  resumed.send({ id: 107, method: 'thread/resume', params: { threadId: 'thread-unknown' } });
  await until(() => resumed.downstream.some(m => m.id === 107));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(resumed.upstream.filter(m => m.method === 'turn/start').length, 0);
  assert.equal((await resumed.queue.listLaunchStates('thread-unknown')).length, 1);
  resumed.send({ id: 108, method: 'thread/queue/start', params: { threadId: 'thread-unknown' } });
  await until(() => resumed.downstream.some(m => m.id === 108));
  assert.ok(resumed.downstream.find(m => m.id === 108).error);
});

test('resume reconciles a previously unknown launch found in native history', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jev-proxy-reconcile-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const queue = createQueuedStore({ dataDir });
  const item = await queue.add({ threadId: 'thread-reconciled', input: [{ type: 'text', text: 'already ran', text_elements: [] }], clientUserMessageId: 'client-reconciled' });
  await queue.markStarting('thread-reconciled', item.id, item.input);
  const h = harness({ dataDir }); t.after(h.stop);
  h.nativeHistory.set('thread-reconciled', [{ id: 'native-started', status: 'completed', items: [{ type: 'userMessage', id: 'msg', clientId: 'client-reconciled', content: item.input }] }]);
  await h.ready();
  h.send({ id: 109, method: 'thread/resume', params: { threadId: 'thread-reconciled' } });
  await until(() => h.downstream.some(m => m.method === 'thread/queue/changed'));
  assert.equal(await queue.peek('thread-reconciled'), null);
  assert.equal(h.upstream.filter(m => m.method === 'turn/start').length, 0);
});

test('queued start carries observed collaboration mode', async (t) => {
  const h = harness(); t.after(h.stop); await h.ready();
  const collaborationMode = { mode: 'plan', settings: { model: 'gpt-6-sol', reasoning_effort: 'medium', developer_instructions: 'plan instructions' } };
  h.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'thread-queue-mode', threadSettings: { model: 'gpt-6-sol', effort: 'medium', collaborationMode } } })}\n`);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-queue-mode', turn: { id: 'first' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/started'));
  h.send({ id: 110, method: 'thread/queue/add', params: { threadId: 'thread-queue-mode', input: [{ type: 'text', text: 'Fix typo', text_elements: [] }], clientUserMessageId: 'client-110' } });
  await until(() => h.downstream.some(m => m.id === 110));
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-queue-mode', turn: { id: 'first', status: 'completed' } } })}\n`);
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-110'));
  const params = h.upstream.find(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-110').params;
  assert.deepEqual(params.collaborationMode, { mode: 'plan', settings: { model: 'gpt-6-luna', reasoning_effort: 'low', developer_instructions: 'plan instructions' } });
});

test('explicit queue/start replies after native confirmation and only starts once', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jev-proxy-reply-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const queue = createQueuedStore({ dataDir });
  const entry = await queue.add({ threadId: 'thread-explicit', input: [{ type: 'text', text: 'work now', text_elements: [] }], clientUserMessageId: 'client-explicit' });
  const h = harness({ dataDir }); t.after(h.stop); await h.ready();
  h.send({ id: 130, method: 'thread/queue/start', params: { threadId: 'thread-explicit', queuedSubmissionId: entry.id } });
  await until(() => h.downstream.some(m => m.id === 130));
  const reply = h.downstream.find(m => m.id === 130);
  assert.equal(reply.result.turn.status, 'inProgress');
  assert.equal(h.upstream.filter(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-explicit').length, 1);
  assert.equal(h.downstream[h.downstream.indexOf(reply) + 1].method, 'thread/queue/changed');
  assert.equal(await queue.peek('thread-explicit'), null);
  h.send({ id: 131, method: 'thread/queue/start', params: { threadId: 'thread-explicit', queuedSubmissionId: entry.id } });
  await until(() => h.downstream.some(m => m.id === 131));
  assert.ok(h.downstream.find(m => m.id === 131).error);
  assert.equal(h.upstream.filter(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-explicit').length, 1);
});

test('resume recovers a durable queued input and routes when native thread is idle', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jev-proxy-resume-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const queue = createQueuedStore({ dataDir });
  await queue.add({ threadId: 'thread-recovered', input: [{ type: 'text', text: 'persisted prompt', text_elements: [] }], clientUserMessageId: 'client-recovered' });
  const seen = [];
  const h = harness({ dataDir, route: async ({ prompt }) => { seen.push(prompt); return { model: 'gpt-6-astra', effort: 'high', source: 'jev', reason: 'complex' }; } });
  t.after(h.stop); await h.ready();
  h.send({ id: 140, method: 'thread/resume', params: { threadId: 'thread-recovered' } });
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-recovered'));
  await until(() => h.downstream.some(m => m.method === 'thread/queue/changed'));
  assert.deepEqual(seen, ['persisted prompt']);
  assert.ok(h.downstream.findIndex(m => m.id === 140) < h.downstream.findIndex(m => m.method === 'thread/queue/changed'));
  assert.equal(await queue.peek('thread-recovered'), null);
});

test('resume waits for an active native turn before launching persisted queue', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jev-proxy-active-resume-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await createQueuedStore({ dataDir }).add({ threadId: 'thread-busy', input: [{ type: 'text', text: 'later', text_elements: [] }], clientUserMessageId: 'client-later' });
  const h = harness({ dataDir, serverDelay: { resumeStatus: 'active' } });
  t.after(h.stop); await h.ready();
  h.send({ id: 145, method: 'thread/resume', params: { threadId: 'thread-busy' } });
  await until(() => h.downstream.some(m => m.id === 145));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.upstream.filter(m => m.method === 'turn/start').length, 0);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-busy', turn: { id: 'old-turn', status: 'completed' } } })}\n`);
  await until(() => h.upstream.some(m => m.method === 'turn/start' && m.params.clientUserMessageId === 'client-later'));
});

test('slow context read stays within configured budget and does not route after forwarding', async (t) => {
  const records = [];
  const h = harness({ route: async () => new Promise(() => {}), serverDelay: { read: Infinity }, record: async (entry) => records.push(entry),
    settings: async () => ({ enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 100 }) });
  t.after(h.stop); await h.ready();
  const start = performance.now();
  h.send({ id: 120, method: 'turn/start', params: { threadId: 'thread-slow-read', input: [{ type: 'text', text: 'Review code' }] } });
  await until(() => h.upstream.some((m) => m.id === 120));
  assert.ok(performance.now() - start < 300);
  assert.deepEqual([h.upstream.find(m => m.id === 120).params.model, h.upstream.find(m => m.id === 120).params.effort], ['gpt-6-astra', 'high']);
  await until(() => records.length === 1);
  assert.equal(records[0].source, 'fallback');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(h.upstream.filter((m) => m.id === 120).length, 1);
  assert.equal(records.length, 1);
});

test('interrupt cancels automatic queue selection and preserves the queued input for retry', async (t) => {
  let finishRoute;
  const records = [];
  const h = harness({ route: async () => new Promise(resolve => { finishRoute = resolve; }), record: async entry => records.push(entry) });
  t.after(h.stop); await h.ready();
  h.send({ id: 201, method: 'thread/queue/add', params: { threadId: 'queue-cancel', input: [{ type: 'text', text: 'pending', text_elements: [] }], clientUserMessageId: 'queue-cancel-id' } });
  await until(() => finishRoute);
  h.send({ id: 202, method: 'turn/interrupt', params: { threadId: 'queue-cancel', turnId: 'pending' } });
  await until(() => h.upstream.some(m => m.id === 202));
  finishRoute({ model: 'gpt-6-luna', effort: 'low', source: 'jev' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.upstream.filter(m => m.method === 'turn/start').length, 0);
  assert.equal((await h.queue.list('queue-cancel')).data.length, 1);
  assert.equal((await h.queue.listLaunchStates('queue-cancel')).length, 0);
  assert.equal(records.length, 0);
});

test('interrupt during the durable queue marker clears the unsent launch', async (t) => {
  const h = harness(); t.after(h.stop); await h.ready();
  let releaseMarker;
  const markStarting = h.queue.markStarting;
  h.queue.markStarting = async (...args) => {
    const marked = await markStarting(...args);
    await new Promise(resolve => { releaseMarker = resolve; });
    return marked;
  };
  const entry = await h.queue.add({ threadId: 'mark-cancel', input: [{ type: 'text', text: 'pending', text_elements: [] }], clientUserMessageId: 'mark-cancel-id' });
  h.send({ id: 203, method: 'thread/queue/start', params: { threadId: 'mark-cancel', queuedSubmissionId: entry.id } });
  await until(() => releaseMarker);
  h.send({ id: 204, method: 'turn/interrupt', params: { threadId: 'mark-cancel', turnId: 'pending' } });
  releaseMarker();
  await h.proxy.drain();
  assert.equal(h.upstream.filter(m => m.method === 'turn/start').length, 0);
  assert.equal((await h.queue.listLaunchStates('mark-cancel')).length, 0);
  assert.equal((await h.queue.list('mark-cancel')).data.length, 1);
  assert.equal(h.downstream.filter(m => m.id === 203).length, 1);
  assert.match(h.downstream.find(m => m.id === 203).error.message, /cancelled/);
});

test('interrupt covers all unsent starts in a thread and does not cancel other or later work', async (t) => {
  let finishFirst;
  const h = harness({ route: async ({ prompt }) => {
    if (prompt === 'slow') await new Promise(resolve => { finishFirst = resolve; });
    return { model: 'gpt-6-luna', effort: 'low', source: 'jev' };
  } });
  t.after(h.stop); await h.ready();
  const sendStart = (id, threadId, text) => h.send({ id, method: 'turn/start', params: { threadId, input: [{ type: 'text', text }] } });
  sendStart(205, 'cancel-many', 'slow');
  await until(() => finishFirst);
  sendStart(206, 'cancel-many', 'also pending');
  sendStart(207, 'not-cancelled', 'independent');
  h.send({ id: 208, method: 'turn/interrupt', params: { threadId: 'cancel-many', turnId: 'pending' } });
  h.send({ id: 209, method: 'turn/interrupt', params: { threadId: 'cancel-many', turnId: 'pending' } });
  finishFirst();
  await until(() => h.upstream.some(m => m.id === 207));
  assert.equal(h.upstream.some(m => m.id === 205 || m.id === 206), false);
  assert.equal(h.downstream.filter(m => m.id === 205 && m.error).length, 1);
  assert.equal(h.downstream.filter(m => m.id === 206 && m.error).length, 1);
  sendStart(210, 'cancel-many', 'after cancel');
  await until(() => h.upstream.some(m => m.id === 210));
  assert.equal(h.downstream.some(m => m.id === 210 && m.error), false);
});

test('an explicit queued start waiting in ingress cannot restart after interrupt', async (t) => {
  let releaseSettings;
  let first = true;
  const h = harness({ settings: async () => {
    if (first) { first = false; await new Promise(resolve => { releaseSettings = resolve; }); }
    return { enabled: true, mode: 'auto' };
  } });
  t.after(h.stop); await h.ready();
  const entry = await h.queue.add({ threadId: 'queued-ingress', input: [{ type: 'text', text: 'later', text_elements: [] }], clientUserMessageId: 'queued-ingress-id' });
  h.send({ id: 211, method: 'thread/settings/update', params: { threadId: 'other-setting', model: 'gpt-6-sol', effort: 'medium' } });
  await until(() => releaseSettings);
  h.send({ id: 212, method: 'thread/queue/start', params: { threadId: 'queued-ingress', queuedSubmissionId: entry.id } });
  h.send({ id: 213, method: 'turn/interrupt', params: { threadId: 'queued-ingress', turnId: 'pending' } });
  releaseSettings();
  await h.proxy.drain();
  await until(() => h.downstream.some(m => m.id === 211));
  assert.equal(h.upstream.filter(m => m.method === 'turn/start').length, 0);
  assert.equal(h.downstream.filter(m => m.id === 212).length, 1);
  assert.match(h.downstream.find(m => m.id === 212).error.message, /cancelled/);
});

test('an ordinary start waits for a queued launch and becomes a native supplement', async (t) => {
  let finishRoute;
  let decisions = 0;
  const h = harness({ route: async () => {
    decisions += 1;
    await new Promise(resolve => { finishRoute = resolve; });
    return { model: 'gpt-6-luna', effort: 'low', source: 'jev' };
  } });
  t.after(h.stop); await h.ready();
  h.send({ id: 214, method: 'thread/queue/add', params: { threadId: 'queue-concurrent', input: [{ type: 'text', text: 'queued', text_elements: [] }], clientUserMessageId: 'queue-concurrent-id' } });
  await until(() => finishRoute);
  h.send({ id: 215, method: 'turn/start', params: { threadId: 'queue-concurrent', input: [{ type: 'text', text: 'supplement' }] } });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.upstream.filter(m => m.method === 'turn/start').length, 0);
  finishRoute();
  await until(() => h.upstream.some(m => m.id === 215));
  const starts = h.upstream.filter(m => m.method === 'turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].params.clientUserMessageId, 'queue-concurrent-id');
  assert.equal(starts[1].id, 215);
  assert.equal(decisions, 1);
});

test('the full queue routing budget retains and records quality-first fallback', async (t) => {
  const records = [];
  const h = harness({ route: async () => new Promise(() => {}), record: async entry => records.push(entry),
    settings: async () => ({ enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 2000 }) });
  t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'queue-timeout', threadSettings: { model: 'gpt-6-luna', effort: 'low' } } })}\n`);
  h.send({ id: 216, method: 'thread/queue/add', params: { threadId: 'queue-timeout', input: [{ type: 'text', text: 'review', text_elements: [] }], clientUserMessageId: 'queue-timeout-id' } });
  await until(() => records.length === 1, 2600);
  const start = h.upstream.find(m => m.method === 'turn/start');
  assert.deepEqual([start.params.model, start.params.effort], ['gpt-6-astra', 'high']);
  assert.equal(records[0].source, 'fallback');
});

test('a queue edit at timeout gets a valid local decision for its final explicit input', async (t) => {
  let decisions = 0;
  const records = [];
  const h = harness({ route: async () => { decisions += 1; return new Promise(() => {}); }, record: async entry => records.push(entry),
    settings: async () => ({ enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 100 }) });
  t.after(h.stop); await h.ready();
  h.send({ id: 217, method: 'thread/queue/add', params: { threadId: 'queue-final', input: [{ type: 'text', text: 'original', text_elements: [] }], clientUserMessageId: 'queue-final-id' } });
  await until(() => decisions === 1);
  const entry = await h.queue.peek('queue-final');
  h.send({ id: 218, method: 'thread/queue/update', params: { threadId: 'queue-final', queuedSubmissionId: entry.id, input: [{ type: 'text', text: '请用 Astra，high', text_elements: [] }] } });
  await until(() => records.length === 1);
  const start = h.upstream.find(m => m.method === 'turn/start');
  assert.equal(start.params.input[0].text, '请用 Astra，high');
  assert.equal(start.params.model, 'gpt-6-astra');
  assert.equal(start.params.effort, 'high');
  assert.equal(records[0].source, 'explicit');
  assert.equal(decisions, 1);
});

test('a missing catalog produces an explicit diagnostic without claiming a validated fallback', async (t) => {
  const records = []; const diagnostics = [];
  const h = harness({ serverDelay: { modelList: Infinity }, record: async entry => records.push(entry), diagnostic: message => diagnostics.push(message),
    settings: async () => ({ enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 50 }) });
  t.after(h.stop);
  h.send({ method: 'initialized' });
  h.send({ id: 219, method: 'turn/start', params: { threadId: 'no-catalog', model: 'gpt-6-luna', effort: 'low', input: [{ type: 'text', text: 'review' }] } });
  await until(() => h.upstream.some(m => m.id === 219));
  assert.equal(h.upstream.find(m => m.id === 219).params.model, 'gpt-6-luna');
  assert.equal(records.length, 0);
  assert.ok(diagnostics.includes('route skipped: no available model catalog'));
});

test('context timeout fallback respects the final input modalities and available efforts', async (t) => {
  const models = catalog.map(model => ({ ...model, inputModalities: model.model === 'gpt-6-astra' ? ['text', 'image'] : ['text'] }));
  const records = [];
  const h = harness({ route: async () => new Promise(() => {}), serverDelay: { catalog: models, read: Infinity }, record: async entry => records.push(entry),
    settings: async () => ({ enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 50 }) });
  t.after(h.stop); await h.ready();
  h.send({ id: 220, method: 'turn/start', params: { threadId: 'image-timeout', input: [{ type: 'localImage', path: '/local/reference.png' }] } });
  await until(() => records.length === 1);
  const start = h.upstream.find(m => m.id === 220);
  assert.deepEqual([start.params.model, start.params.effort], ['gpt-6-astra', 'high']);
  assert.equal(records[0].source, 'fallback');
});

test('the first native picker change enters manual mode and later choices replace it', async (t) => {
  let current = { enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 500 };
  const patches = [];
  const h = harness({ settings: async () => current,
    setThreadSettings: async (_id, patch) => { patches.push(patch); current = { ...current, ...patch }; return current; },
    route: async ({ settings }) => ({ model: settings.manualModel || 'gpt-6-luna', effort: settings.manualEffort || 'low', source: settings.mode === 'manual' ? 'manual' : 'jev' }) });
  t.after(h.stop); await h.ready();
  h.send({ id: 221, method: 'thread/settings/update', params: { threadId: 'first-picker', model: 'gpt-6-astra', effort: 'high' } });
  h.send({ id: 222, method: 'turn/start', params: { threadId: 'first-picker', input: [{ type: 'text', text: 'first turn' }] } });
  await until(() => h.upstream.some(m => m.id === 222));
  assert.deepEqual(patches[0], { mode: 'manual', manualModel: 'gpt-6-astra', manualEffort: 'high' });
  assert.deepEqual([h.upstream.find(m => m.id === 222).params.model, h.upstream.find(m => m.id === 222).params.effort], ['gpt-6-astra', 'high']);
  h.send({ id: 223, method: 'thread/settings/update', params: { threadId: 'first-picker', model: 'gpt-6-sol', effort: 'medium' } });
  await until(() => h.upstream.some(m => m.id === 223));
  assert.deepEqual(patches[1], { mode: 'manual', manualModel: 'gpt-6-sol', manualEffort: 'medium' });
});

test('native defaults and settings echoes of a confirmed route do not enable manual mode', async (t) => {
  const patches = [];
  const h = harness({ setThreadSettings: async (_id, patch) => { patches.push(patch); return { enabled: true, ...patch }; } });
  t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'picker-echo', threadSettings: { model: 'gpt-6-astra', effort: 'high' } } })}\n`);
  h.send({ id: 224, method: 'turn/start', params: { threadId: 'picker-echo', input: [{ type: 'text', text: 'first turn' }], model: 'gpt-6-astra', effort: 'high' } });
  await until(() => h.proxy.contexts.get('picker-echo')?.lastApplied);
  h.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'picker-echo', threadSettings: { model: 'gpt-6-luna', effort: 'low' } } })}\n`);
  h.send({ id: 225, method: 'thread/settings/update', params: { threadId: 'picker-echo', model: 'gpt-6-luna', effort: 'low' } });
  await until(() => h.upstream.some(m => m.id === 225));
  assert.deepEqual(patches, []);
});

test('resume explicit null clears cached collaboration mode and reasoning effort', async (t) => {
  const h = harness({ settings: async () => ({ enabled: false }),
    serverDelay: { resumeSettings: { model: 'gpt-6-sol', reasoningEffort: null, collaborationMode: null } } });
  t.after(h.stop); await h.ready();
  const oldMode = { mode: 'plan', settings: { model: 'gpt-6-astra', reasoning_effort: 'high' } };
  h.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'resume-null', threadSettings: { model: 'gpt-6-astra', effort: 'high', collaborationMode: oldMode } } })}\n`);
  await h.queue.add({ threadId: 'resume-null', input: [{ type: 'text', text: 'queued', text_elements: [] }], clientUserMessageId: 'resume-null-id' });
  h.send({ id: 226, method: 'thread/resume', params: { threadId: 'resume-null' } });
  await until(() => h.upstream.some(m => m.method === 'turn/start'));
  const start = h.upstream.find(m => m.method === 'turn/start');
  assert.equal(start.params.model, 'gpt-6-sol');
  assert.equal(start.params.effort, null);
  assert.equal(start.params.collaborationMode, null);
});

test('resume fields omitted by the native server preserve the observed runtime values', async (t) => {
  const h = harness({ settings: async () => ({ enabled: false }), serverDelay: { resumeSettings: { model: 'gpt-6-astra' } } });
  t.after(h.stop); await h.ready();
  const oldMode = { mode: 'plan', settings: { model: 'gpt-6-astra', reasoning_effort: 'high' } };
  h.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'resume-omitted', threadSettings: { model: 'gpt-6-astra', effort: 'high', collaborationMode: oldMode } } })}\n`);
  await h.queue.add({ threadId: 'resume-omitted', input: [{ type: 'text', text: 'queued', text_elements: [] }], clientUserMessageId: 'resume-omitted-id' });
  h.send({ id: 227, method: 'thread/resume', params: { threadId: 'resume-omitted' } });
  await until(() => h.upstream.some(m => m.method === 'turn/start'));
  const start = h.upstream.find(m => m.method === 'turn/start');
  assert.equal(start.params.effort, 'high');
  assert.deepEqual(start.params.collaborationMode, oldMode);
});

test('an explicit null turn mode does not inherit the earlier planning-only constraint', async (t) => {
  const h = harness({ route: async () => ({ model: 'gpt-6-astra', effort: 'high', source: 'jev', phase: 'plan_execute' }) });
  t.after(h.stop); await h.ready();
  h.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'mode-cleared', threadSettings: { collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-astra', reasoning_effort: 'high' } } } } })}\n`);
  h.send({ id: 228, method: 'turn/start', params: { threadId: 'mode-cleared', collaborationMode: null, input: [{ type: 'text', text: 'implement feature' }] } });
  await until(() => h.upstream.some(m => m.id === 228));
  const start = h.upstream.find(m => m.id === 228);
  assert.equal(start.params.collaborationMode, null);
  assert.match(start.params.additionalContext.jev_routing.value, /route_execution_subtask/);
});

test('a one-turn override echo preserves the persistent manual model', async (t) => {
  let current = { enabled: true, mode: 'manual', manualModel: 'gpt-6-astra', manualEffort: 'high',
    fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 500 };
  const patches = [];
  const h = harness({ settings: async () => current,
    setThreadSettings: async (_id, patch) => { patches.push(patch); current = { ...current, ...patch }; return current; },
    route: args => chooseRoute({ ...args, apiKey: null }) });
  t.after(h.stop); await h.ready();
  h.send({ id: 229, method: 'turn/start', params: { threadId: 'manual-once', input: [{ type: 'text', text: '这轮使用 Luna，推理强度设为 low' }] } });
  await until(() => h.proxy.contexts.get('manual-once')?.lastApplied);
  assert.deepEqual(h.proxy.contexts.get('manual-once').lastApplied, { model: 'gpt-6-luna', effort: 'low' });
  h.child.stdout.write(`${JSON.stringify({ method: 'thread/settings/updated', params: { threadId: 'manual-once', threadSettings: { model: 'gpt-6-luna', effort: 'low' } } })}\n`);
  h.send({ id: 230, method: 'thread/settings/update', params: { threadId: 'manual-once', model: 'gpt-6-luna', effort: 'low' } });
  await until(() => h.downstream.some(m => m.id === 230));
  assert.deepEqual(patches, []);
  assert.deepEqual([current.manualModel, current.manualEffort], ['gpt-6-astra', 'high']);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'manual-once', turn: { id: 'turn-229', status: 'completed' } } })}\n`);
  h.send({ id: 231, method: 'turn/start', params: { threadId: 'manual-once', input: [{ type: 'text', text: '继续' }] } });
  await until(() => h.upstream.some(m => m.id === 231));
  assert.deepEqual([h.upstream.find(m => m.id === 231).params.model, h.upstream.find(m => m.id === 231).params.effort], ['gpt-6-astra', 'high']);
});

test('a successful picker change during queue selection replaces a stale decision before native start', async (t) => {
  for (const timeout of [false, true]) await t.test(timeout ? 'exhausted selection budget' : 'Jev returns its old decision', async (t) => {
    let current = { enabled: true, mode: 'auto', fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: timeout ? 80 : 500 };
    const records = [];
    let finishRoute;
    let decisions = 0;
    const h = harness({ settings: async () => current,
      setThreadSettings: async (_id, patch) => { current = { ...current, ...patch }; return current; },
      record: async entry => records.push(entry),
      route: async () => { decisions += 1; return new Promise(resolve => { finishRoute = resolve; }); } });
    t.after(h.stop); await h.ready();
    h.send({ id: 232, method: 'thread/queue/add', params: { threadId: 'queued-picker', input: [{ type: 'text', text: '待执行任务', text_elements: [] }], clientUserMessageId: 'queued-picker-id' } });
    await until(() => finishRoute);
    h.send({ id: 233, method: 'thread/settings/update', params: { threadId: 'queued-picker', model: 'gpt-6-astra', effort: 'high' } });
    await until(() => h.downstream.some(m => m.id === 233));
    assert.equal(current.mode, 'manual');
    if (!timeout) finishRoute({ model: 'gpt-6-luna', effort: 'low', source: 'jev' });
    await until(() => records.length === 1);
    const start = h.upstream.find(m => m.method === 'turn/start');
    assert.deepEqual([start.params.model, start.params.effort], ['gpt-6-astra', 'high']);
    assert.equal(records[0].source, 'manual');
    assert.equal(decisions, 1);
  });
});


test('configured routing wait can exceed two seconds and includes settings work', async (t) => {
  let seenTimeout;
  const h = harness({
    settings: async () => { await new Promise(resolve => setTimeout(resolve, 80)); return { enabled: true, mode: 'auto', timeoutMs: 2600 }; },
    route: async ({ settings }) => { seenTimeout = settings.timeoutMs; await new Promise(resolve => setTimeout(resolve, 2050)); return { model: 'gpt-6-luna', effort: 'low', source: 'jev' }; },
  });
  t.after(h.stop); await h.ready();
  h.send({ id: 300, method: 'turn/start', params: { threadId: 'long-budget', input: [{ type: 'text', text: 'Rename the local variable' }] } });
  await until(() => h.upstream.some(m => m.id === 300), 3200);
  assert.ok(seenTimeout > 2000 && seenTimeout < 2540);
  assert.equal(h.upstream.find(m => m.id === 300).params.model, 'gpt-6-luna');
});

test('prompt bound retains both ends and does not change the actual native input', async (t) => {
  let routedPrompt;
  const text = 'START EXACT_CONSTRAINT ' + 'x'.repeat(15000) + ' FINAL_CONSTRAINT keep 127 files';
  const h = harness({ route: async ({ prompt }) => { routedPrompt = prompt; return { model: 'gpt-6-sol', effort: 'medium', source: 'jev' }; } });
  t.after(h.stop); await h.ready();
  h.send({ id: 301, method: 'turn/start', params: { threadId: 'bounded-prompt', input: [{ type: 'text', text }] } });
  await until(() => h.upstream.some(m => m.id === 301));
  assert.ok(routedPrompt.length <= 12000);
  assert.match(routedPrompt, /^START EXACT_CONSTRAINT/);
  assert.match(routedPrompt, /TRUNCATED/);
  assert.match(routedPrompt, /FINAL_CONSTRAINT keep 127 files$/);
  assert.equal(h.upstream.find(m => m.id === 301).params.input[0].text, text);
});

test('same-thread safety evidence only accompanies explicit continuation', async (t) => {
  const seen = [];
  const h = harness({ route: async ({ context }) => { seen.push(context); return { model: 'gpt-6-astra', effort: 'high', phase: 'plan_execute', source: 'jev', highRisk: true, capabilityFloor: 'strong' }; } });
  t.after(h.stop); await h.ready();
  h.proxy.contexts.set('evidence', { previousRoute: { model: 'gpt-6-astra', effort: 'high', phase: 'plan_execute', highRisk: true, capabilityFloor: 'strong' } });
  h.send({ id: 302, method: 'turn/start', params: { threadId: 'evidence', input: [{ type: 'text', text: 'Continue' }] } });
  await until(() => h.upstream.some(m => m.id === 302));
  assert.equal(seen[0].continuation, true);
  assert.equal(seen[0].previousRoute.highRisk, true);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'evidence', turn: { id: 'turn-302', status: 'completed' } } })}\n`);
  h.send({ id: 303, method: 'turn/start', params: { threadId: 'evidence', input: [{ type: 'text', text: 'New goal: write a birthday greeting' }] } });
  await until(() => h.upstream.some(m => m.id === 303));
  assert.equal(seen[1].previousRoute, undefined);
});

test('stop route never starts native work and replan explicitly gates implementation', async (t) => {
  for (const action of ['stop', 'replan']) await t.test(action, async t => {
    const h = harness({ route: async () => ({ model: 'gpt-6-astra', effort: 'high', source: 'policy', nextAction: action }) });
    t.after(h.stop); await h.ready();
    h.send({ id: 304, method: 'turn/start', params: { threadId: `action-${action}`, input: [{ type: 'text', text: 'Perform the next unit' }] } });
    if (action === 'stop') {
      await until(() => h.downstream.some(m => m.id === 304 && m.error));
      assert.equal(h.upstream.some(m => m.id === 304), false);
    } else {
      await until(() => h.upstream.some(m => m.id === 304));
      assert.match(h.upstream.find(m => m.id === 304).params.additionalContext.jev_routing.value, /nextAction=replan.*before implementation/);
    }
  });
});


test('confirmed native starts record bounded policy metadata without task contents', async t => {
  const records = [];
  const h = harness({ record: async entry => records.push(entry), route: async () => ({
    model: 'gpt-6-sol', effort: 'medium', source: 'jev', phase: 'direct', taskKind: 'code',
    policyVersion: '2.0', nextAction: 'execute', contextComplete: true, capabilityLimited: false,
    reasonCode: 'judgment', reason: 'PRIVATE_TASK_REASON', constraints: 'PRIVATE_CONSTRAINT',
  }) });
  t.after(h.stop); await h.ready();
  h.send({ id: 305, method: 'turn/start', params: { threadId: 'metadata', input: [{ type: 'text', text: 'PRIVATE_TASK_PROMPT' }] } });
  await until(() => records.length === 1);
  for (const [key, value] of Object.entries({ taskKind: 'code', policyVersion: '2.0', nextAction: 'execute', contextComplete: true, capabilityLimited: false })) assert.equal(records[0][key], value);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_/);
});


test('status interlude preserves later continuation evidence and omits staged handoff', async (t) => {
  const seen = [];
  const h = harness({ route: async args => {
    seen.push(args.context);
    return chooseRoute({ ...args, localOnly: true });
  } });
  t.after(h.stop); await h.ready();
  h.proxy.contexts.set('status-interlude', { summary: 'Historical implementation. '.repeat(300),
    lastResult: 'Tests passed; deployment and native acceptance are still pending.',
    constraints: 'No deployment before acceptance.',
    previousRoute: { model: 'gpt-6-astra', effort: 'high', phase: 'plan_execute', taskKind: 'architecture', highRisk: true, needsSecondOpinion: true, capabilityFloor: 3 } });
  const text = '还有什么优化没做完？只汇报当前状态，不执行改动。';
  h.send({ id: 390, method: 'turn/start', params: { threadId: 'status-interlude', input: [{ type: 'text', text }] } });
  await until(() => h.upstream.some(m => m.id === 390));
  const status = h.upstream.find(m => m.id === 390).params;
  assert.equal(status.model, 'gpt-6-sol');
  assert.match(status.additionalContext.jev_routing.value, /Routing visibility/);
  assert.doesNotMatch(status.additionalContext.jev_routing.value, /Mandatory handoff rule/);
  assert.equal(status.input[0].text, text);
  assert.equal(seen[0].previousRoute, undefined);
  assert.equal(seen[0].constraints, 'No deployment before acceptance.');
  await until(() => h.proxy.contexts.get('status-interlude')?.lastApplied);
  assert.equal(h.proxy.contexts.get('status-interlude').previousRoute.highRisk, true);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'status-interlude', turn: { id: 'turn-390', status: 'completed' } } })}\n`);
  h.send({ id: 391, method: 'turn/start', params: { threadId: 'status-interlude', input: [{ type: 'text', text: '继续处理剩下的上线工作' }] } });
  await until(() => h.upstream.some(m => m.id === 391));
  assert.equal(seen[1].previousRoute.highRisk, true);
  assert.equal(seen[1].continuation, true);
  assert.equal(h.upstream.find(m => m.id === 391).params.model, 'gpt-6-astra');
  assert.match(h.upstream.find(m => m.id === 391).params.additionalContext.jev_routing.value, /staged planning/);
});


test('every routed turn replaces stage instructions with a fresh visible notice even for same configuration', async (t) => {
  let calls = 0;
  const notices = [];
  const h = harness({ route: async () => ({ model: 'gpt-6-sol', effort: 'high', source: 'jev', nextAction: 'execute',
    phase: ++calls === 1 ? 'plan_execute' : 'direct' }), announce: entry => notices.push(entry) });
  t.after(h.stop); await h.ready();
  h.send({ id: 500, method: 'turn/start', params: { threadId: 'notice', input: [{ type: 'text', text: 'Implement the plan' }] } });
  await until(() => notices.length === 1);
  const old = h.upstream.find(m => m.id === 500).params.additionalContext;
  assert.match(old.jev_routing.value, /Routing visibility.*staged planning/);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'notice', turn: { status: 'completed' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/completed'));
  h.send({ id: 501, method: 'turn/start', params: { threadId: 'notice', additionalContext: old,
    input: [{ type: 'text', text: 'Return exactly OK, no extra text.' }] } });
  await until(() => notices.length === 2);
  const next = h.upstream.find(m => m.id === 501).params.additionalContext.jev_routing.value;
  assert.match(next, /Routing visibility/);
  assert.match(next, /omit the notice when extra text is forbidden/);
  assert.doesNotMatch(next, /Mandatory handoff rule/);
  assert.equal(calls, 2);
  assert.equal(notices[1].presentation.event, 'reselected');
  assert.equal(notices[1].presentation.sameConfiguration, true);
});

test('plan-only route carries visible status without execution handoff', async (t) => {
  const h = harness({ route: async () => ({ model: 'gpt-6-astra', effort: 'high', source: 'jev', phase: 'plan_execute', nextAction: 'execute' }) });
  t.after(h.stop); await h.ready();
  h.send({ id: 510, method: 'turn/start', params: { threadId: 'plan-notice', input: [{ type: 'text', text: 'Plan changes' }],
    collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-sol', reasoning_effort: 'medium' } } } });
  await until(() => h.upstream.some(m => m.id === 510));
  const context = h.upstream.find(m => m.id === 510).params.additionalContext.jev_routing.value;
  assert.match(context, /Routing visibility/);
  assert.doesNotMatch(context, /Mandatory handoff rule/);
});

test('active steering reports retained configuration and preserves native protocol unchanged', async (t) => {
  let calls = 0; const notices = [];
  const h = harness({ route: async () => { calls++; return { model: 'gpt-6-sol', effort: 'high', source: 'jev', nextAction: 'execute' }; },
    announce: entry => notices.push(entry) });
  t.after(h.stop); await h.ready();
  h.send({ id: 520, method: 'turn/start', params: { threadId: 'retained', input: [{ type: 'text', text: 'Implement' }] } });
  await until(() => notices.length === 1);
  const steering = { id: 521, method: 'turn/steer', params: { threadId: 'retained', expectedTurnId: 'turn-520', input: [{ type: 'text', text: 'Preserve the interface' }] } };
  h.send(steering);
  await until(() => notices.length === 2);
  assert.deepEqual(h.upstream.find(m => m.id === 521), steering);
  assert.equal(calls, 1);
  assert.equal(notices[1].presentation.event, 'retained');
  assert.match(notices[1].presentation.text, /未重新/);
});


test('retained notices skip tool receipts and inactive steering and record metadata only', async (t) => {
  const notices = []; const records = [];
  const h = harness({ announce: entry => notices.push(entry), record: entry => records.push(entry) });
  t.after(h.stop); await h.ready();
  h.send({ id: 530, method: 'turn/start', params: { threadId: 'retained-boundary', input: [{ type: 'text', text: 'Implement' }] } });
  await until(() => records.length === 1);
  h.send({ id: 531, method: 'turn/start', params: { threadId: 'retained-boundary', toolOutput: { content: 'tool receipt' }, input: [] } });
  h.send({ id: 532, method: 'turn/steer', params: { threadId: 'retained-boundary', input: [] } });
  await until(() => h.upstream.some(m => m.id === 532));
  assert.equal(notices.length, 1);
  h.send({ id: 533, method: 'turn/steer', params: { threadId: 'retained-boundary', input: [{ type: 'text', text: 'PRIVATE STEERING TEXT' }] } });
  await until(() => records.length === 2);
  assert.equal(records[1].reasonCode, 'continuation_retained');
  assert.equal(records[1].routeScope, 'continuation');
  assert.equal(records[1].source, 'policy');
  assert.doesNotMatch(JSON.stringify(records[1]), /PRIVATE STEERING TEXT/);
  h.child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'retained-boundary', turn: { status: 'completed' } } })}\n`);
  await until(() => h.downstream.some(m => m.method === 'turn/completed'));
  h.send({ id: 534, method: 'turn/steer', params: { threadId: 'retained-boundary', input: [{ type: 'text', text: 'Late steering' }] } });
  await until(() => h.upstream.some(m => m.id === 534));
  assert.equal(notices.length, 2);
  assert.equal(records.length, 2);
});
