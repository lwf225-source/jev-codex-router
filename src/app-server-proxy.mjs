import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { chooseRoute, detectExplicitOverride } from './route-core.mjs';
import { readTypeSafeKey } from './credential.mjs';
import { getThreadSettings, updateThreadSettings } from './settings.mjs';
import { appendRouteRecord } from './audit-log.mjs';
import { boundPrompt, routingTimeoutMs } from './routing-context.mjs';
import { createQueuedStore } from './queued-submissions.mjs';

const MAX_CONTEXT = 4500;
const DEFAULT_ROUTE_WAIT_MS = 2000;
const MAX_ROUTE_WAIT_MS = 10000;
const routeBudget = settings => Math.min(MAX_ROUTE_WAIT_MS, Math.max(100, routingTimeoutMs(settings?.timeoutMs)));
const headTail = boundPrompt;
const explicitContinuation = prompt => /^(?:continue(?:\s+(?:the task|implementation|work))?|resume(?:\s+(?:the task|implementation|work))?|proceed|继续(?:执行|任务|优化|修复|实施)?|接着(?:做|执行)?)[.!。！\s]*$/i.test(prompt.trim());
const INTERNAL_REQUEST_TIMEOUT_MS = 450;

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function textFromInput(input) {
  if (!Array.isArray(input)) return '';
  return headTail(input.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n'), 12000);
}

function inputModalities(input) {
  const modalities = new Set(['text']);
  for (const part of input || []) {
    if (part?.type === 'image' || part?.type === 'localImage') modalities.add('image');
  }
  return [...modalities];
}

function capped(value, length = MAX_CONTEXT) {
  return headTail(value, length);
}

function visibleReason(reason) {
  return String(reason || '').replace(/[\r\n\t]+/g, ' ').slice(0, 170);
}

function reasonCodeFor(result) {
  if (result.reasonCode) return result.reasonCode;
  if (result.source !== 'jev') return result.source;
  if (result.phase === 'plan_execute' || result.phase === 'planning_only') return 'plan_required';
  if (result.reason?.includes('后果较大')) return 'high_impact';
  if (result.reason?.includes('深入推理')) return 'complex_reasoning';
  if (result.reason?.includes('把握不足')) return 'uncertain';
  if (result.reason?.includes('任务简单') || result.reason?.includes('任务范围很小')) return 'simple_task';
  return 'standard_task';
}

/**
 * Wrap the desktop app's app-server JSONL connection. New user turns are routed;
 * queued submissions are held locally until their turn is ready to start. Tools,
 * steering, and unrelated RPCs pass through unchanged.
 */
export function createAppServerProxy({
  child,
  clientInput = process.stdin,
  clientOutput = process.stdout,
  dataDir,
  route = chooseRoute,
  credential = readTypeSafeKey,
  threadSettings = (threadId) => getThreadSettings(threadId, { dataDir }),
  setThreadSettings = (threadId, patch) => updateThreadSettings(threadId, patch, { dataDir }),
  record = (entry) => appendRouteRecord(entry, { dataDir }),
  queueStore = createQueuedStore({ dataDir }),
  internalStartTimeoutMs = 5000,
  announce = () => {},
  diagnostic = () => {},
} = {}) {
  if (!child?.stdin || !child?.stdout) throw new TypeError('A running app-server child with pipe stdio is required');

  const clientLines = createInterface({ input: clientInput, crlfDelay: Infinity });
  const serverLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const contexts = new Map();
  const pendingInternal = new Map();
  const clientModelLists = new Set();
  const clientThreadReads = new Map();
  const clientResumes = new Map();
  const queuedStarts = new Map();
  const observedClientStarts = new Set();
  const clientKey = (threadId, clientId) => `${threadId}\u0000${clientId}`;
  const activeTurns = new Map();
  const pendingTurnStarts = new Map();
  const pendingStarts = new Map();
  const startingThreads = new Map();
  const interruptEpochs = new Map();
  const pendingRoutedStarts = new Map();
  let models = [];
  let sequence = -730_000_000;
  let catalogInFlight = null;
  let initialized = false;
  let ingress = Promise.resolve();

  const toChild = (message) => child.stdin.write(typeof message === 'string' ? `${message}\n` : `${JSON.stringify(message)}\n`);
  const toClient = (message) => clientOutput.write(typeof message === 'string' ? `${message}\n` : `${JSON.stringify(message)}\n`);

  function registerStart(threadId, id, kind = 'client') {
    const launch = { threadId, id, kind, cancelled: false, sent: false };
    if (!pendingStarts.has(threadId)) pendingStarts.set(threadId, new Set());
    pendingStarts.get(threadId).add(launch);
    return launch;
  }

  function releaseStart(launch) {
    if (!launch) return;
    const pending = pendingStarts.get(launch.threadId);
    pending?.delete(launch);
    if (!pending?.size) pendingStarts.delete(launch.threadId);
    if (startingThreads.get(launch.threadId) === launch) startingThreads.delete(launch.threadId);
  }

  function cancelStarts(threadId) {
    interruptEpochs.set(threadId, (interruptEpochs.get(threadId) || 0) + 1);
    for (const launch of pendingStarts.get(threadId) || []) {
      if (launch.cancelled || launch.sent) continue;
      launch.cancelled = true;
      if (launch.kind !== 'queue' && launch.id !== undefined) {
        toClient({ id: launch.id, error: { code: -32000, message: 'Turn cancelled before native start' } });
      }
    }
  }

  function requireUncancelled(launch) {
    if (launch.cancelled) throw new Error('Turn cancelled before native start');
  }

  function sendInternalResponse(method, params, timeoutMs = INTERNAL_REQUEST_TIMEOUT_MS) {
    if (timeoutMs <= 0) return Promise.resolve(null);
    const id = sequence--;
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingInternal.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      pendingInternal.set(id, (response) => {
        clearTimeout(timer);
        resolve(response || null);
      });
    });
    toChild({ method, id, params });
    return promise;
  }

  async function sendInternal(method, params, timeoutMs = INTERNAL_REQUEST_TIMEOUT_MS) {
    return (await sendInternalResponse(method, params, timeoutMs))?.result || null;
  }

  function within(promise, deadline, fallback = null) {
    const remaining = Math.max(0, deadline - performance.now());
    if (!remaining) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), remaining);
      Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
    });
  }

  function remaining(deadline, cap = MAX_ROUTE_WAIT_MS) {
    return Math.max(0, Math.min(cap, Math.floor(deadline - performance.now())));
  }

  function observedSelection(params = {}) {
    return {
      model: params.collaborationMode?.settings?.model || params.model || null,
      effort: params.collaborationMode?.settings?.reasoning_effort || params.effort || null,
    };
  }

  function mergeRuntimeSettings(previous = {}, incoming = {}, effortKey = 'effort') {
    const next = { ...previous };
    if (Object.hasOwn(incoming, 'model')) next.model = incoming.model;
    if (Object.hasOwn(incoming, effortKey)) next.effort = incoming[effortKey];
    if (Object.hasOwn(incoming, 'collaborationMode')) next.collaborationMode = incoming.collaborationMode;
    return next;
  }

  function matchesSelection(selected, expected) {
    return expected && (!selected.model || selected.model === expected.model)
      && (!selected.effort || selected.effort === expected.effort);
  }

  function withSelection(params, result) {
    const next = { ...params, model: result.model, effort: result.effort };
    // Per-turn application context reaches the model independently of mode presets.
    // Keep this key empty on direct turns so an earlier handoff cannot stay sticky.
    next.additionalContext = { ...params.additionalContext, jev_routing: { kind: 'application', value: '' } };
    if (result.phase === 'plan_execute') {
      const handoffInstructions = [
        'Jev has selected the staged planning and execution workflow for this task.',
        `These routing instructions apply only to the root of parent thread ${params.threadId}. Execution and review children must perform their assigned work without recursively repeating this workflow. Preserve all existing permissions and user constraints.`,
        'First produce a concrete plan with ordered steps, dependencies, and observable acceptance criteria. Keep the root agent responsible for coordination and final verification.',
        'Preserve every explicit user constraint in the plan and handoff. Copy exact identifiers, file names, numeric values, source and target types, units, and requested boundaries into the reviewer and executor tasks. Before accepting a child result, compare those exact values against the original user message; correct any mismatch before claiming completion.',
        result.needsSecondOpinion
          ? `Before execution, ask one second strong model to review the plan using model=${result.verifierModel || result.model} and reasoning_effort=${result.verifierEffort || 'high'}, fork_turns="none", and a self-contained review task that includes the user's exact constraints. Have the reviewer check the plan against those constraints, then incorporate material corrections before delegation.`
          : 'A second-model plan review is not required for this task.',
        'Mandatory handoff rule: the root agent may plan, review, coordinate, and verify, but MUST NOT directly perform the planned implementation or write its deliverables. Do not use shell, web, or other execution tools to do the child’s work.',
        `After the plan is clear, call register_execution_plan with threadId=${params.threadId} and execution units containing stable unitId, dependencies and acceptanceCriteria. Registration never starts work. Then call route_execution_subtask for every execution unit with unitId, task, acceptanceCriteria, concise planSummary, dependencies, structuredContext with fields goal, constraints (exact values), phase, dependencies, acceptanceCriteria, recentResult (including failure evidence), and attachmentStatus, and threadId=${params.threadId}.`,
        'Delegate only when nextAction=execute (or an older route omits nextAction); when nextAction is repair_environment, needs_context, replan or stop, follow that action and DO NOT spawn. After an executable route returns, delegate that unit with the native spawn_agent tool, passing the exact model and reasoning_effort returned by Jev. When routingToken is returned, use it as task_name so the child can be linked to this specific route. Set fork_turns="none" and include a self-contained task, constraints and acceptance criteria; full-history forks cannot override models. Use one execution child by default; create multiple children only for independent work units. If either tool is unavailable, report the unavailable capability instead of claiming a handoff.',
        'An idempotent route can return reused=true with the existing routingToken. Never blindly spawn again for a reused decision: query subtask_history first. If the linked native child already started or completed, retain that child. Only when complete, untruncated history proves not_dispatched may you use the current valid token to dispatch once. If dispatch status is uncertain, stop and resolve that uncertainty.',
        'Classify failures before retry: capability, environment/dependency, permission, transient service, invalid plan, missing information or unknown. Retry routing with the same unitId, explicit retry=true, previousModel, previousEffort, failureCategory and concise failureSummary. At most two execution attempts per unit. Only capability failures justify escalation. Repair environment failures, stop blocked permission work, replan invalid plans and request missing context. For unknown launch state or possible external effects, verify native completion before any retry.',
        'Use a source=fallback route if the MCP returns one. A tool error without a valid model/effort pair is not a route: report it rather than inventing a configuration. When escalated=false after a failed attempt, return to planning instead of repeating the same failed route indefinitely.',
        `Before reporting the execution complete, use the read-only subtask_history tool with threadId=${params.threadId} to check linked children and their recorded status. Treat read errors, truncated history, unlinked routing tokens, or configuredMatchesSuggestion=false as unresolved evidence to investigate. Current configured models are not per-turn execution telemetry. Verify the actual deliverable and acceptance criteria separately; a completed child or a model match alone does not prove acceptance. Record acceptance through record_execution_acceptance only after checking native completion/configuration and the actual deliverable. Require allVerified before declaring the registered plan fully verified; missing units, duplicate tokens, pending acceptance and unknown status remain unresolved. This is observed execution plus declared acceptance, not hard tool interception. If the history tool is unavailable, report the verification gap honestly.`,
      ].join(' ');
      next.additionalContext.jev_routing.value = handoffInstructions;
    }
    if (result.nextAction && result.nextAction !== 'execute') {
      next.additionalContext.jev_routing.value = `Routing nextAction=${result.nextAction}. Address that action before implementation or spawning execution children. A model suggestion alone does not authorize execution. ` + next.additionalContext.jev_routing.value;
    }
    if (params.collaborationMode?.settings) next.collaborationMode = {
      ...params.collaborationMode,
      settings: { ...params.collaborationMode.settings, model: result.model, reasoning_effort: result.effort },
    };
    return next;
  }

  function mergeCatalog(result) {
    if (Array.isArray(result?.data)) models = result.data.filter((entry) => entry && entry.hidden !== true);
  }

  async function ensureCatalog(deadline = Infinity) {
    if (models.length) return models;
    if (!initialized) return [];
    if (!catalogInFlight) {
      catalogInFlight = sendInternal('model/list', { limit: 100, includeHidden: false }, remaining(deadline, INTERNAL_REQUEST_TIMEOUT_MS))
        .then((result) => { mergeCatalog(result); return models; })
        .finally(() => { catalogInFlight = null; });
    }
    return catalogInFlight;
  }

  function observeHistory(threadId, turns) {
    if (!Array.isArray(turns)) return;
    const entries = [];
    for (const turn of turns.slice(-3)) {
      for (const item of turn?.items || []) {
        if (item?.type === 'userMessage') {
          const text = textFromInput(item.content || item.input);
          if (text) entries.push(`用户：${capped(text, 800)}`);
        }
        if (item?.type === 'agentMessage') {
          const text = typeof item.text === 'string' ? item.text : textFromInput(item.content);
          if (text) entries.push(`Codex：${capped(text, 800)}`);
        }
      }
    }
    if (entries.length) {
      const previous = contexts.get(threadId) || {};
      contexts.set(threadId, { ...previous, summary: capped(entries.slice(-4).join('\n')) });
    }
  }

  async function contextFor(threadId, prompt, input, deadline = Infinity) {
    const existing = contexts.get(threadId) || {};
    if (!existing.summary && initialized) {
      const history = await sendInternal('thread/read', { threadId, includeTurns: true }, remaining(deadline, 300));
      observeHistory(threadId, history?.thread?.turns);
    }
    const current = contexts.get(threadId) || {};
    return {
      summary: current.summary || '',
      progress: current.progress || '',
      lastResult: current.lastResult || '',
      inputModalities: inputModalities(input),
      attachmentsReadable: !inputModalities(input).includes('image'),
      ...(explicitContinuation(prompt) && current.previousRoute ? { previousRoute: current.previousRoute, continuation: true } : {}),
    };
  }

  async function routeInput(threadId, input, params, deadline, preparation = {}) {
    const prompt = textFromInput(input);
    if (!prompt && !inputModalities(input).includes('image')) return null;
    const settings = preparation.settings || await within(threadSettings(threadId), Math.min(deadline, (preparation.started ?? performance.now()) + routeBudget(contexts.get(threadId)?.routingSettings)));
    if (settings?.enabled !== true) return null;
    preparation.settings = settings;
    const end = Math.min(deadline, (preparation.started ?? deadline - MAX_ROUTE_WAIT_MS) + routeBudget(settings));
    const catalog = preparation.catalog || await within(ensureCatalog(end), end, models);
    if (!catalog.length) {
      diagnostic('route skipped: no available model catalog');
      return null;
    }
    preparation.catalog = catalog;
    const state = contexts.get(threadId) || {};
    let context = {
      summary: state.summary || '', progress: state.progress || '', lastResult: state.lastResult || '',
      inputModalities: inputModalities(input), attachmentsReadable: !inputModalities(input).includes('image'),
      ...(explicitContinuation(prompt) && state.previousRoute ? { previousRoute: state.previousRoute, continuation: true } : {}),
    };
    if (!preparation.localOnly && remaining(end)) context = await within(contextFor(threadId, prompt, input, end), end, context);
    const selected = observedSelection(params);
    const explicitlyRequested = detectExplicitOverride(prompt, catalog, context);
    const effectiveSettings = {
      ...settings, timeoutMs: remaining(end),
      ...(settings.mode === 'manual' && !explicitlyRequested ? {
        manualModel: settings.manualModel || selected.model,
        manualEffort: settings.manualEffort || selected.effort,
      } : {}),
    };
    // Build the fallback from the freshest available context, including resumed
    // task evidence, while preserving manual choices and edited modalities.
    let fallback;
    try {
      fallback = await chooseRoute({ prompt, context, models: catalog, settings: effectiveSettings, localOnly: true, fallbackReasonCode: 'timeout' });
      if (fallback.source === 'fallback') fallback = { ...fallback, reasonCode: 'timeout' };
    } catch (error) {
      diagnostic('route skipped: no valid local fallback', error);
      return null;
    }
    const controller = new AbortController();
    let result = fallback;
    try {
      if (!preparation.localOnly && remaining(end)) {
        const credentialExpired = Symbol('credential deadline');
        const bypassCredential = settings.mode === 'manual' || explicitlyRequested;
        const key = bypassCredential ? null : await within(credential(), end, credentialExpired);
        if (key === credentialExpired) result = fallback;
        else if (!key && !bypassCredential) result = await chooseRoute({ prompt, context, models: catalog, settings: effectiveSettings, localOnly: true, fallbackReasonCode: 'missing_key' });
        else if (remaining(end)) result = await within(route({
          prompt: prompt || '[The user supplied an image; contents are not readable to the router.]', context, models: catalog,
          settings: { ...effectiveSettings, timeoutMs: remaining(end) }, apiKey: key,
          signal: controller.signal,
        }), end, fallback);
      }
    } catch (error) {
      diagnostic('route failed', error);
      result = { ...fallback, reasonCode: 'service_error' };
    } finally { controller.abort(); }
    if (!result?.model || !result?.effort) result = fallback;
    const collaborationMode = Object.hasOwn(params, 'collaborationMode') ? params.collaborationMode : state.threadRuntimeSettings?.collaborationMode;
    if (result.phase === 'plan_execute' && collaborationMode?.mode === 'plan') {
      result = { ...result, phase: 'planning_only', needsSecondOpinion: false,
        reason: '当前 Codex 任务处于仅规划模式；按强模型规划，不自动启动执行子代理' };
    }
    return { result, prompt };
  }

  async function reportRoute(threadId, routed, started) {
    const { result, prompt } = routed;
    const state = contexts.get(threadId) || {};
    state.lastApplied = { model: result.model, effort: result.effort };
    state.previousRoute = { model: result.model, effort: result.effort, phase: result.phase, taskKind: result.taskKind, highRisk: result.highRisk, needsSecondOpinion: result.needsSecondOpinion, capabilityFloor: result.capabilityFloor, complexity: result.complexity, contextComplete: result.contextComplete };
    state.summary = capped([state.summary, `用户：${capped(prompt || '[图片]', 600)}`].filter(Boolean).join('\n'));
    contexts.set(threadId, state);
    try { await announce({ threadId, model: result.model, effort: result.effort, source: result.source, reason: visibleReason(result.reason) }); }
    catch (error) { diagnostic('route announcement failed', error); }
    try {
      await record({ threadId, model: result.model, effort: result.effort, source: result.source,
        reasonCode: reasonCodeFor(result), phase: result.phase === 'plan_execute' || result.phase === 'planning_only' ? 'planning' : 'direct',
        elapsedMs: Math.round(performance.now() - started), fallback: result.source === 'fallback',
        taskKind: result.taskKind, policyVersion: result.policyVersion, nextAction: result.nextAction,
        contextComplete: result.contextComplete, capabilityLimited: result.capabilityLimited });
    } catch (error) { diagnostic('route record failed', error); }
  }

  async function handleTurn(message, launch) {
    const params = message.params;
    const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
    if (launch?.cancelled) { releaseStart(launch); return; }
    if (!threadId) { toChild(message); return; }
    if (activeTurns.has(threadId)) { launch.sent = true; releaseStart(launch); toChild(message); return; }
    if (startingThreads.has(threadId) && startingThreads.get(threadId) !== launch) {
      // An automatic queue check may still be discovering that the queue is
      // empty. Let its launch settle, then re-evaluate whether this is a new
      // turn or a supplement to the queued turn that actually started.
      await startingThreads.get(threadId).promise?.catch(() => null);
      return handleTurn(message, launch);
    }
    startingThreads.set(threadId, launch);
    const forwardNewTurn = (outgoing, hasRoute = false) => {
      if (launch.cancelled) return;
      launch.sent = true;
      activeTurns.set(threadId, 'pending');
      if (Object.hasOwn(message, 'id')) pendingTurnStarts.set(message.id, threadId);
      toChild({ ...outgoing, params: { ...outgoing.params, additionalContext: {
        ...outgoing.params.additionalContext,
        jev_routing: hasRoute ? outgoing.params.additionalContext.jev_routing : { kind: 'application', value: '' },
      } } });
    };
    if (params?.toolOutput) { forwardNewTurn(message); releaseStart(launch); return; }
    const started = performance.now();
    try {
      const state = contexts.get(threadId) || {};
      const selected = observedSelection(params);
      const previousClient = state.lastClient;
      const changedFromClient = previousClient && ((selected.model && selected.model !== previousClient.model)
        || (selected.effort && selected.effort !== previousClient.effort));
      state.lastClient = selected;
      contexts.set(threadId, state);
      if (state.lastApplied && changedFromClient && ((selected.model && selected.model !== state.lastApplied.model)
        || (selected.effort && selected.effort !== state.lastApplied.effort))) {
        const current = await within(threadSettings(threadId), started + routeBudget(state.routingSettings));
        if (current?.enabled) {
          await within(setThreadSettings(threadId, { mode: 'manual', manualModel: selected.model || state.lastApplied.model,
            manualEffort: selected.effort || state.lastApplied.effort }), started + routeBudget(current));
        }
      }
      const routed = await routeInput(threadId, params.input, params, started + MAX_ROUTE_WAIT_MS, { started });
      if (launch.cancelled) return;
      if (!routed) { forwardNewTurn(message); return; }
      if (routed.result.nextAction === 'stop') {
        toClient({ id: message.id, error: { code: -32000, message: 'Routing requires stop; no native turn was started' } });
        return;
      }
      pendingRoutedStarts.set(threadId, { routed, started });
      forwardNewTurn({ ...message, params: withSelection(params, routed.result) }, true);
    } finally {
      releaseStart(launch);
    }
  }

  function confirmRoutedStart(threadId) {
    const pending = pendingRoutedStarts.get(threadId);
    if (!pending) return;
    pendingRoutedStarts.delete(threadId);
    void reportRoute(threadId, pending.routed, pending.started);
  }

  function queueChanged(threadId) { toClient({ method: 'thread/queue/changed', params: { threadId } }); }

  function queueError(message, error) {
    if (Object.hasOwn(message, 'id')) toClient({ id: message.id, error: { code: -32000, message: error.message || String(error) } });
    diagnostic('queue operation failed', error);
  }

  function matchingTurn(history, clientId) {
    return history?.thread?.turns?.find(turn => turn?.items?.some(item => item?.type === 'userMessage' && item.clientId === clientId)) || null;
  }

  async function startedTurnInHistory(threadId, clientId) {
    const history = await sendInternal('thread/read', { threadId, includeTurns: true }, INTERNAL_REQUEST_TIMEOUT_MS);
    return matchingTurn(history, clientId);
  }

  async function reconcileUnknown(threadId) {
    const unknown = await queueStore.listLaunchStates(threadId);
    for (const attempt of unknown) {
      const found = await startedTurnInHistory(threadId, attempt.clientUserMessageId);
      if (found || observedClientStarts.has(clientKey(threadId, attempt.clientUserMessageId))) {
        await queueStore.removeOnStarted(threadId, attempt.id);
        observedClientStarts.delete(clientKey(threadId, attempt.clientUserMessageId));
        queueChanged(threadId);
      }
    }
    return unknown.length > 0;
  }

  async function startQueued(threadId, requestedId = null, { notify = true, automatic = false, requestLaunch } = {}) {
    const current = queuedStarts.get(threadId);
    if (current) {
      if (requestedId && current.id && requestedId !== current.id) throw new Error('another queued submission is starting');
      if (requestLaunch) {
        current.waiters.add(requestLaunch);
        requestLaunch.sent = current.sent;
      }
      return current.promise;
    }
    if (activeTurns.has(threadId)) throw new Error('thread already has an active turn');
    if (startingThreads.has(threadId) || [...(pendingStarts.get(threadId) || [])].some(start => start.kind === 'client')) {
      throw new Error('thread already has a turn starting');
    }
    const launch = registerStart(threadId, requestedId, 'queue');
    launch.waiters = new Set(requestLaunch ? [requestLaunch] : []);
    startingThreads.set(threadId, launch);
    const promise = (async () => {
      if (automatic) await reconcileUnknown(threadId);
      requireUncancelled(launch);
      const submission = await queueStore.peek(threadId, requestedId);
      requireUncancelled(launch);
      if (automatic && (!submission || await queueStore.getLaunchState(threadId, submission.id))) return null;
      if (!submission) throw new Error('queued submission not found');
      launch.id = submission.id;
      const started = performance.now();
      const deadline = started + MAX_ROUTE_WAIT_MS;
      let runtime = { ...(contexts.get(threadId)?.threadRuntimeSettings || {}) };
      let settingsRevision = contexts.get(threadId)?.routingSettingsRevision || 0;
      let candidate = submission;
      let routed = null;
      let attemptId;
      const preparation = { started };
      const refreshSelection = async () => {
        const before = contexts.get(threadId) || {};
        const known = (before.routingSettingsRevision || 0) !== settingsRevision
          ? before.routingSettings : preparation.settings;
        const refreshDeadline = Math.min(deadline, started + routeBudget(known));
        const current = remaining(refreshDeadline) ? await within(threadSettings(threadId), refreshDeadline, known) : known;
        const latest = contexts.get(threadId) || {};
        const revision = latest.routingSettingsRevision || 0;
        const settings = revision !== settingsRevision ? latest.routingSettings : current;
        const nextRuntime = { ...(latest.threadRuntimeSettings || {}) };
        settingsRevision = revision;
        if (JSON.stringify(settings) === JSON.stringify(preparation.settings)
          && JSON.stringify(nextRuntime) === JSON.stringify(runtime)) return;
        runtime = nextRuntime;
        preparation.settings = settings;
        // A picker update invalidates an in-flight Jev judgment. Re-evaluate
        // locally, even if that judgment consumed the remaining time budget.
        preparation.localOnly = true;
        routed = await routeInput(threadId, candidate.input, runtime, deadline, preparation);
      };
      // An edit made while Jev is judging must be included in the actual turn.
      for (;;) {
        requireUncancelled(launch);
        routed = await routeInput(threadId, candidate.input, runtime, deadline, preparation);
        requireUncancelled(launch);
        const latest = await queueStore.peek(threadId, candidate.id);
        requireUncancelled(launch);
        if (!latest) throw new Error('queued submission was deleted before start');
        if (JSON.stringify(latest.input) !== JSON.stringify(candidate.input)) {
          candidate = latest;
          continue;
        }
        candidate = latest;
        await refreshSelection();
        requireUncancelled(launch);
        if (routed?.result.nextAction === 'stop') throw new Error('Routing requires stop; queued execution was not started');
        const marked = await queueStore.markStarting(threadId, candidate.id, candidate.input);
        if (marked.marked) {
          attemptId = marked.attemptId;
          if (launch.cancelled) {
            await queueStore.clearStarting(threadId, candidate.id, attemptId);
            requireUncancelled(launch);
          }
          break;
        }
        candidate = marked.submission;
      }
      try {
        // The queue marker itself is asynchronous. Recheck changes received
        // while it was written before committing to the native start.
        await refreshSelection();
        requireUncancelled(launch);
      } catch (error) {
        await queueStore.clearStarting(threadId, candidate.id, attemptId);
        throw error;
      }
      if (routed?.result.nextAction === 'stop') {
        await queueStore.clearStarting(threadId, candidate.id, attemptId);
        throw new Error('Routing requires stop; queued execution was not started');
      }
      let params = { ...runtime, threadId, input: candidate.input, clientUserMessageId: candidate.clientUserMessageId };
      if (routed) params = withSelection(params, routed.result);
      else params = { ...params, additionalContext: { ...params.additionalContext, jev_routing: { kind: 'application', value: '' } } };
      // No await between this final guard and the native write.
      requireUncancelled(launch);
      launch.sent = true;
      for (const waiter of launch.waiters) waiter.sent = true;
      activeTurns.set(threadId, 'pending');
      const response = await sendInternalResponse('turn/start', params, internalStartTimeoutMs);
      let confirmedTurn = response?.result?.turn || null;
      if (!confirmedTurn && !response?.error) confirmedTurn = await startedTurnInHistory(threadId, candidate.clientUserMessageId);
      const confirmedByEvent = observedClientStarts.has(clientKey(threadId, candidate.clientUserMessageId));
      if (!confirmedTurn && !confirmedByEvent && response?.error) {
        await queueStore.clearStarting(threadId, candidate.id, attemptId);
        if (activeTurns.get(threadId) === 'pending') activeTurns.delete(threadId);
        throw new Error(response.error.message || 'native turn/start was rejected');
      }
      if (!confirmedTurn && !confirmedByEvent) {
        // The request may have executed even though its response disappeared.
        // Keep the durable marker so resume cannot replay it blindly.
        throw new Error('native turn/start state is unknown; inspect queued launch status before retrying');
      }
      await queueStore.removeOnStarted(threadId, candidate.id);
      observedClientStarts.delete(clientKey(threadId, candidate.clientUserMessageId));
      if (notify) queueChanged(threadId);
      if (routed) void reportRoute(threadId, routed, started);
      if (!confirmedTurn) throw new Error('native turn started, but its turn response is unavailable');
      return { turn: confirmedTurn };
    })();
    launch.promise = promise;
    queuedStarts.set(threadId, launch);
    try { return await promise; }
    finally {
      if (queuedStarts.get(threadId) === launch) queuedStarts.delete(threadId);
      releaseStart(launch);
    }
  }

  function scheduleQueued(threadId) {
    if (!threadId || activeTurns.has(threadId) || pendingStarts.get(threadId)?.size) return;
    const epoch = interruptEpochs.get(threadId) || 0;
    // Native sends turn/completed before the proxy opens the next turn. The UI
    // receives completion first, matching the server's usual event order.
    queueMicrotask(() => {
      if (activeTurns.has(threadId) || pendingStarts.get(threadId)?.size || epoch !== (interruptEpochs.get(threadId) || 0)) return;
      void startQueued(threadId, null, { automatic: true })
        .catch((error) => diagnostic('automatic queue start failed', error));
    });
  }

  async function handleQueue(message, launch) {
    const { method, params = {} } = message;
    const { threadId, queuedSubmissionId } = params;
    try {
      if (launch?.cancelled) return;
      let result;
      switch (method) {
        case 'thread/queue/add':
          result = { queuedSubmission: await queueStore.add(params) };
          break;
        case 'thread/queue/list':
          result = await queueStore.list(threadId, { limit: params.limit ?? 20, cursor: params.cursor ?? null });
          break;
        case 'thread/queue/update':
          result = { queuedSubmission: await queueStore.update(threadId, queuedSubmissionId, params.input) };
          break;
        case 'thread/queue/delete':
          result = await queueStore.delete(threadId, queuedSubmissionId);
          break;
        case 'thread/queue/reorder':
          result = await queueStore.reorder(threadId, params.queuedSubmissionIds);
          break;
        case 'thread/queue/start':
          result = await startQueued(threadId, queuedSubmissionId, { notify: false, requestLaunch: launch });
          break;
      }
      if (launch?.cancelled) return;
      if (Object.hasOwn(message, 'id')) toClient({ id: message.id, result });
      if (['thread/queue/add', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/reorder', 'thread/queue/start'].includes(method)) queueChanged(threadId);
      if (method === 'thread/queue/add') scheduleQueued(threadId);
    } catch (error) { if (!launch?.cancelled) queueError(message, error); }
    finally { releaseStart(launch); }
  }

  function handleChildLine(line) {
    const message = parseLine(line);
    if (!message) { toClient(line); return; }
    if (Object.hasOwn(message, 'id') && pendingInternal.has(message.id)) {
      const resolve = pendingInternal.get(message.id);
      pendingInternal.delete(message.id);
      resolve(message);
      return;
    }
    if (Object.hasOwn(message, 'id') && pendingTurnStarts.has(message.id)) {
      const threadId = pendingTurnStarts.get(message.id);
      pendingTurnStarts.delete(message.id);
      if (message.error) {
        pendingRoutedStarts.delete(threadId);
        if (activeTurns.get(threadId) === 'pending') activeTurns.delete(threadId);
      } else if (message.result?.turn) confirmRoutedStart(threadId);
    }
    if (Object.hasOwn(message, 'id') && clientModelLists.has(message.id)) {
      clientModelLists.delete(message.id);
      mergeCatalog(message.result);
    }
    if (Object.hasOwn(message, 'id') && clientThreadReads.has(message.id)) {
      observeHistory(clientThreadReads.get(message.id), message.result?.thread?.turns);
      clientThreadReads.delete(message.id);
    }
    let idleResumedThread = null;
    if (Object.hasOwn(message, 'id') && clientResumes.has(message.id)) {
      const threadId = clientResumes.get(message.id);
      clientResumes.delete(message.id);
      const resumed = message.result;
      const status = resumed?.thread?.status?.type;
      if (resumed?.thread) {
        const state = contexts.get(threadId) || {};
        state.threadRuntimeSettings = mergeRuntimeSettings(state.threadRuntimeSettings, resumed, 'reasoningEffort');
        contexts.set(threadId, state);
      }
      if (status === 'idle') {
        activeTurns.delete(threadId);
        idleResumedThread = threadId;
      } else if (status === 'active') {
        activeTurns.set(threadId, true);
      }
    }
    if (message.method === 'turn/started' && message.params?.threadId) {
      activeTurns.set(message.params.threadId, message.params.turn?.id || true);
      confirmRoutedStart(message.params.threadId);
    }
    if (message.method === 'thread/settings/updated' && message.params?.threadId) {
      const { threadId, threadSettings } = message.params;
      const state = contexts.get(threadId) || {};
      state.threadRuntimeSettings = mergeRuntimeSettings(state.threadRuntimeSettings, threadSettings);
      contexts.set(threadId, state);
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = message.params?.item;
      if (item?.type === 'userMessage' && typeof item.clientId === 'string' && typeof message.params?.threadId === 'string') {
        observedClientStarts.add(clientKey(message.params.threadId, item.clientId));
      }
    }
    if (message.method === 'item/completed') {
      const item = message.params?.item;
      const threadId = message.params?.threadId;
      if (threadId && item?.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : textFromInput(item.content);
        if (text) contexts.set(threadId, { ...(contexts.get(threadId) || {}), lastResult: capped(text, 1000) });
      }
    }
    if (message.method === 'turn/plan/updated') {
      const threadId = message.params?.threadId;
      const progress = (message.params?.plan || []).filter((step) => step?.status === 'inProgress').map((step) => step.step).join('; ');
      if (threadId && progress) contexts.set(threadId, { ...(contexts.get(threadId) || {}), progress: capped(progress, 1000) });
    }
    if (message.method === 'turn/completed') {
      const threadId = message.params?.threadId;
      if (threadId) activeTurns.delete(threadId);
      if (threadId) contexts.set(threadId, { ...(contexts.get(threadId) || {}), progress: `上一轮状态：${message.params?.turn?.status || 'unknown'}` });
    }
    toClient(line);
    if (message.method === 'turn/completed' && message.params?.threadId) scheduleQueued(message.params.threadId);
    if (idleResumedThread) scheduleQueued(idleResumedThread);
  }

  async function handleClientLine(line, message, launch) {
    if (!message) { toChild(line); return Promise.resolve(); }
    if (message.method === 'initialized') {
      initialized = true;
      toChild(line);
      void ensureCatalog();
      return Promise.resolve();
    }
    if (message.method === 'model/list' && Object.hasOwn(message, 'id')) clientModelLists.add(message.id);
    if (message.method === 'thread/read' && Object.hasOwn(message, 'id') && typeof message.params?.threadId === 'string') clientThreadReads.set(message.id, message.params.threadId);
    if (message.method === 'thread/resume' && Object.hasOwn(message, 'id') && typeof message.params?.threadId === 'string') {
      clientResumes.set(message.id, message.params.threadId);
    }
    if (message.method === 'thread/settings/update' && message.params?.threadId) {
      const { threadId } = message.params;
      const state = contexts.get(threadId) || {};
      const previous = observedSelection(state.threadRuntimeSettings);
      state.threadRuntimeSettings = mergeRuntimeSettings(state.threadRuntimeSettings, message.params);
      contexts.set(threadId, state);
      const selected = observedSelection(message.params);
      if (selected.model || selected.effort) {
        const current = await threadSettings(threadId).catch(() => null);
        const pendingRoute = pendingRoutedStarts.get(threadId)?.routed.result;
        const routeEcho = matchesSelection(selected, pendingRoute) || matchesSelection(selected, state.lastApplied);
        // A client settings/update is the picker action, including the first
        // one in this process. Server defaults and routed selection echoes do
        // not express manual intent. With no origin metadata, an update equal
        // to a one-turn override must preserve the persistent manual choice.
        if (current?.enabled && !routeEcho) {
          const manualModel = selected.model || current.manualModel || previous.model || current.fallbackModel;
          const model = models.find(entry => entry.model === manualModel || entry.id === manualModel);
          const efforts = (model?.supportedReasoningEfforts || []).map(entry => typeof entry === 'string' ? entry : entry.reasoningEffort);
          const desiredEffort = selected.effort || current.manualEffort || previous.effort || current.fallbackEffort;
          const manualEffort = !efforts.length || efforts.includes(desiredEffort) ? desiredEffort
            : model.defaultReasoningEffort || efforts[0];
          if (manualModel && manualEffort) {
            const patch = { mode: 'manual', manualModel, manualEffort };
            try {
              const saved = await setThreadSettings(threadId, patch);
              const latest = contexts.get(threadId) || {};
              contexts.set(threadId, { ...latest, routingSettings: { ...current, ...patch, ...saved },
                routingSettingsRevision: (latest.routingSettingsRevision || 0) + 1 });
            } catch (error) { diagnostic('picker persistence failed', error); }
          }
        }
      }
    }
    if (message.method === 'turn/start') return handleTurn(message, launch);
    if (message.method?.startsWith('thread/queue/')) return handleQueue(message, launch);
    toChild(line);
  }

  clientLines.on('line', (line) => {
    const message = parseLine(line);
    const isStart = ['turn/start', 'thread/queue/start'].includes(message?.method);
    const launch = isStart && typeof message.params?.threadId === 'string'
      ? registerStart(message.params.threadId, message.id, message.method === 'turn/start' ? 'client' : 'queue-client') : null;
    if (message?.method === 'turn/interrupt') {
      cancelStarts(message.params?.threadId);
      toChild(line);
      return;
    }
    ingress = ingress.then(() => handleClientLine(line, message, launch)).catch((error) => {
      diagnostic('client message failed', error);
      if (!launch?.cancelled && !launch?.sent) toChild(line);
      releaseStart(launch);
    });
  });
  serverLines.on('line', handleChildLine);
  clientLines.on('close', () => { void ingress.finally(() => child.stdin.end()); });
  child.stdout.on('end', () => clientOutput.end?.());
  return {
    get models() { return models; },
    get contexts() { return contexts; },
    async drain() { await ingress; },
    close() { clientLines.close(); serverLines.close(); },
  };
}
