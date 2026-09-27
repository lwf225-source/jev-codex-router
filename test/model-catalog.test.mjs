import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { listNativeCodexModels } from '../src/model-catalog.mjs';

function fixture(reply) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin.on('data', bytes => { for (const line of String(bytes).trim().split('\n')) { const message = JSON.parse(line); const result = reply(message); if (result) queueMicrotask(() => child.stdout.write(JSON.stringify({id:message.id,result})+'\n')); } });
  return child;
}
test('catalog disables other MCP servers and retains native descriptions', async () => {
  const child = fixture(m => m.method === 'initialize' ? {} : m.method === 'model/list' ? {data:[{id:'gpt-6-sol',description:'native description',hidden:false}]} : null);
  const models = await listNativeCodexModels({spawnImpl:(_binary,args)=>{assert.deepEqual(args,['app-server','-c','mcp_servers={}']); return child;}});
  assert.equal(models[0].description,'native description'); assert.equal(child.killed,true);
});
test('catalog abort cancels a stalled native query', async () => {
  const child=fixture(()=>null); const controller=new AbortController();
  const promise=listNativeCodexModels({signal:controller.signal,spawnImpl:()=>child});
  controller.abort(); await assert.rejects(promise,/cancelled/); assert.equal(child.killed,true);
});
test('catalog premature exit returns failure instead of waiting for its deadline', async () => {
  const child=fixture(()=>null);
  const promise=listNativeCodexModels({spawnImpl:()=>child});
  child.emit('exit',1); await assert.rejects(promise,/exited/); assert.equal(child.killed,true);
});

import { resolveNativeCodexBinary } from '../src/native-binary.mjs';
test('native binary resolution supports current bundle and explicit override', () => {
 assert.equal(resolveNativeCodexBinary({env:{CODEX_JEV_REAL_CLI:'/configured/codex'},exists:()=>false}),'/configured/codex');
 assert.equal(resolveNativeCodexBinary({env:{},exists:path=>path==='/Applications/ChatGPT.app/Contents/Resources/codex'}),'/Applications/ChatGPT.app/Contents/Resources/codex');
 assert.match(resolveNativeCodexBinary({env:{},exists:path=>path.includes('codex-cli/bin')}),/codex-cli\/bin\/codex$/);
});
