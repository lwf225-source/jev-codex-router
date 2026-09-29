import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkMigrationChecklist, findHandoffOrder, preserveSyntheticArtifact } from '../scripts/staged-acceptance.mjs';

const good = '步骤：三个服务依次迁移应收、分录、报表。\n依赖：先扩 NUMERIC(18,2) 到 NUMERIC(24,6)。\n双写切换并保持旧版本兼容。\n逐项数据校验，失败回滚。\n验收标准：三个服务对账一致。';
test('checklist requires exact types, all domains, and line cap', () => {
  assert.equal(checkMigrationChecklist(good).lineCount, 5);
  assert.throws(() => checkMigrationChecklist(good.replace('24,6', '21,4')), /targetType/);
  assert.throws(() => checkMigrationChecklist(good.replace('双写', '单写')), /dualWrite/);
  assert.throws(() => checkMigrationChecklist(`${good}\n`.repeat(7)), /limit 30/);
});
const parentId = '01a0cf21-f33f-7cb1-875f-38c46a237c11';
const reviewId = '01a0cf22-9984-7633-8686-8bad5a2e5ef9';
const firstId = '01a0cf23-d99e-75e3-9576-2d4d59b2d11e';
const retryId = '01a0cf25-6c7f-7f63-9cf6-8f7718ac3f79';
const activity = (kind, agentThreadId) => ({ type: 'subAgentActivity', kind, agentThreadId });
const route = (model = 'gpt-6-sol', effort = 'medium') => ({ type: 'mcpToolCall',
  tool: 'route_execution_subtask', status: 'completed', result: { structuredContent: { model, effort, source: 'jev' } } });
const wait = () => ({ type: 'collabAgentToolCall', tool: 'wait', status: 'completed', agentsStates: {} });

// Exact native thread/read indices and child IDs from the single completed real run.
function realV2Fixture() {
  const items = Array.from({ length: 34 }, () => ({ type: 'agentMessage' }));
  items[5] = activity('started', reviewId);
  items[9] = wait();
  items[10] = activity('completed', reviewId);
  items[13] = route();
  items[14] = activity('started', firstId);
  for (const index of [16, 18, 20, 23]) items[index] = wait();
  items[24] = activity('completed', firstId);
  items[29] = route('gpt-6-astra', 'high');
  items[30] = activity('started', retryId);
  items[32] = activity('completed', retryId);
  items[33] = wait();
  return items;
}

test('actual V2 handoff pairs both Jev decisions with their own executors', () => {
  const result = findHandoffOrder(realV2Fixture(), { requireReview: true, parentId });
  assert.equal(result.reviewIndex, 5);
  assert.equal(result.reviewCompletionIndex, 10);
  assert.deepEqual(result.reviewChildIds, [reviewId]);
  assert.deepEqual(result.executions, [
    { routeIndex: 13, executorIndex: 14, executorChildIds: [firstId], decision: { model: 'gpt-6-sol', effort: 'medium', source: 'jev' } },
    { routeIndex: 29, executorIndex: 30, executorChildIds: [retryId], decision: { model: 'gpt-6-astra', effort: 'high', source: 'jev' } },
  ]);
});

test('V2 rejects absent executor, route after executor, and unfinished reviewer', () => {
  let items = realV2Fixture();
  items[30] = { type: 'agentMessage' };
  assert.throws(() => findHandoffOrder(items, { requireReview: true, parentId }), /No native executor spawn.*2/);
  items = realV2Fixture();
  [items[13], items[14]] = [items[14], items[13]];
  assert.throws(() => findHandoffOrder(items, { requireReview: true, parentId }), /No native executor spawn.*1/);
  items = realV2Fixture();
  items[10] = activity('interacted', reviewId);
  assert.throws(() => findHandoffOrder(items, { requireReview: true, parentId }), /review child did not complete/);
  items[15] = activity('completed', reviewId);
  assert.throws(() => findHandoffOrder(items, { requireReview: true, parentId }), /review child did not complete/);
  assert.throws(() => findHandoffOrder([route(), activity('started', firstId)], { requireReview: true }), /review child spawn/);
});

test('parent IDs and duplicate resumed child starts cannot serve as executor spawns', () => {
  const items = realV2Fixture();
  items[0] = activity('started', parentId);
  items[30] = activity('started', firstId);
  assert.throws(() => findHandoffOrder(items, { requireReview: true, parentId }), /No native executor spawn.*2/);
  items[30] = activity('started', parentId);
  assert.throws(() => findHandoffOrder(items, { requireReview: true, parentId }), /No native executor spawn.*2/);
});

test('review is optional and text-only MCP decisions remain correlated', () => {
  const textRoute = route();
  textRoute.result = { content: [{ type: 'text', text: JSON.stringify(textRoute.result.structuredContent) }] };
  const handoff = findHandoffOrder([textRoute, activity('started', firstId)], { parentId });
  assert.equal(handoff.reviewIndex, null);
  assert.equal(handoff.executions[0].decision.model, 'gpt-6-sol');
  assert.throws(() => findHandoffOrder([{ ...textRoute, error: { message: 'failed' } }, activity('started', firstId)]), /No completed route/);
});

test('V1 spawnAgent and spawn_agent require completed agent state for review', () => {
  const review = { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [reviewId], status: 'completed' };
  const execute = { ...review, tool: 'spawn_agent', receiverThreadIds: [firstId] };
  const reviewFinished = { ...wait(), agentsStates: { [reviewId]: { status: 'completed', message: 'done' } } };
  const handoff = findHandoffOrder([review, reviewFinished, route(), execute], { requireReview: true, parentId });
  assert.equal(handoff.reviewCompletionIndex, 1);
  assert.deepEqual(handoff.executions[0].executorChildIds, [firstId]);
  assert.throws(() => findHandoffOrder([review, wait(), route(), execute], { requireReview: true }), /review child did not complete/);
  assert.equal(findHandoffOrder([route(), execute]).executions.length, 1);
});

test('artifact preservation retains exact final bytes and labels missing or unaccepted output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-preservation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratch = join(root, 'scratch');
  const evidence = join(root, 'evidence');
  await mkdir(scratch);
  assert.deepEqual(await preserveSyntheticArtifact(scratch, evidence), { status: 'missing', path: 'migration-checklist.md' });
  const bytes = Buffer.from('最终清单\r\nno trailing newline');
  await writeFile(join(scratch, 'migration-checklist.md'), bytes);
  const result = await preserveSyntheticArtifact(scratch, evidence);
  assert.equal(result.status, 'unaccepted');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.byteLength, bytes.length);
  assert.deepEqual(await readFile(join(evidence, 'migration-checklist.md')), bytes);
  assert.throws(() => checkMigrationChecklist(bytes.toString()), /checklist misses/);
  assert.deepEqual(await readFile(join(evidence, 'migration-checklist.md')), bytes);
});

test('v2 blocked routing decisions never authorize an executor spawn', () => {
 const blocked=route(); blocked.result.structuredContent.nextAction='repair_environment';
 assert.equal(findHandoffOrder([blocked]).executions.length,0);
 assert.throws(()=>findHandoffOrder([blocked,activity('started',firstId)]),/despite nextAction/);
 assert.throws(()=>findHandoffOrder([route(),activity('started',firstId)],{requirePlan:true}),/plan was not registered/);
});
