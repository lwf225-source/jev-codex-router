import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createQueuedStore } from '../src/queued-submissions.mjs';

async function temporary(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jev-queue-test-'));
  try { await run(dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

function textInput(text) { return [{ type: 'text', text, text_elements: [] }]; }

test('queued submissions support edit, pagination, reorder, deletion, and restart', () => temporary(async dataDir => {
  const queue = createQueuedStore({ dataDir });
  const a = await queue.add({ threadId: 'task-1', input: textInput('first'), clientUserMessageId: 'user-a' });
  const b = await queue.add({ threadId: 'task-1', input: textInput('second'), clientUserMessageId: 'user-b' });
  const other = await queue.add({ threadId: 'task-2', input: textInput('other'), clientUserMessageId: 'user-c' });
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await queue.list('task-1', { limit: 1 })).data, [a]);
  const firstPage = await queue.list('task-1', { limit: 1 });
  assert.deepEqual(await queue.list('task-1', { limit: 1, cursor: firstPage.nextCursor }), { data: [b], nextCursor: null });
  const changed = await queue.update('task-1', b.id, textInput('edited'));
  assert.equal(changed.input[0].text, 'edited');
  await queue.reorder('task-1', [b.id, a.id]);
  assert.equal((await queue.peek('task-1')).id, b.id);
  assert.equal((await createQueuedStore({ dataDir }).peek('task-1', a.id)).clientUserMessageId, 'user-a');
  assert.deepEqual((await queue.list('task-2')).data, [other]);
  assert.deepEqual(await queue.removeOnStarted('task-1', b.id), { deleted: true });
  assert.deepEqual(await queue.delete('task-1', b.id), { deleted: false });
  assert.deepEqual((await createQueuedStore({ dataDir }).list('task-1')).data, [a]);
  assert.deepEqual(await queue.delete('task-1', a.id), { deleted: true });
  assert.equal(await queue.peek('task-1'), null);
  assert.equal((await stat(join(dataDir, 'queued-submissions.json'))).mode & 0o777, 0o600);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  assert.equal((await readFile(join(dataDir, 'queued-submissions.json'), 'utf8')).includes('edited'), false);
  assert.equal((await readdir(dataDir)).includes('routes.json'), false);
}));

test('invalid identifiers, inputs, cursors, and reorderings leave the queue intact', () => temporary(async dataDir => {
  const queue = createQueuedStore({ dataDir });
  const item = await queue.add({ threadId: '__proto__', input: textInput('safe'), clientUserMessageId: 'msg' });
  await assert.rejects(queue.add({ threadId: 'bad\nname', input: textInput('x'), clientUserMessageId: 'msg' }), TypeError);
  await assert.rejects(queue.add({ threadId: 'task', input: [], clientUserMessageId: 'msg' }), TypeError);
  await assert.rejects(queue.add({ threadId: 'task', input: textInput('x'), clientUserMessageId: '' }), TypeError);
  await assert.rejects(queue.list('__proto__', { cursor: 'bad!' }), TypeError);
  await assert.rejects(queue.reorder('__proto__', [item.id, item.id]), TypeError);
  await assert.rejects(queue.update('__proto__', 'missing', textInput('x')), /not found/);
  assert.deepEqual((await queue.list('__proto__')).data, [item]);
}));

test('cross-process writes share the data lock and preserve all queued entries', () => temporary(async dataDir => {
  const moduleUrl = new URL('../src/queued-submissions.mjs', import.meta.url).href;
  const script = `import { createQueuedStore } from ${JSON.stringify(moduleUrl)}; const q=createQueuedStore({dataDir:process.argv[1]}); await Promise.all(Array.from({length:12},(_,i)=>q.add({threadId:'shared',input:[{type:'text',text:String(i),text_elements:[]}],clientUserMessageId:process.argv[2]+'-'+i})));`;
  const run = label => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir, label], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run('a'), run('b')]);
  const entries = (await createQueuedStore({ dataDir }).list('shared', { limit: 100 })).data;
  assert.equal(entries.length, 24);
  assert.equal(new Set(entries.map(item => item.clientUserMessageId)).size, 24);
  const raw = await readFile(join(dataDir, 'queued-submissions.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
}));

test('unconfirmed launch state survives restart and prevents edit or deletion', () => temporary(async dataDir => {
  const queue = createQueuedStore({ dataDir });
  const item = await queue.add({ threadId: 'unknown', input: textInput('side effect'), clientUserMessageId: 'client-side-effect' });
  const marked = await queue.markStarting('unknown', item.id, item.input);
  assert.equal(marked.marked, true);
  const restarted = createQueuedStore({ dataDir });
  const state = await restarted.getLaunchState('unknown', item.id);
  assert.equal(state.state, 'unknown');
  assert.equal(state.clientUserMessageId, 'client-side-effect');
  assert.equal((await restarted.listLaunchStates('unknown')).length, 1);
  assert.deepEqual((await restarted.list('unknown')).data, [item]);
  await assert.rejects(restarted.update('unknown', item.id, textInput('changed')), /unconfirmed/);
  await assert.rejects(restarted.delete('unknown', item.id), /unconfirmed/);
  await assert.rejects(restarted.markStarting('unknown', item.id, item.input), /unconfirmed/);
  assert.equal(await restarted.clearStarting('unknown', item.id, 'wrong'), false);
  assert.equal(await restarted.clearStarting('unknown', item.id, marked.attemptId), true);
  assert.equal(await restarted.getLaunchState('unknown', item.id), null);
  assert.deepEqual(await restarted.delete('unknown', item.id), { deleted: true });
}));
