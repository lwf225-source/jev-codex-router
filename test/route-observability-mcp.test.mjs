import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.mjs';
import { scheduleRouteNotice } from '../src/desktop-notice.mjs';
const route = { model: 'gpt-6-sol', effort: 'medium', source: 'jev', nextAction: 'execute', phase: 'execution' };
const models = [{ id: 'gpt-6-sol', supportedReasoningEfforts: ['medium'] }];
async function harness(options, run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jev-observability-'));
  const server = createMcpServer({ dataDir, readKey: async () => 'fake', listModels: async () => models, chooseRoute: async () => ({ ...route }), chooseSubtaskRoute: async () => ({ ...route }), announce: async () => false, ...options });
  const client = new Client({ name: 'observability-test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    await run(async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent, dataDir, client);
  } finally { await client.close(); await server.close(); await rm(dataDir, { recursive: true, force: true }); }
}
const args = { threadId: 'parent', task: 'PRIVATE TASK', acceptanceCriteria: 'PRIVATE CRITERIA', models };

test('fresh unit announces once; reused unit and preview suppress notices; audit has safe metadata', async () => {
  const notices = [];
  await harness({ announce: async (value, options) => { notices.push({ value, options }); return true; } }, async (call, dataDir, client) => {
    const tools = await client.listTools();
    assert.match(tools.tools.find(t => t.name === 'route_execution_subtask').description, /display presentation.text.*exact output format/);
    assert.equal((await call('status', {})).routeObservabilityVersion, 'route-visibility-v1');
    await call('register_execution_plan', { threadId: 'parent', units: [{ unitId: 'unit', task: args.task, acceptanceCriteria: args.acceptanceCriteria }] });
    const first = await call('route_execution_subtask', { ...args, unitId: 'unit', previousModel: route.model, previousEffort: route.effort });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(first.presentation.event, 'reselected');
    assert.equal(first.presentation.sameConfiguration, true);
    assert.deepEqual(first.notification, { delivery: 'scheduled', userSeen: null });
    assert.equal(notices.length, 1);
    const second = await call('route_execution_subtask', { ...args, unitId: 'unit', previousModel: route.model, previousEffort: route.effort });
    assert.equal(second.reused, true);
    assert.equal(second.presentation.event, 'blocked');
    assert.match(second.presentation.text, /复用已有决定.*未重新询问 Jev/);
    assert.equal(second.notification, undefined);
    await call('route_preview', { prompt: 'PRIVATE PREVIEW', models });
    assert.equal(notices.length, 1);
    const raw = await readFile(join(dataDir, 'routes.json'), 'utf8');
    assert.equal(raw.includes('PRIVATE'), false);
    const log = JSON.parse(raw);
    assert.equal(log.length, 1);
    assert.equal(log[0].routeScope, 'subtask');
    assert.equal(log[0].selectionEvent, 'reselected');
    assert.equal((await stat(join(dataDir, 'routes.json'))).mode & 0o777, 0o600);
  });
});
test('notification failure and a never-resolving announcer preserve route and routing latency', async () => {
  for (const announce of [() => { throw new Error('PRIVATE FAILURE'); }, () => new Promise(() => {}), value => { value.model = 'gpt-6-astra'; }]) {
    await harness({ announce }, async call => {
      const started = performance.now();
      const decision = await call('route_execution_subtask', args);
      assert.equal(decision.model, route.model);
      assert.equal(decision.nextAction, 'execute');
      assert.ok(performance.now() - started < 1000);
      assert.equal(decision.presentation.source, 'jev');
    });
  }
  const keepalive = setInterval(() => {}, 100);
  try { assert.equal(await scheduleRouteNotice(route, { announce: () => new Promise(() => {}), timeoutMs: 10 }), false); }
  finally { clearInterval(keepalive); }
});
test('blocked results always include presentation and never announce or dispatch', async () => {
  let calls = 0;
  await harness({ chooseSubtaskRoute: async () => ({ source: 'fallback', nextAction: 'execute', reasonCode: 'catalog_unavailable' }), announce: async () => { calls++; } }, async call => {
    const decision = await call('route_execution_subtask', args);
    assert.equal(decision.presentation.event, 'blocked');
    assert.equal(decision.nextAction, 'stop');
    assert.equal(calls, 0);
  });
});


test('fresh valid blocked review announces once with review scope and no dispatch', async () => {
  const notices = [];
  let context;
  await harness({
    chooseSubtaskRoute: async options => {
      context = options.context;
      return { ...route, source: 'policy', nextAction: 'replan', reasonCode: 'independent_review_unavailable' };
    },
    announce: async value => { notices.push(value); return true; },
  }, async call => {
    const decision = await call('route_execution_subtask', { ...args, structuredContext: { stage: 'review', plannerModel: 'gpt-6-sol', requireIndependentReview: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.plannerModel, 'gpt-6-sol');
    assert.equal(context.requireIndependentReview, true);
    assert.equal(decision.nextAction, 'replan');
    assert.equal(decision.routeId, undefined);
    assert.equal(decision.presentation.scope, 'review');
    assert.equal(decision.presentation.event, 'blocked');
    assert.equal(decision.presentation.source, 'policy');
    assert.match(decision.presentation.text, /暂不派发/);
    assert.equal(notices.length, 1);
    assert.match(notices[0].presentation.text, /没有可用的独立复核模型/);
    assert.deepEqual(decision.notification, { delivery: 'scheduled', userSeen: null });
  });
});
