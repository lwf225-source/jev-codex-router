import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { inspectSubtasks } from '../src/subtask-history.mjs';
import { createNativeHistoryReader } from '../src/native-history-reader.mjs';

const parentId = 'parent';
const token = `jev_${'a'.repeat(32)}`;
const otherToken = `jev_${'b'.repeat(32)}`;
const activity = (child, kind = 'completed', path = `/root/${child}`) => ({ type: 'subAgentActivity', id: `activity-${child}-${kind}`, kind, agentThreadId: child, agentPath: path });
const spawnItem = (child, values = {}) => ({ type: 'collabAgentToolCall', id: `spawn-${child}`, tool: 'spawnAgent', senderThreadId: parentId, receiverThreadIds: [child], model: 'gpt-6-sol', reasoningEffort: 'medium', agentsStates: {}, ...values });
const thread = (id, values = {}) => ({ id, historyMode: 'paginated', parentThreadId: id === parentId ? null : parentId, model: 'gpt-6-sol', reasoningEffort: 'medium', status: { type: 'notLoaded' }, turns: [], ...values });
const asEntries = (items) => items.map((item) => ({ turnId: 'turn', item }));
const finalItem = (text) => ({ type: 'agentMessage', id: 'answer', phase: 'final_answer', text });
const routeItem = (routingToken, model = 'gpt-6-sol', effort = 'medium', asText = false) => ({
  type: 'mcpToolCall', id: `route-${routingToken}`, server: 'jev-router', tool: 'route_execution_subtask', status: 'completed', error: null,
  result: asText ? { content: [{ type: 'text', text: JSON.stringify({ routingToken, model, effort }) }] } : { structuredContent: { routingToken, model, effort } },
});

function readers({ parentItems = [], threads = {}, items = {}, list } = {}) {
  const calls = [];
  const allThreads = { [parentId]: thread(parentId), ...threads };
  return {
    calls,
    readThread: async (params) => {
      calls.push({ method: 'thread/read', ...params });
      const value = allThreads[params.threadId];
      if (!value) throw new Error('Thread was deleted');
      return { thread: params.includeTurns ? value : { ...value, turns: [] } };
    },
    readItems: async (params) => {
      calls.push({ method: 'thread/items/list', ...params });
      if (list) return list(params);
      return { data: asEntries(params.threadId === parentId ? parentItems : items[params.threadId] || []), nextCursor: null };
    },
  };
}

test('V2 activity reads only direct children, with configured values and no result body by default', async () => {
  const io = readers({ parentItems: [activity('child')], threads: { child: thread('child', { agentNickname: 'Maple' }) } });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.equal(report.tasks.length, 1);
  assert.deepEqual({ ...report.tasks[0] }, {
    childThreadId: 'child', name: 'child', nickname: 'Maple', parentThreadId: parentId, relationship: 'verified',
    status: 'completed', statusSource: 'parentActivity', configuredModel: 'gpt-6-sol', configuredEffort: 'medium',
    modelComparison: 'unknown', effortComparison: 'unknown', suggestedModel: null, suggestedEffort: null,
    configuredMatchesSuggestion: null, suggestionMatchBasis: 'suggested-vs-configured',
  });
  assert.equal(report.coverage.parentHistory, 'complete');
  assert.equal(report.truncated, false);
  assert.equal(io.calls.filter((call) => call.method === 'thread/items/list').length, 1);
  assert.equal(Object.hasOwn(report.tasks[0], 'requestedModel'), false);
  assert.equal(Object.hasOwn(report.tasks[0], 'result'), false);
});

test('V1 spawn captures requested values and reads legacy final turn status and bounded result', async () => {
  const io = readers({ threads: {
    [parentId]: thread(parentId, { historyMode: 'legacy', turns: [{ id: 'p', status: 'completed', itemsView: 'full', items: [spawnItem('child'), finalItem('PARENT SHOULD NOT BE CHILD RESULT')] }] }),
    child: thread('child', { historyMode: 'legacy', model: 'gpt-6-astra', reasoningEffort: 'high', turns: [
      { id: 'c1', status: 'completed', itemsView: 'full', items: [finalItem('old result')] },
      { id: 'c2', status: 'interrupted', itemsView: 'full', items: [finalItem('x'.repeat(2300))] },
    ] }),
  } });
  const report = await inspectSubtasks({ threadId: parentId, includeResults: true, ...io });
  const task = report.tasks[0];
  assert.equal(task.status, 'interrupted');
  assert.equal(task.statusSource, 'latestTurn');
  assert.equal(task.requestedModel, 'gpt-6-sol');
  assert.equal(task.requestedEffort, 'medium');
  assert.equal(task.configuredModel, 'gpt-6-astra');
  assert.equal(task.modelComparison, 'different');
  assert.equal(task.result, 'x'.repeat(2000));
  assert.equal(task.resultTruncated, true);
  assert.equal(io.calls.some((call) => call.method === 'thread/items/list'), false);
});

test('completed legacy turns supply status even when results are not requested', async () => {
  const io = readers({ parentItems: [spawnItem('child')], threads: {
    child: thread('child', { historyMode: 'legacy', turns: [{ id: 'c', status: 'completed', itemsView: 'full', items: [finalItem('private result')] }] }),
  } });
  const task = (await inspectSubtasks({ threadId: parentId, ...io })).tasks[0];
  assert.equal(task.status, 'completed');
  assert.equal(task.statusSource, 'latestTurn');
  assert.equal(JSON.stringify(task).includes('private result'), false);
});

test('active child metadata takes precedence over an old completed parent activity', async () => {
  const io = readers({ parentItems: [activity('child')], threads: { child: thread('child', { status: { type: 'active' } }) } });
  const task = (await inspectSubtasks({ threadId: parentId, ...io })).tasks[0];
  assert.equal(task.status, 'running');
  assert.equal(task.statusSource, 'thread');
});

test('new interaction makes an older completion unknown and does not invent a completed status', async () => {
  const io = readers({ parentItems: [activity('child', 'interacted'), activity('child', 'completed')], threads: { child: thread('child') } });
  const task = (await inspectSubtasks({ threadId: parentId, ...io })).tasks[0];
  assert.equal(task.status, 'unknown');
  assert.equal(task.statusSource, 'unknown');
});

test('parent records, foreign senders and non-direct child references are not returned as children', async () => {
  const io = readers({
    parentItems: [activity(parentId), spawnItem(parentId), spawnItem('foreign', { senderThreadId: 'another-parent' }), activity('grandchild'), activity('unverified')],
    threads: { grandchild: thread('grandchild', { parentThreadId: 'child' }), unverified: { id: 'unverified', model: 'gpt-6-sol', status: { type: 'idle' } } },
  });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.deepEqual(report.tasks, []);
  assert.equal(report.coverage.ignoredParentReferences, 2);
  assert.deepEqual(report.coverage.excludedReferences, [
    { childThreadId: 'grandchild', reason: 'parentThreadIdMismatch' },
    { childThreadId: 'unverified', reason: 'parentThreadIdUnknown' },
  ]);
  assert.equal(io.calls.some((call) => call.threadId === 'foreign'), false);
});

test('missing child is represented with readError and unknown status', async () => {
  const io = readers({ parentItems: [activity('deleted')] });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.equal(report.tasks[0].childThreadId, 'deleted');
  assert.equal(report.tasks[0].status, 'unknown');
  assert.match(report.tasks[0].readError, /deleted/);
});

test('parent pagination is newest-first and capped at five pages with unknown coverage', async () => {
  const io = readers({
    list: (params) => ({ data: asEntries(Array.from({ length: params.limit }, (_, index) => ({ type: 'userMessage', id: `ignored-${index}` }))), nextCursor: String(Number(params.cursor || 0) + 1) }),
  });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.equal(report.coverage.parentPagesRead, 5);
  assert.equal(report.coverage.parentItemsRead, 500);
  assert.equal(report.coverage.parentHistory, 'unknown');
  assert.equal(report.truncated, true);
  assert.equal(io.calls.filter((call) => call.method === 'thread/items/list').every((call) => call.sortDirection === 'desc'), true);
});

test('pagination error preserves observed children and exposes incomplete parent history', async () => {
  const io = readers({ threads: { child: thread('child') }, list: () => ({ data: asEntries([activity('child')]), nextCursor: 'same' }) });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.equal(report.tasks.length, 1);
  assert.equal(report.truncated, true);
  assert.equal(report.coverage.parentHistory, 'unknown');
  assert.match(report.readError, /repeated a cursor/);
});

test('missing pagination completion metadata is unknown rather than assumed complete', async () => {
  const io = readers({ threads: { child: thread('child') }, list: () => ({ data: asEntries([activity('child')]) }) });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.equal(report.tasks.length, 1);
  assert.equal(report.truncated, true);
  assert.equal(report.coverage.parentHistory, 'unknown');
  assert.match(report.readError, /nextCursor/);
});

test('incomplete legacy history and child limit are explicitly reported', async () => {
  const io = readers({ threads: {
    [parentId]: thread(parentId, { historyMode: 'legacy', turns: [{ id: 'p', status: 'completed', itemsView: 'summary', items: [spawnItem('old'), spawnItem('recent')] }] }),
    old: thread('old'), recent: thread('recent'),
  } });
  const report = await inspectSubtasks({ threadId: parentId, limit: 1, ...io });
  assert.equal(report.tasks[0].childThreadId, 'recent');
  assert.equal(report.coverage.omittedByLimit, 1);
  assert.equal(report.coverage.parentHistory, 'unknown');
  assert.equal(report.truncated, true);
  assert.equal(io.calls.some((call) => call.threadId === 'old'), false);
});

test('older servers without pagination can use legacy spawn evidence without asserting parent metadata verification', async () => {
  const parent = { id: parentId, turns: [{ id: 'p', status: 'completed', items: [spawnItem('child')] }] };
  const io = readers({ threads: { [parentId]: parent, child: { id: 'child', model: 'gpt-6-sol', reasoningEffort: 'medium', turns: [] } }, list: () => { throw new Error('Method not found'); } });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.equal(report.tasks[0].relationship, 'spawnRecordOnly');
  assert.equal(report.tasks[0].parentThreadId, parentId);
  assert.equal(report.tasks[0].status, 'unknown');
  assert.equal(report.coverage.historyMode, 'unknown');
});

test('only an exact routing token links a suggestion and the comparison is to current configuration', async () => {
  const io = readers({
    parentItems: [activity('child', 'completed', `/root/${token}`), routeItem(token), routeItem(otherToken, 'gpt-6-astra', 'high', true)],
    threads: { child: thread('child') },
  });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.equal(report.tasks[0].suggestedModel, 'gpt-6-sol');
  assert.equal(report.tasks[0].suggestedEffort, 'medium');
  assert.equal(report.tasks[0].configuredMatchesSuggestion, true);
  assert.equal(report.tasks[0].suggestionMatchBasis, 'suggested-vs-configured');
  assert.deepEqual(report.coverage.unlinkedRoutingTokens, [otherToken]);
  assert.equal(report.coverage.modelEvidence, 'requested-and-configured-only');
});

test('suggestion drift is false, missing effort is unknown, and ordinary nearby tasks are never guessed', async () => {
  const drift = readers({ parentItems: [activity('child', 'completed', `/root/${token}`), routeItem(token)], threads: { child: thread('child', { model: 'gpt-6-astra' }) } });
  assert.equal((await inspectSubtasks({ threadId: parentId, ...drift })).tasks[0].configuredMatchesSuggestion, false);
  const unknown = readers({ parentItems: [activity('child', 'completed', `/root/${token}`), routeItem(token)], threads: { child: thread('child', { reasoningEffort: null }) } });
  assert.equal((await inspectSubtasks({ threadId: parentId, ...unknown })).tasks[0].configuredMatchesSuggestion, null);
  const unlinked = readers({ parentItems: [activity('child'), routeItem(token)], threads: { child: thread('child') } });
  const report = await inspectSubtasks({ threadId: parentId, ...unlinked });
  assert.equal(report.tasks[0].suggestedModel, null);
  assert.deepEqual(report.coverage.unlinkedRoutingTokens, [token]);
});

test('duplicate routing tokens do not claim a suggestion match for either child', async () => {
  const io = readers({ parentItems: [activity('a', 'completed', `/root/${token}`), activity('b', 'completed', `/root/${token}`), routeItem(token)], threads: { a: thread('a'), b: thread('b') } });
  const report = await inspectSubtasks({ threadId: parentId, ...io });
  assert.equal(report.tasks.every((task) => task.configuredMatchesSuggestion === null), true);
  assert.deepEqual(report.coverage.conflictedRoutingTokens, [token]);
  assert.deepEqual(report.coverage.unlinkedRoutingTokens, [token]);
});

test('other MCP servers and errored route results never supply suggestions', async () => {
  for (const invalid of [
    { ...routeItem(token), server: 'unrelated-server' },
    { ...routeItem(token), result: { ...routeItem(token).result, isError: true } },
    { ...routeItem(token), result: { structuredContent: { ...routeItem(token).result.structuredContent, isError: true } } },
  ]) {
    const io = readers({ parentItems: [activity('child', 'completed', `/root/${token}`), invalid], threads: { child: thread('child') } });
    const report = await inspectSubtasks({ threadId: parentId, ...io });
    assert.equal(report.tasks[0].suggestedModel, null);
    assert.deepEqual(report.coverage.unlinkedRoutingTokens, []);
  }
});

test('paginated results use the native final_answer phase and keep task names readable', async () => {
  const io = readers({
    parentItems: [activity('child', 'completed', `/root/${token}`)],
    threads: { child: thread('child', { agentNickname: 'Maple' }) },
    items: { child: [{ type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'later progress' }, finalItem('Finished result')] },
  });
  const task = (await inspectSubtasks({ threadId: parentId, includeResults: true, ...io })).tasks[0];
  assert.equal(task.result, 'Finished result');
  assert.equal(task.name, 'Maple');
});

test('paginated child results are limited and do not mistake commentary for a final result', async () => {
  const io = readers({ threads: { child: thread('child') }, list: ({ threadId, cursor, limit }) => threadId === parentId
    ? { data: asEntries([activity('child')]), nextCursor: null }
    : { data: asEntries(Array.from({ length: limit }, (_, i) => ({ type: 'agentMessage', id: `comment-${i}`, phase: 'commentary', text: 'progress only' }))), nextCursor: cursor ? 'third' : 'second' },
  });
  const task = (await inspectSubtasks({ threadId: parentId, includeResults: true, ...io })).tasks[0];
  assert.equal(task.result, null);
  assert.equal(task.resultCoverage, 'unknown');
  assert.equal(task.resultHistoryTruncated, true);
  assert.equal(io.calls.filter((call) => call.threadId === 'child' && call.method === 'thread/items/list').length, 2);
});

test('unreadable parent and mismatched thread responses fail visibly without discovering unrelated history', async () => {
  const io = readers();
  const report = await inspectSubtasks({ threadId: 'absent', ...io });
  assert.equal(report.truncated, true);
  assert.equal(report.coverage.parentHistory, 'unknown');
  assert.match(report.readError, /deleted/);
  const mismatch = await inspectSubtasks({ threadId: parentId, readThread: async () => ({ thread: thread('wrong') }), readItems: async () => { throw new Error('should not list'); } });
  assert.match(mismatch.readError, /did not match/);
});

test('invalid inputs fail before a native process is started', async () => {
  await assert.rejects(inspectSubtasks({ threadId: '' }), /threadId/);
  await assert.rejects(inspectSubtasks({ threadId: parentId, limit: 10000 }), /limit/);
  await assert.rejects(inspectSubtasks({ threadId: parentId, includeResults: 'true' }), /includeResults/);
  await assert.rejects(inspectSubtasks({ threadId: parentId, readThread: async () => {} }), /both/);
});

function fakeNative(onRequest) {
  const calls = [];
  const commands = [];
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = (signal) => {
    signals.push(signal);
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0);
    return true;
  };
  let buffer = '';
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      calls.push(message);
      queueMicrotask(() => onRequest(message, child));
    }
    done();
  } });
  return { calls, commands, signals, child, spawnImpl: (...args) => { commands.push(args); return child; } };
}
const respond = (child, message, result) => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);

test('native reader launches one direct local process, disables MCP and permits only read RPCs without keychain access', async () => {
  const fake = fakeNative((message, child) => {
    if (message.method === 'initialize') respond(child, message, {});
    if (message.method === 'thread/read') respond(child, message, { thread: thread(message.params.threadId) });
    if (message.method === 'thread/items/list') respond(child, message, { data: [], nextCursor: null });
  });
  const native = await createNativeHistoryReader({ binary: '/local/codex', spawnImpl: fake.spawnImpl });
  await native.readThread({ threadId: parentId, includeTurns: false });
  await native.readItems({ threadId: parentId, limit: 20 });
  native.close();
  native.close();
  assert.equal(fake.commands.length, 1);
  assert.deepEqual(fake.commands[0].slice(0, 2), ['/local/codex', ['app-server', '-c', 'mcp_servers={}']]);
  assert.equal(fake.commands[0][2].shell, undefined);
  assert.equal(fake.commands[0][2].env.CODEX_CLI_PATH, '');
  assert.deepEqual(fake.calls.map((call) => call.method), ['initialize', 'initialized', 'thread/read', 'thread/items/list']);
  assert.equal(fake.calls[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(fake.signals, ['SIGTERM']);
  assert.equal(fake.child.stdin.writableEnded, true);
});

test('native RPC errors remain readable and close rejects any pending read', async () => {
  const fake = fakeNative((message, child) => {
    if (message.method === 'initialize') respond(child, message, {});
    if (message.method === 'thread/read') child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'Thread not found' } })}\n`);
  });
  const native = await createNativeHistoryReader({ spawnImpl: fake.spawnImpl });
  await assert.rejects(native.readThread({ threadId: 'missing' }), /Thread not found/);
  const pending = native.readItems({ threadId: parentId });
  native.close();
  await assert.rejects(pending, /closed/);
});

test('native timeout and premature exit reject promptly and clean up the process', async () => {
  const silent = fakeNative(() => {});
  await assert.rejects(createNativeHistoryReader({ spawnImpl: silent.spawnImpl, timeoutMs: 10 }), /timed out/);
  assert.deepEqual(silent.signals, ['SIGTERM']);
  const exiting = fakeNative((_message, child) => { child.exitCode = 1; child.emit('exit', 1); });
  await assert.rejects(createNativeHistoryReader({ spawnImpl: exiting.spawnImpl }), /exited/);
  assert.equal(exiting.child.stdin.writableEnded, true);
});

test('native start failure and oversized responses are bounded and cleaned up', async () => {
  const broken = fakeNative((_message, child) => child.emit('error', new Error('ENOENT')));
  await assert.rejects(createNativeHistoryReader({ spawnImpl: broken.spawnImpl }), /could not start/);
  const oversized = fakeNative((_message, child) => child.stdout.write('x'.repeat(129)));
  await assert.rejects(createNativeHistoryReader({ spawnImpl: oversized.spawnImpl, maxResponseBytes: 128 }), /byte limit/);
  assert.deepEqual(oversized.signals, ['SIGTERM']);
});
