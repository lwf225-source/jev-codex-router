import test from 'node:test';
import assert from 'node:assert/strict';
import { announceRoute, renderRouteNotice } from '../src/desktop-notice.mjs';

test('route notification contains bounded configuration and never requires prompt text', async () => {
  const route = { model: 'gpt-6-luna', effort: 'low', source: 'jev', reason: '任务范围很小', prompt: 'private prompt' };
  const visible = renderRouteNotice(route);
  assert.match(visible, /gpt-6-luna \/ low/);
  assert.equal(visible.includes('private prompt'), false);
  let observed;
  const sent = await announceRoute(route, { execImpl: async (_cmd, args) => { observed = args; } });
  if (process.platform === 'darwin' && process.env.JEV_ROUTER_DISABLE_NOTIFICATIONS !== '1') {
    assert.equal(sent, true);
    assert.equal(observed[1], visible);
  } else assert.equal(sent, false);
});


test('notice ignores arbitrary reasons and untrusted presentation text while retaining safe event metadata', () => {
  const route = { model: 'gpt-6-sol', effort: 'medium', source: 'jev', nextAction: 'execute', reason: 'PRIVATE', presentation: { text: 'PRIVATE', scope: 'continuation', event: 'retained' } };
  assert.match(renderRouteNotice(route), /保留当前配置，未重新询问 Jev/);
  assert.doesNotMatch(renderRouteNotice(route), /PRIVATE/);
  route.presentation = { event: 'reselected', sameConfiguration: true };
  assert.match(renderRouteNotice(route), /已重新判断，配置与上次相同/);
  delete route.nextAction;
  route.presentation = { scope: 'review', event: 'blocked', nextAction: 'replan' };
  assert.match(renderRouteNotice(route), /先调整计划，暂不派发/);
});
