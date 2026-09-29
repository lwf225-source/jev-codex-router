import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutePresentation } from '../src/route-presentation.mjs';
import { normalizeRouteRecord } from '../src/audit-log.mjs';
const route = { model: 'gpt-6-sol', effort: 'medium', source: 'jev', nextAction: 'execute' };

test('source labels faithfully identify fresh, manual, explicit, fallback, policy and disabled', () => {
  for (const [source, label] of Object.entries({ jev: 'Jev 本次判断', manual: '手动选择', explicit: '本轮明确指定', fallback: '备用配置', policy: '本地策略', disabled: '自动路由关闭' })) {
    const value = buildRoutePresentation({ ...route, source });
    assert.equal(value.source, source);
    assert.match(value.text, new RegExp(label));
    assert.equal(value.event, source === 'jev' ? 'selected' : source);
  }
});
test('fresh same-configuration selection, reuse and continuation are different facts', () => {
  const same = buildRoutePresentation(route, { previousModel: route.model, previousEffort: route.effort });
  assert.equal(same.event, 'reselected');
  assert.equal(same.sameConfiguration, true);
  assert.match(same.text, /已重新判断，配置与上次相同/);
  const reused = buildRoutePresentation({ ...route, reused: true });
  assert.equal(reused.event, 'reused');
  assert.match(reused.text, /复用已有决定.*未重新询问/);
  for (const event of ['retained', 'continuation']) {
    const current = buildRoutePresentation(route, { scope: 'continuation', event });
    assert.equal(current.event, event);
    assert.match(current.text, /保留当前配置，未重新询问/);
  }
});
test('blocked and invalid configurations cannot look executable', () => {
  for (const bad of [{}, { model: route.model }, { effort: route.effort }, { model: 'PRIVATE', effort: 'PRIVATE' }]) {
    const value = buildRoutePresentation({ source: 'jev', nextAction: 'execute', ...bad });
    assert.equal(value.nextAction, 'stop');
    assert.equal(value.event, 'blocked');
    assert.match(value.text, /缺少有效模型或推理强度.*停止派发/);
    assert.doesNotMatch(value.text, /可执行/);
  }
  assert.equal(buildRoutePresentation({ ...route, nextAction: 'needs_context' }).event, 'blocked');
  assert.equal(buildRoutePresentation({ nextAction: 'needs_context' }).nextAction, 'needs_context');
});
test('presentation and audit retain enum metadata only, never arbitrary reasons or labels', () => {
  const input = { ...route, threadId: 'test', reason: 'PRIVATE', reasonCode: 'PRIVATE', task: 'PRIVATE', prompt: 'PRIVATE', presentation: { text: 'PRIVATE' }, routeScope: 'review', selectionEvent: 'reselected', sameConfiguration: true };
  const value = buildRoutePresentation(input, { scope: 'PRIVATE', event: 'PRIVATE' });
  assert.equal(value.scope, 'main');
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  const record = normalizeRouteRecord(input);
  assert.deepEqual([record.routeScope, record.selectionEvent, record.sameConfiguration], ['review', 'reselected', true]);
  assert.equal(JSON.stringify(record).includes('PRIVATE'), false);
  const bad = normalizeRouteRecord({ ...input, routeScope: 'PRIVATE', selectionEvent: 'PRIVATE' });
  assert.equal(bad.routeScope, undefined);
  assert.equal(bad.selectionEvent, undefined);
});


test('blocked reused routes never claim a new Jev judgment and legacy valid pairs remain executable', () => {
  for (const nextAction of ['stop', 'needs_context']) {
    const value = buildRoutePresentation({ ...route, nextAction, reused: true, reasonCode: 'judgment' });
    assert.equal(value.event, 'blocked');
    assert.match(value.text, /复用已有决定.*未重新询问 Jev/);
    assert.doesNotMatch(value.text, /本次判断|已完成本次判断/);
  }
  assert.equal(buildRoutePresentation({ ...route, nextAction: undefined }).nextAction, 'execute');
});
