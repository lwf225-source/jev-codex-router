import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSettings, getThreadSettings, loadSettings } from '../src/settings.mjs';
import { normalizeRouteRecord } from '../src/audit-log.mjs';
test('routing policy persists and reaches effective task settings', async t => {
 const dataDir=await mkdtemp(join(tmpdir(),'jev-policy-settings-')); t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const routingPolicy={tasks:{writing:['gpt-6-sol']},models:{'gpt-6-sol':{capability:2}}};
 await updateSettings({routingPolicy,timeoutMs:8000},{dataDir});
 assert.deepEqual((await getThreadSettings('parent',{dataDir})).routingPolicy,routingPolicy);
 assert.equal((await loadSettings({dataDir})).timeoutMs,8000);
 await assert.rejects(updateSettings({routingPolicy:{pricing:{fake:1}}},{dataDir}),/policy/i);
});
test('v2 route metadata is whitelisted while text remains excluded', () => {
 const entry=normalizeRouteRecord({threadId:'p',model:'gpt-6-sol',effort:'medium',source:'policy',reasonCode:'failure_environment',taskKind:'code',nextAction:'repair_environment',policyVersion:'2.0',contextComplete:false,prompt:'PRIVATE',constraints:'PRIVATE',reason:'PRIVATE'});
 assert.equal(entry.reasonCode,'failure_environment'); assert.equal(entry.taskKind,'code'); assert.equal(entry.nextAction,'repair_environment'); assert.equal(JSON.stringify(entry).includes('PRIVATE'),false);
});
