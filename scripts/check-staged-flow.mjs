#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolveNativeCodexBinary } from '../src/native-binary.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { homedir } from 'node:os';
import { createAppServerProxy } from '../src/app-server-proxy.mjs';
import { chooseRoute } from '../src/route-core.mjs';
import { readTypeSafeKey } from '../src/credential.mjs';
import { updateSettings } from '../src/settings.mjs';
import { listRecentRoutes } from '../src/audit-log.mjs';
import { checkMigrationChecklist, findHandoffOrder, preserveSyntheticArtifact } from './staged-acceptance.mjs';
import { inspectSubtasks } from '../src/subtask-history.mjs';
import { reconcileExecutionPlan } from '../src/execution-plan.mjs';

const root = resolve(import.meta.dirname, '..');
const fixtureRequiresReview = process.argv.includes('--review');
const liveInitialRoute = process.argv.includes('--live');
const evidenceDir = join(root, 'evaluation', `synthetic-complex-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const maxRunMs = liveInitialRoute ? 600000 : fixtureRequiresReview ? 360000 : 240000;
const startedAt = Date.now();
const testTimeout = Number(process.argv.find(arg => arg.startsWith('--timeout-ms='))?.split('=')[1] || 2000);
assert.ok(Number.isInteger(testTimeout) && testTimeout >= 100 && testTimeout <= 10000);
let scratch;
let workspace;
let routeDataDir;
let native;
let proxy;
let child;
let lines;
let exitPromise;
let createdThreadId;
let activeTurnId;
let initialDecision;
let artifactPreservationFailed = false;
let outcome = 'setup_failure';
let evidence = { kind: 'synthetic-staged-flow', startedAt: new Date(startedAt).toISOString(), liveInitialRoute, maxRunMs };
const nativeCodex = resolveNativeCodexBinary();
const scopedConfig = [];
// Explicitly forward the isolated metadata directory to the MCP process.
const ingress = new PassThrough();
const egress = new PassThrough();
const fixtureRoute = async ({ models }) => {
    const planner = models.find(model => (model.model || model.id) === 'gpt-6-astra');
    assert.ok(planner, 'Fixture requires an available Astra planner');
    return { model: planner.model || planner.id, effort: 'high', phase: 'plan_execute', needsSecondOpinion: fixtureRequiresReview,
      ...(fixtureRequiresReview ? { verifierModel: 'gpt-6-sol', verifierEffort: 'high' } : {}),
      source: 'jev', reason: 'Integration fixture: planning branch; executor selection uses real Jev' };
  };
let sequence = 1;
let stderr = '';
const observedActivity = [];
const pending = new Map();
const completed = new Map();
function onLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (Object.hasOwn(message, 'id') && message.method) {
    // Bidirectional requests must never be left waiting silently by this harness.
    process.stdout.write(`${JSON.stringify({ serverRequest: message.method })}\n`);
    const reply = message.method === 'currentTime/read'
      ? { id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }
      : { id: message.id, error: { code: -32601, message: 'This isolated test does not handle interactive requests' } };
    child.stdin.write(`${JSON.stringify(reply)}\n`);
    return;
  }
  if (Object.hasOwn(message, 'id') && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  }
  if (message.method === 'turn/completed') {
    const turnId = message.params?.turn?.id;
    if (turnId && typeof completed.get(turnId) === 'function') completed.get(turnId)(message.params.turn);
    else if (turnId) completed.set(turnId, message.params.turn);
    if (turnId === activeTurnId) activeTurnId = null;
  }
  if (message.method === 'item/started' || message.method === 'item/completed') {
    const item = message.params?.item;
    if (item && ['mcpToolCall', 'subAgentActivity', 'collabAgentToolCall'].includes(item.type)) {
      const event = { type: item.type, tool: item.tool, status: item.status, kind: item.kind, agentThreadId: item.agentThreadId, receiverThreadIds: item.receiverThreadIds, error: item.error };
      observedActivity.push(event);
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  }
}

function rpc(method, params, timeoutMs = 20000) {
  return new Promise((resolveResult, rejectResult) => {
    const id = sequence++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectResult(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, message => {
      clearTimeout(timer);
      if (message.error) rejectResult(new Error(`${method} failed: ${message.error.message || 'unknown error'}`));
      else resolveResult(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function waitTurn(turnId, timeoutMs = maxRunMs) {
  return new Promise((resolveResult, rejectResult) => {
    const prior = completed.get(turnId);
    if (prior && typeof prior !== 'function') { resolveResult(prior); return; }
    const timer = setTimeout(() => rejectResult(new Error(`staged parent turn timed out after ${timeoutMs} ms`)), timeoutMs);
    completed.set(turnId, turn => { clearTimeout(timer); resolveResult(turn); });
  });
}

async function ownTurnContexts(threadId) {
  const roots = [join(homedir(), '.codex', 'sessions'), join(homedir(), '.codex', 'archived_sessions')];
  for (const dir of roots) {
    const names = await readdir(dir, { recursive: true }).catch(() => []);
    const own = names.find(name => name.endsWith(`${threadId}.jsonl`));
    if (!own) continue;
    const raw = await readFile(join(dir, own), 'utf8');
    return raw.split('\n').flatMap(line => {
      try { const item = JSON.parse(line); return item.type === 'turn_context'
        ? [{ model: item.payload?.model, effort: item.payload?.effort || item.payload?.collaboration_mode?.settings?.reasoning_effort,
            turnId: item.payload?.turn_id, rootTurnId: item.payload?.root_turn_id }] : []; }
      catch { return []; }
    });
  }
  return [];
}

try {
  scratch = await mkdtemp(join(root, '.jev-stage-check-'));
  workspace = join(scratch, 'workspace');
  routeDataDir = join(scratch, 'router-state');
  await mkdir(workspace);
  const apiKey = await readTypeSafeKey();
  assert.ok(apiKey, 'TypeSafe credential is unavailable');
  const configured = JSON.parse((await promisify(execFile)(nativeCodex, ['mcp', 'list', '--json'], { timeout: 10000 })).stdout);
  assert.ok(Array.isArray(configured), 'Cannot establish MCP isolation');
  const disabled = configured.filter(server => server.name !== 'jev-router').map(server => {
    assert.equal(typeof server.name, 'string');
    return server.transport?.type === 'streamable_http'
      ? `${JSON.stringify(server.name)}={url="http://127.0.0.1:1/disabled",enabled=false}`
      : `${JSON.stringify(server.name)}={command=${JSON.stringify(process.execPath)},args=[],enabled=false}`;
  });
  const tools = ['register_execution_plan', 'route_execution_subtask', 'record_execution_acceptance', 'subtask_history']
    .map(name => `${name}={approval_mode="approve"}`).join(',');
  const isolatedJev = `"jev-router"={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([join(root, 'bin', 'jev-router-mcp.mjs')])},enabled=true,env={JEV_ROUTER_DATA_DIR=${JSON.stringify(routeDataDir)}},tools={${tools}}}`;
  scopedConfig.push('-c', `mcp_servers={${[...disabled, isolatedJev].join(',')}}`);
  native = spawn(nativeCodex, [...scopedConfig, 'app-server'], {
    cwd: root,
    env: { ...process.env, CODEX_CLI_PATH: '', TYPESAFE_API_KEY: apiKey, CODEX_JEV_REAL_CLI: nativeCodex, JEV_ROUTER_DATA_DIR: routeDataDir, JEV_ROUTER_DISABLE_NOTIFICATIONS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  exitPromise = new Promise(resolveExit => { native.once('exit', (code, signal) => resolveExit({ code, signal })); native.once('error', error => resolveExit({ error: error.message })); });
  proxy = createAppServerProxy({ child: native, clientInput: ingress, clientOutput: egress, dataDir: routeDataDir,
    credential: async () => apiKey, route: async args => {
      const decision = await (liveInitialRoute ? chooseRoute : fixtureRoute)(args);
      initialDecision ??= decision;
      evidence.initialDecision = initialDecision;
      return decision;
    },
  });
  child = { stdin: ingress, stdout: egress, stderr: native.stderr,
    get killed() { return native.killed; }, kill: signal => native.kill(signal) };
  lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString()}`.slice(-4000); });
  lines.on('line', onLine);
  native.on('error', error => {
    for (const settle of pending.values()) settle({ error: { message: `Native startup failed: ${error.code || 'unknown'}` } });
    pending.clear();
  });
  native.once('exit', code => {
    for (const settle of pending.values()) settle({ error: { message: `Native process exited (${code})` } });
    pending.clear();
  });
  await updateSettings({ enabled: true, timeoutMs: testTimeout }, { dataDir: routeDataDir });
  await rpc('initialize', { clientInfo: { name: 'jev_staged_flow_check', title: 'Jev Staged Flow Check', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const catalog = (await rpc('model/list', { limit: 100, includeHidden: false })).data || [];
  assert.ok(catalog.length, 'Codex returned no available models');
  const start = await rpc('thread/start', {
    cwd: workspace, ephemeral: false, sandbox: 'workspace-write', approvalPolicy: 'never',
    model: catalog.find(model => /sol/i.test(model.model || model.id))?.model || catalog[0].model || catalog[0].id,
  });
  const threadId = start?.thread?.id;
  assert.ok(threadId, 'thread/start returned no id');
  createdThreadId = threadId;
  const turn = await rpc('turn/start', {
    threadId,
    input: [{ type: 'text', text: liveInitialRoute
      ? '制定生产数据库大表的跨服务金额精度迁移方案，涉及三个服务、双写切换、旧版本兼容、逐项数据校验、失败回滚和多服务兼容。将金额字段从 NUMERIC(18,2) 扩到 NUMERIC(24,6)。在当前隔离测试目录创建 migration-checklist.md，最多30行，列出具体执行步骤、依赖与验收标准。系统和数据是虚构的；不连接服务、不查外部资料，只创建这个文件。'
      : '为虚构记账产品设计并交付跨三个服务的金额精度迁移验收清单，写入当前目录 migration-checklist.md，最多30行。三个服务分别生成应收、记录分录、汇总报表；金额从 NUMERIC(18,2) 扩到 NUMERIC(24,6)，须覆盖旧版本兼容、双写切换、数据校验、依赖和回滚。仅使用给出的虚构背景，不查外部资料；只创建这个文件。' }],
  });
  assert.ok(turn?.turn?.id, 'turn/start returned no turn id');
  activeTurnId = turn.turn.id;
  const finished = await waitTurn(turn.turn.id, Math.max(1000, maxRunMs - (Date.now() - startedAt)));
  evidence.artifact = await preserveSyntheticArtifact(workspace, evidenceDir);
  evidence = { ...evidence, outcome: 'unaccepted', threadId, parentTurnId: turn.turn.id };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  assert.equal(finished?.status, 'completed', 'staged parent turn did not complete');

  const routes = await listRecentRoutes({ threadId, dataDir: routeDataDir });
  const planningRoute = routes.find(route => route.phase === 'planning');
  const executionRoutes = routes.filter(route => route.phase === 'execution').reverse();
  const executionRoute = executionRoutes.at(-1);
  assert.ok(initialDecision, 'Initial routing decision was not captured');
  const requireReview = initialDecision.needsSecondOpinion === true;
  evidence.initialDecision = initialDecision;
  const decisions = routes.map(({ model, effort, phase, source, reasonCode, elapsedMs }) => ({ model, effort, phase, source, reasonCode, elapsedMs }));
  const parent = await rpc('thread/read', { threadId, includeTurns: true });
  const items = (parent?.thread?.turns || []).flatMap(item => item.items || []);
  const activity = items.map(item => ({
    type: item.type,
    tool: item.tool || item.name || null,
    status: item.status || null,
    kind: item.kind || null,
    receiverThreadIds: item.receiverThreadIds || undefined,
    agentThreadId: item.agentThreadId || undefined,
  })).filter(item => ['collabAgentToolCall', 'subAgentActivity', 'mcpToolCall', 'functionCall'].includes(item.type));
  assert.ok(planningRoute, `Jev planning route was not logged: ${JSON.stringify(decisions)}`);
  if (liveInitialRoute) assert.equal(planningRoute.source, 'jev', 'Initial complex route fell back rather than receiving a live Jev judgment');
  const parentContexts = await ownTurnContexts(threadId);
  assert.ok(parentContexts.some(context => context.turnId === turn.turn.id && context.model === planningRoute.model && context.effort === planningRoute.effort),
    'Parent turn_context did not confirm Jev-selected planning model and effort');
  assert.ok(executionRoute, `Jev execution subtask route was not logged: ${JSON.stringify({ decisions, activity })}`);
  assert.equal(executionRoute.source, 'jev', 'Execution route fell back rather than receiving a live Jev judgment');
  assert.notEqual(evidence.artifact.status, 'missing', 'Synthetic task did not create migration-checklist.md');
  const executionHistory = await inspectSubtasks({ threadId });
  const executionPlan = await reconcileExecutionPlan(threadId, executionHistory, { dataDir: routeDataDir });
  evidence.executionPlan = executionPlan;
  assert.equal(executionPlan.allVerified, true, 'Registered plan has missing, unmatched, incomplete, or unaccepted execution units');
  const checklist = await readFile(join(evidenceDir, 'migration-checklist.md'), 'utf8');
  const contentChecks = checkMigrationChecklist(checklist);
  const scratchFiles = await readdir(workspace);
  assert.deepEqual(scratchFiles.filter(name => name !== 'migration-checklist.md'), [], 'synthetic task created unexpected files');
  const handoff = findHandoffOrder(items, { requireReview, requirePlan: true, parentId: threadId });
  const childIds = [...new Set(items.flatMap(item => item.type === 'subAgentActivity' && item.agentThreadId
    ? [item.agentThreadId]
    : item.type === 'collabAgentToolCall' && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []))];
  assert.ok(childIds.length, 'The staged planner did not create a native subagent');

  let matchingChild = null;
  let reviewChild = null;
  const childEvidence = [];
  for (const childThreadId of childIds) {
    if (childThreadId === threadId) continue;
    const result = await rpc('thread/read', { threadId: childThreadId, includeTurns: true }).catch(() => null);
    const childTurns = result?.thread?.turns || [];
    const contexts = await ownTurnContexts(childThreadId);
    childEvidence.push({ threadId: childThreadId, configuredModel: result?.thread?.model, configuredEffort: result?.thread?.reasoningEffort,
      actualContexts: contexts, statuses: childTurns.map(turn => turn.status), completed: childTurns.some(turn => turn.status === 'completed') });
    if (handoff.reviewChildIds.includes(childThreadId) && result?.thread?.model === (initialDecision.verifierModel || initialDecision.model)
        && result?.thread?.reasoningEffort === (initialDecision.verifierEffort || 'high')) reviewChild = childThreadId;
    if (handoff.executions.at(-1)?.executorChildIds.includes(childThreadId)
        && result?.thread?.model === executionRoute.model && result?.thread?.reasoningEffort === executionRoute.effort) {
      matchingChild = { threadId: childThreadId, model: result.thread.model, effort: result.thread.reasoningEffort,
        completed: childTurns.some(turn => turn.status === 'completed') };
    }
  }
  assert.equal(handoff.executions.length, executionRoutes.length, 'Completed route calls and execution logs differ');
  for (const [index, execution] of handoff.executions.entries()) {
    const logged = executionRoutes[index];
    const decision = execution.decision;
    assert.equal(decision?.nextAction, 'execute', 'A blocked route cannot authorize subagent execution');
    assert.ok(decision?.model && decision?.effort, `Execution route ${index + 1} did not return model and effort`);
    assert.equal(decision.source, 'jev', `Execution route ${index + 1} did not receive a live Jev judgment`);
    assert.equal(logged.source, decision.source, `Execution route ${index + 1} log source mismatch`);
    assert.equal(logged.model, decision.model, `Execution route ${index + 1} log model mismatch`);
    assert.equal(logged.effort, decision.effort, `Execution route ${index + 1} log effort mismatch`);
    assert.ok(execution.executorChildIds.some(id => {
      const actual = childEvidence.find(child => child.threadId === id);
      return actual?.completed && actual.configuredModel === decision.model && actual.configuredEffort === decision.effort
        && actual.actualContexts.some(context => context.model === decision.model && context.effort === decision.effort);
    }), `Execution route ${index + 1} has no completed child running its selected model and effort`);
  }
  assert.ok(matchingChild, 'No native subagent readback matched the model and effort Jev selected for execution');
  assert.ok(matchingChild.completed, 'The selected native executor did not complete a turn');
  assert.ok(handoff.executions.at(-1)?.executorChildIds.includes(matchingChild.threadId),
    'The Jev-selected latest executor was not spawned after its corresponding route');
  const executorContexts = childEvidence.find(item => item.threadId === matchingChild.threadId)?.actualContexts || [];
  assert.ok(executorContexts.some(context => context.model === executionRoute.model && context.effort === executionRoute.effort),
    'Executor turn_context did not confirm Jev-selected runtime model and effort');
  if (requireReview) {
    assert.ok(reviewChild && reviewChild !== matchingChild.threadId, 'No distinct strong-model review child was observed');
    const reviewer = childEvidence.find(item => item.threadId === reviewChild);
    assert.ok(reviewer?.completed && reviewer.actualContexts.some(context => context.model === (initialDecision.verifierModel || initialDecision.model)
        && context.effort === (initialDecision.verifierEffort || 'high')),
      'Reviewer did not complete on the selected review model and effort');
    assert.ok(handoff.reviewChildIds.includes(reviewChild), 'Reviewer child was not spawned before the Jev subtask route');
  }

  evidence = { ...evidence, outcome: 'passed', threadId, parentTurnId: turn.turn.id,
    parentStatus: finished.status, parentContexts, routes: decisions, handoff, childEvidence, selectedExecutor: matchingChild,
    artifact: { ...evidence.artifact, status: 'accepted' }, contentChecks, observedActivityCount: observedActivity.length };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  outcome = 'passed';

  process.stdout.write(`${JSON.stringify({
    plannerSelection: liveInitialRoute ? 'live Jev' : 'fixture (not a Jev judgment)',
    planning: { model: planningRoute.model, effort: planningRoute.effort },
    execution: { model: executionRoute.model, effort: executionRoute.effort },
    child: matchingChild,
    reviewChild,
    routePhases: routes.map(route => route.phase),
  })}\n`);
} catch (error) {
  outcome = /timed out/.test(error.message) ? 'timeout' : 'failed';
  evidence = { ...evidence, outcome, error: error.message, threadId: createdThreadId, parentTurnId: activeTurnId,
    observedActivityCount: observedActivity.length };
  await mkdir(evidenceDir, { recursive: true }).catch(() => {});
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`).catch(() => {});
  process.stderr.write(`${error.message}\n`);
  if (createdThreadId && scratch) {
    const routes = await listRecentRoutes({ threadId: createdThreadId, dataDir: routeDataDir }).catch(() => []);
    process.stderr.write(`${JSON.stringify({ routes, observedActivity })}\n`);
  }
  if (stderr) process.stderr.write(`${stderr.slice(-1200)}\n`);
  process.exitCode = 1;
} finally {
  if (createdThreadId && activeTurnId && child && !child.killed) await rpc('turn/interrupt', { threadId: createdThreadId, turnId: activeTurnId }, 10000).catch(() => {});
  if (child) {
  for (const id of new Set(observedActivity.flatMap(event => [event.agentThreadId, ...(event.receiverThreadIds || [])]).filter(id => id && id !== createdThreadId))) {
    const snapshot = await rpc('thread/read', { threadId: id, includeTurns: true }, 5000).catch(() => null);
    const running = snapshot?.thread?.turns?.findLast(turn => turn.status === 'inProgress');
    if (running) await rpc('turn/interrupt', { threadId: id, turnId: running.id }, 5000).catch(() => {});
    await rpc('thread/archive', { threadId: id }, 5000).catch(() => {});
  }
  if (createdThreadId && !child.killed) await rpc('thread/archive', { threadId: createdThreadId }, 10000).catch(() => {});
  child.stdin.end();
  if (!child.killed) child.kill('SIGTERM');
  }
  proxy?.close();
  for (const resolve of pending.values()) resolve({ error: { message: 'app-server stopped' } });
  if (exitPromise) {
    let exitTimer;
    const exited = await Promise.race([exitPromise, new Promise(resolveExit => { exitTimer = setTimeout(() => resolveExit(null), 10000); })]);
    clearTimeout(exitTimer);
    if (!exited && native) { native.kill('SIGKILL'); await exitPromise; }
  }
  lines?.close();
  if (scratch && outcome !== 'passed') {
    try {
      evidence.artifact = await preserveSyntheticArtifact(workspace, evidenceDir);
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    } catch (error) {
      artifactPreservationFailed = true;
      process.stderr.write(`Artifact preservation failed; scratch retained at ${scratch}: ${error.message}\n`);
    }
  }
  if (scratch && !artifactPreservationFailed) await rm(scratch, { recursive: true, force: true });
  if (evidence.outcome !== 'passed') process.stderr.write(`${JSON.stringify({ outcome, evidence: join(evidenceDir, 'evidence.json'), scratchRemoved: Boolean(scratch) && !artifactPreservationFailed })}\n`);
}
