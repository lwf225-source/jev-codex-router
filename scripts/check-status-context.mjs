#!/usr/bin/env node
// Eight fixed synthetic cases only. Never accepts or reads user/project prompts.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chooseRoute } from '../src/route-core.mjs';
import { buildRoutingContext, routingIntent } from '../src/routing-context.mjs';
import { TASK_KINDS } from '../src/routing-policy.mjs';

const live = process.argv.includes('--live');
const caseId = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
assert.ok(process.argv.slice(2).every(arg => arg === '--live' || arg === `--case=${caseId}`), 'Only --live and --case=<fixed fixture id> are supported.');
const statusPrompt = '还有什么优化没做完？只汇报当前状态，不执行改动。';
const snapshot = {
  goal: 'Report the current status snapshot only.',
  constraints: ['Report status only; do not modify, publish, or execute anything.'],
  lastResult: 'Implementation and tests are complete. Desktop UI acceptance and merge remain pending.',
};
const long = { ...snapshot, summary: 'Historical completed development work. '.repeat(90) };
const prior = { model: 'gpt-6-astra', effort: 'high', taskKind: 'architecture', phase: 'plan_execute', highRisk: true, needsSecondOpinion: true, capabilityFloor: 3 };
const fixtures = [
  { id: 'status-short', prompt: statusPrompt, context: snapshot, direct: true },
  { id: 'status-long-1', prompt: statusPrompt, context: long, direct: true },
  { id: 'status-long-2', prompt: statusPrompt, context: long, direct: true },
  { id: 'status-missing-constraints', prompt: statusPrompt, context: { ...long, constraints: ['Required constraint. '.repeat(45)] }, incomplete: true },
  { id: 'status-unread-attachment', prompt: statusPrompt, context: { ...long, attachmentStatus: 'unreadable', inputModalities: ['image'] }, incomplete: true },
  { id: 'execution-continuation', prompt: 'Continue the remaining production rollout.', context: { ...long, continuation: true, previousRoute: prior }, incomplete: true },
  { id: 'mixed-status-action', prompt: 'What is the status? Then deploy the remaining changes.', context: long, incomplete: true },
  { id: 'quoted-status', prompt: 'Translate this sentence: "What is the status?"', context: long, incomplete: true },
];
assert.ok(!caseId || fixtures.some(fixture => fixture.id === caseId), 'Unknown fixed fixture id');
const selectedFixtures = caseId ? fixtures.filter(fixture => fixture.id === caseId) : fixtures;
const models = ['astra', 'sol', 'luna'].map(f => ({ id: `gpt-6-${f}`, model: `gpt-6-${f}`, supportedReasoningEfforts: f === 'astra' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'] }));
const mockFetch = async () => ({ ok: true, json: async () => ({ answers: {
  task_kind: { type: 'choice', choice: 'writing', confidence: 0.97, probabilities: Object.fromEntries(TASK_KINDS.map(k => [k, k === 'writing' ? 1 : 0])) },
  complexity: { type: 'score', score: 0.03, confidence: 0.97 },
  high_consequence: { type: 'noul', noul: 0.01 }, underspecified: { type: 'noul', noul: 0.01 },
  staged_execution: { type: 'noul', noul: 0.01 }, second_opinion: { type: 'noul', noul: 0.01 },
} }) });
let client, dataDir;
const results = [];
let failures = 0;
try {
  if (live) {
    dataDir = await mkdtemp(join(tmpdir(), 'jev-status-check-'));
    client = new Client({ name: 'jev-synthetic-status-check', version: '0.2.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve(import.meta.dirname, '..', 'bin', 'jev-router-mcp.mjs')],
      env: { ...process.env, JEV_ROUTER_DATA_DIR: dataDir } }));
    // Fresh isolated defaults: no global enablement/timeout changes, no task run.
  }
  for (const fixture of selectedFixtures) {
    const context = { ...fixture.context, attachmentState: fixture.context.attachmentStatus };
    const scoped = buildRoutingContext(context, { statusOnly: routingIntent(fixture.prompt) === 'status' });
    const start = performance.now();
    let result, timer;
    try {
      result = await Promise.race([
        live ? client.callTool({ name: 'route_preview', arguments: { prompt: fixture.prompt, context: fixture.context } }).then(response => {
          if (response.isError) return { source: 'error', reasonCode: 'tool_error' };
          return response.structuredContent;
        }) : chooseRoute({ prompt: fixture.prompt, context, models, apiKey: 'synthetic-test-only', fetchImpl: mockFetch }),
        new Promise(resolve => { timer = setTimeout(() => resolve({ source: 'error', reasonCode: 'harness_timeout' }), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
    const passed = Boolean(result?.model) && (fixture.direct ? result.phase === 'direct' && result.contextComplete === true : !fixture.incomplete || result.contextComplete === false);
    if (!passed) failures++;
    results.push({ id: fixture.id, wallMs: Math.round(performance.now() - start),
      contextTextChars: ['goal', 'constraints', 'failureSummary', 'acceptanceCriteria', 'dependencies', 'stage', 'lastResult', 'summary', 'progress'].reduce((n, key) => n + (scoped[key]?.length || 0), 0),
      historyTruncated: scoped.historyTruncated, currentContextComplete: scoped.currentContextComplete,
      model: result?.model, effort: result?.effort, source: result?.source, phase: result?.phase,
      reasonCode: result?.reasonCode, routeMs: result?.elapsedMs, contextComplete: result?.contextComplete,
      complexity: result?.complexity, confidence: result?.confidence, highRisk: result?.highRisk, passed });
  }
  const times = results.map(x => x.wallMs).sort((a, b) => a - b);
  process.stdout.write(JSON.stringify({ mode: live ? 'live-isolated-mcp' : 'synthetic-stub', defaultDeadlineMs: 2000,
    count: results.length, passed: results.length - failures,
    jevCount: results.filter(x => x.source === 'jev').length,
    timeoutCount: results.filter(x => ['timeout', 'harness_timeout'].includes(x.reasonCode)).length,
    wallMs: { min: times[0], median: (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2, max: times.at(-1) }, results }, null, 2) + '\n');
  if (failures) process.exitCode = 1;
} finally {
  await client?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
