import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { loadSettings, updateSettings, getThreadSettings, updateThreadSettings } from './settings.mjs';
import { addRouteFeedback, appendRouteRecord, listRecentRoutes } from './audit-log.mjs';
import { readTypeSafeKey } from './credential.mjs';
import { listNativeCodexModels } from './model-catalog.mjs';
import { createQueuedStore } from './queued-submissions.mjs';
import { inspectSubtasks } from './subtask-history.mjs';

const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const model = z.string().regex(/^gpt-[a-z0-9][a-z0-9.-]{1,80}$/i);
const threadId = z.string().min(1).max(256);
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const failure = error => ({ isError: true, content: [{ type: 'text', text: error instanceof TypeError ? error.message : 'Jev router operation failed; check local server logs.' }] });
const safely = fn => async args => { try { return result(await fn(args)); } catch (error) { console.error('Jev router MCP operation failed:', error?.name ?? 'Error'); return failure(error); } };
const reasonText = Object.freeze({
  simple_task: '任务范围很小，选择轻量配置',
  standard_task: '常规多步任务，选择均衡配置',
  complex_reasoning: '需要深入推理，选择更强配置',
  high_impact: '错误后果较大，选择更强配置',
  uncertain: '判断信息不足，选择更稳妥的配置',
  plan_required: '任务进入强模型规划与子代理执行流程',
  execution_subtask: 'Jev 按计划子任务选择模型与推理强度',
  fallback: 'Jev 不可用或超时，使用备用配置',
  manual: '使用持续手动选择的配置',
  explicit: '按本次明确指定的配置执行',
  disabled: '本任务未启用自动路由',
  unknown: '按当前路由策略选择',
});
const describeRoute = route => route ? { ...route, reason: reasonText[route.reasonCode] || reasonText.unknown } : null;

export function createMcpServer({ dataDir, chooseRoute, chooseSubtaskRoute, recordRoute = appendRouteRecord, readKey = readTypeSafeKey, listModels = listNativeCodexModels, inspectHistory = inspectSubtasks } = {}) {
  const server = new McpServer({ name: 'jev-codex-router', version: '0.1.0' });
  const queuedStore = createQueuedStore({ dataDir });

  server.registerTool('status', {
    description: 'Read current Jev router status and global settings. No prompt or API credential is returned.',
    inputSchema: { threadId: threadId.optional().describe('Optional Codex thread ID for effective per-task settings') }
  }, safely(async ({ threadId: id }) => {
    const settings = await loadSettings({ dataDir });
    const { threads, ...global } = settings;
    const pendingChecks = id ? (await queuedStore.listLaunchStates(id)).map(({ id, state, attemptedAt }) => ({ id, state, attemptedAt })) : undefined;
    return { global, typesafeConfigured: Boolean(await readKey()), configuredThreadCount: Object.keys(threads).length, ...(id ? { thread: await getThreadSettings(id, { dataDir }), unconfirmedQueueStarts: pendingChecks } : {}) };
  }));

  server.registerTool('queue_status', {
    description: 'Inspect a task queue without exposing queued prompt text. An unconfirmed launch blocks automatic retry until execution is verified.',
    inputSchema: { threadId: threadId.describe('Exact Codex task ID') }
  }, safely(async ({ threadId: id }) => {
    const pending = await queuedStore.list(id, { limit: 100 });
    const unconfirmed = await queuedStore.listLaunchStates(id);
    return { pendingCountAtLeast: pending.data.length, hasMorePending: Boolean(pending.nextCursor), unconfirmedStarts: unconfirmed.map(({ id, state, attemptedAt }) => ({ id, state, attemptedAt })) };
  }));

  server.registerTool('subtask_history', {
    description: 'Read direct subagent history for one exact native Codex parent task, including completed children. Does not start or resume tasks, call Jev, or save conversation text. Requested models and latest configured models are reported separately; configured values are not per-turn execution telemetry. Incomplete history and child read errors are explicit.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      threadId: threadId.describe('Exact native parent task ID'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum children to read, default 20'),
      includeResults: z.boolean().optional().describe('Include bounded child results in this response only; default false')
    }
  }, safely(async args => ({
    ...await inspectHistory(args), routing: await getThreadSettings(args.threadId, { dataDir })
  })));

  server.registerTool('available_models', {
    description: 'Read the current native Codex account model catalog and supported reasoning efforts. Does not run a task.',
    inputSchema: {}
  }, safely(async () => ({ models: (await listModels()).map(entry => ({
    id: entry.model || entry.id,
    displayName: entry.displayName || entry.model || entry.id,
    supportedReasoningEfforts: (entry.supportedReasoningEfforts || []).map(value => typeof value === 'string' ? value : value.reasoningEffort),
    inputModalities: entry.inputModalities || ['text', 'image']
  })) })));

  server.registerTool('settings', {
    description: 'Read or update global Jev routing settings. Updates persist locally. Automatic routing should remain disabled until desktop acceptance is complete.',
    inputSchema: {
      enabled: z.boolean().optional().describe('Global automatic routing switch; false during pre-acceptance testing'),
      fallbackModel: model.optional().describe('Codex model used when Jev fails or times out; default gpt-6-sol'),
      fallbackEffort: effort.optional().describe('Reasoning effort for the fallback model; default medium'),
      timeoutMs: z.number().int().min(100).max(10000).optional().describe('Jev deadline in milliseconds; default 2000')
    }
  }, safely(async args => {
    const patch = {};
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.timeoutMs !== undefined) patch.timeoutMs = args.timeoutMs;
    if (args.fallbackModel !== undefined || args.fallbackEffort !== undefined) {
      const current = await loadSettings({ dataDir });
      patch.fallback = { model: args.fallbackModel ?? current.fallback.model, effort: args.fallbackEffort ?? current.fallback.effort };
    }
    return Object.keys(patch).length ? updateSettings(patch, { dataDir }) : loadSettings({ dataDir });
  }));

  server.registerTool('thread_settings', {
    description: 'Read or update one Codex task. enabled=false disables automatic routing for this task. mode=manual persists model choice until mode=auto is set.',
    inputSchema: {
      threadId: threadId.describe('Exact Codex thread ID'),
      enabled: z.boolean().nullable().optional().describe('Task switch; null inherits global setting'),
      mode: z.enum(['auto', 'manual']).optional().describe('Persistent task mode'),
      manualModel: model.optional().describe('Codex model for manual mode; supply with manualEffort'),
      manualEffort: effort.optional().describe('Effort for manual mode; supply with manualModel')
    }
  }, safely(async ({ threadId: id, ...patch }) => Object.values(patch).some(value => value !== undefined)
    ? updateThreadSettings(id, Object.fromEntries(Object.entries(patch).filter(([,value]) => value !== undefined)), { dataDir })
    : getThreadSettings(id, { dataDir })));

  server.registerTool('route_preview', {
    description: 'Ask Jev for a bounded model/effort recommendation without starting a Codex turn or saving the prompt. Reads the current native Codex model catalog when models are omitted. Credential comes from the existing TypeSafe environment variable or macOS Keychain.',
    inputSchema: {
      prompt: z.string().min(1).max(20000).describe('Current user prompt; sent to TypeSafe Jev, never stored in route logs'),
      threadId: threadId.optional().describe('Existing Codex thread ID, if available'),
      models: z.array(z.object({ id: model, model: model.optional(), displayName: z.string().optional(), supportedReasoningEfforts: z.array(z.union([effort, z.object({ reasoningEffort: effort })])).min(1), inputModalities: z.array(z.enum(['text', 'image'])).optional(), hidden: z.boolean().optional() })).min(1).max(20).optional().describe('Optional current-account native Codex model catalog. Omit to discover it automatically.'),
      context: z.object({ summary: z.string().max(4000).optional(), progress: z.string().max(2000).optional(), lastResult: z.string().max(2000).optional() }).optional().describe('Optional same-task context only; no project file reading')
    }
  }, safely(async ({ prompt, threadId: id, models, context }) => {
    const key = await readKey();
    if (!key) throw new TypeError('TypeSafe credential is not configured for this MCP server');
    const route = chooseRoute ?? (await import('./route-core.mjs')).chooseRoute;
    const available = models || await listModels();
    const settings = id ? await getThreadSettings(id, { dataDir }) : await loadSettings({ dataDir }).then(global => ({
      enabled: global.enabled, fallbackModel: global.fallback.model, fallbackEffort: global.fallback.effort, timeoutMs: global.timeoutMs
    }));
    return route({ prompt, context: context ?? {}, models: available, settings, apiKey: key });
  }));

  server.registerTool('route_execution_subtask', {
    description: 'After a complex task has a clear plan, ask Jev which native Codex model and reasoning effort should execute one concrete subtask. Pass the task, acceptance criteria, and only the bounded plan/dependency context needed for that subtask. If retrying after failure, also pass the previous model, effort, and a concise failure summary so Jev can recommend an escalation. Use the returned model and effort when calling native spawn_agent, and its routingToken as task_name to correlate the child in subtask_history. Never include credentials or full conversation history; this tool does not store prompt text.',
    inputSchema: {
      task: z.string().min(1).max(8000).describe('One concrete planned execution unit'),
      acceptanceCriteria: z.string().max(2000).optional().describe('Observable completion criteria for this unit'),
      planSummary: z.string().max(3000).optional().describe('Bounded summary of the approved task plan'),
      dependencies: z.string().max(1200).optional().describe('Dependencies or constraints that affect this unit'),
      previousModel: model.optional().describe('Previous child model when retrying after an incomplete attempt'),
      previousEffort: effort.optional().describe('Previous child reasoning effort when retrying after an incomplete attempt'),
      failureSummary: z.string().max(1000).optional().describe('Concise error or blocker from the previous attempt; used to escalate safely'),
      threadId: threadId.describe('Parent Codex task ID for effective manual/fallback settings and local route metadata'),
      models: z.array(z.object({ id: model, model: model.optional(), displayName: z.string().optional(), supportedReasoningEfforts: z.array(z.union([effort, z.object({ reasoningEffort: effort })])).min(1), inputModalities: z.array(z.enum(['text', 'image'])).optional(), hidden: z.boolean().optional() })).min(1).max(20).optional().describe('Optional current-account native Codex catalog. Omit to discover it automatically.')
    }
  }, safely(async ({ task, acceptanceCriteria = '', planSummary = '', dependencies = '', previousModel, previousEffort, failureSummary = '', threadId: id, models }) => {
    const key = await readKey().catch(() => null);
    const routeTask = chooseSubtaskRoute ?? (await import('./route-core.mjs')).chooseSubtaskRoute;
    const available = models || await listModels();
    const settings = id ? await getThreadSettings(id, { dataDir }) : await loadSettings({ dataDir }).then(global => ({
      enabled: global.enabled, fallbackModel: global.fallback.model, fallbackEffort: global.fallback.effort, timeoutMs: global.timeoutMs,
    }));
    const decision = await routeTask({ task, acceptanceCriteria, dependencies, previousModel, previousEffort, failureSummary, threadId: id,
      context: { summary: planSummary }, models: available, settings, apiKey: key });
    const routeId = randomUUID();
    const routingToken = `jev_${routeId.replaceAll('-', '')}`;
    try {
      await recordRoute({ id: routeId, threadId: id, model: decision.model, effort: decision.effort, source: decision.source,
        reasonCode: decision.source === 'fallback' || decision.source === 'manual' ? decision.source : 'execution_subtask',
        phase: decision.phase || 'execution', elapsedMs: decision.elapsedMs, fallback: decision.source === 'fallback', escalated: decision.escalated }, { dataDir });
    } catch (error) {
      console.error('Jev subtask route log failed:', error?.name ?? 'Error');
    }
    return { ...decision, routeId, routingToken };
  }));

  server.registerTool('feedback', {
    description: 'Mark a previous route as too weak or overkill. Saves only feedback on existing local metadata; never stores prompt text.',
    inputSchema: {
      recordId: z.string().uuid().describe('ID returned by recent_routes'),
      feedback: z.enum(['too_weak', 'overkill']).describe('Correction for the selected model and effort')
    }
  }, safely(async ({ recordId, feedback }) => addRouteFeedback(recordId, feedback, { dataDir })));

  server.registerTool('recent_routes', {
    description: 'List recent local routing metadata. Records are retained for 30 days by default and contain no prompts, conversation text or API credentials.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Maximum records, default 20'),
      threadId: threadId.optional().describe('Only records for this Codex task')
    }
  }, safely(async args => ({ routes: (await listRecentRoutes({ ...args, dataDir })).map(describeRoute) })));

  server.registerTool('last_decision', {
    description: 'Read the latest route with its short explanation. Provide threadId for an exact task; without it this returns the latest record across all tasks.',
    inputSchema: { threadId: threadId.optional().describe('Optional exact Codex task ID') }
  }, safely(async args => ({ route: describeRoute((await listRecentRoutes({ ...args, limit: 1, dataDir }))[0]) })));

  return server;
}

export async function runStdioServer(options = {}) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
