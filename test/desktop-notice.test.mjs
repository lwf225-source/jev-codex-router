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
  if (process.platform === 'darwin') {
    assert.equal(sent, true);
    assert.equal(observed[1], visible);
  } else assert.equal(sent, false);
});
