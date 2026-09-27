import { createNativeHistoryReader } from './native-history-reader.mjs';

const PARENT_PAGE_SIZE = 100;
const PARENT_MAX_PAGES = 5;
const RESULT_PAGE_SIZE = 50;
const RESULT_MAX_PAGES = 2;
const RESULT_MAX_CHARS = 2000;
const ROUTING_TOKEN = /^jev_[a-f0-9]{32}$/;
const text = (value) => typeof value === 'string' && value ? value : null;
const errorText = (error) => String(error?.message || error || 'History read failed').slice(0, 500);
const unwrapThread = (response) => response?.thread || response;
const statusType = (thread) => text(thread?.status?.type) || text(thread?.status);

function latestTurn(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return turns.at(-1);
}

function normalizedStatus(value) {
  return ({ inProgress: 'running', active: 'running', pendingInit: 'pending', errored: 'failed', systemError: 'failed' })[value]
    || (['completed', 'interrupted', 'failed', 'running', 'idle', 'shutdown', 'pending'].includes(value) ? value : 'unknown');
}

function taskStatus(thread, candidate) {
  const runtime = statusType(thread);
  if (runtime === 'active' || runtime === 'systemError') return { status: normalizedStatus(runtime), statusSource: 'thread' };
  const turnStatus = latestTurn(thread)?.status;
  if (turnStatus) return { status: normalizedStatus(turnStatus), statusSource: 'latestTurn' };
  if (candidate.observedStatus && candidate.observedStatus !== 'unknown') {
    return { status: candidate.observedStatus, statusSource: 'parentActivity' };
  }
  return { status: normalizedStatus(runtime), statusSource: runtime === 'idle' ? 'thread' : 'unknown' };
}

function flattenLegacy(thread, maxItems) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  let truncated = false;
  const entries = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.itemsView && turn.itemsView !== 'full') truncated = true;
    if (!Array.isArray(turn.items)) { truncated = true; continue; }
    for (let j = turn.items.length - 1; j >= 0; j--) {
      if (entries.length === maxItems) { truncated = true; break; }
      entries.push({ turnId: turn.id, turnStatus: turn.status, item: turn.items[j] });
    }
    if (entries.length === maxItems && i > 0) { truncated = true; break; }
  }
  return { entries, pagesRead: 0, truncated, complete: !truncated, source: 'legacyTurns' };
}

async function readHistory(thread, { readThread, readItems, pageSize, maxPages, registrationScope }) {
  const maxItems = pageSize * maxPages;
  if (thread.historyMode === 'legacy' || (!thread.historyMode && thread.turns?.length)) {
    let hydrated = thread;
    if (!thread.turns?.length || thread.turns.some((turn) => turn.itemsView && turn.itemsView !== 'full')) {
      hydrated = unwrapThread(await readThread({ threadId: thread.id, includeTurns: true }));
      if (hydrated?.id !== thread.id || !Array.isArray(hydrated.turns)) throw new Error('Invalid legacy thread history response');
    }
    return { ...flattenLegacy(hydrated, maxItems), thread: hydrated };
  }
  const entries = [];
  const cursors = new Set();
  let cursor;
  let pagesRead = 0;
  try {
    for (; pagesRead < maxPages;) {
      const page = await readItems({ threadId: thread.id, limit: pageSize, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
      pagesRead++;
      if (!Array.isArray(page?.data)) throw new Error('Invalid thread/items/list response');
      const room = maxItems - entries.length;
      entries.push(...page.data.slice(0, Math.min(room, pageSize)));
      const overflow = page.data.length > Math.min(room, pageSize);
      if (!Object.hasOwn(page, 'nextCursor') || (page.nextCursor !== null && !text(page.nextCursor))) {
        throw new Error('History pagination response omitted a valid nextCursor');
      }
      const next = text(page.nextCursor);
      if (next && cursors.has(next)) throw new Error('History pagination repeated a cursor');
      if (!overflow && registrationScope) {
        const index = entries.findIndex((entry) => registrationBoundary(entry, thread.id, registrationScope));
        if (index >= 0) {
          const boundary = registrationBoundary(entries[index], thread.id, registrationScope);
          const truncated = index < entries.length - 1 || Boolean(next);
          // Do not discover children or conflicting tokens from ancient plans.
          return { entries: entries.slice(0, index + 1), pagesRead, truncated,
            complete: !truncated, source: 'itemsList', thread, boundary };
        }
      }
      if (overflow) return { entries, pagesRead, truncated: true, complete: false, source: 'itemsList', thread };
      if (!next) return { entries, pagesRead, truncated: false, complete: true, source: 'itemsList', thread };
      cursors.add(next);
      cursor = next;
    }
    return { entries, pagesRead, truncated: true, complete: false, source: 'itemsList', thread };
  } catch (error) {
    // Older app servers omit historyMode and do not implement item pagination.
    // The native transport still bounds the legacy response bytes.
    if (!thread.historyMode && pagesRead === 0 && entries.length === 0) {
      const hydrated = unwrapThread(await readThread({ threadId: thread.id, includeTurns: true }));
      if (hydrated?.id !== thread.id || !Array.isArray(hydrated.turns)) throw error;
      return { ...flattenLegacy(hydrated, maxItems), thread: hydrated };
    }
    return { entries, pagesRead, truncated: true, complete: false, source: 'itemsList', thread, readError: errorText(error) };
  }
}

function successfulResults(item, tool) {
  if (item?.type !== 'mcpToolCall' || item.server !== 'jev-router' || item.tool !== tool
    || item.status !== 'completed' || item.error || item.result?.isError) return [];
  const possibilities = [item.result?.structuredContent];
  for (const entry of item.result?.content || []) {
    if (entry?.type !== 'text' || typeof entry.text !== 'string') continue;
    try { possibilities.push(JSON.parse(entry.text)); } catch { /* Not a JSON tool record. */ }
  }
  return possibilities.filter((value) => value && !value.isError);
}

function registrationBoundary(entry, threadId, scope) {
  const createdAtMs = Date.parse(scope.createdAt);
  const { startedAtMs, completedAtMs } = entry;
  if (!scope.originPlanId || !Number.isFinite(createdAtMs) ||
    !Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) ||
    startedAtMs > createdAtMs || completedAtMs < createdAtMs) return null;
  const item = entry.item;
  let args = item?.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (args?.threadId !== threadId) return null;
  const values = successfulResults(item, 'register_execution_plan');
  if (!values.length || values.some((value) => value.planId !== scope.originPlanId ||
    (value.threadId && value.threadId !== threadId) ||
    (value.createdAt && value.createdAt !== scope.createdAt))) return null;
  return { originPlanId: scope.originPlanId, createdAt: scope.createdAt, startedAtMs, completedAtMs };
}

function routeSuggestion(item) {
  return successfulResults(item, 'route_execution_subtask')
    .find((value) => ROUTING_TOKEN.test(value.routingToken) && text(value.model)) || null;
}

function taskName(child, candidate) {
  const pathName = candidate.agentPath?.split('/').filter(Boolean).at(-1);
  const descriptivePath = pathName && !ROUTING_TOKEN.test(pathName) ? pathName : null;
  return text(child.name) || descriptivePath || text(child.agentNickname) || pathName || candidate.childThreadId;
}

function collectCandidates(entries, threadId) {
  const candidates = new Map();
  const suggestions = new Map();
  const conflictedTokens = new Set();
  const latestStates = new Map();
  let ignoredParentReferences = 0;
  const ensure = (id) => {
    if (!candidates.has(id)) candidates.set(id, { childThreadId: id, observedStatus: latestStates.get(id) || 'unknown' });
    return candidates.get(id);
  };
  // Entries are newest first. Status is the newest recorded observation.
  for (const entry of entries) {
    const item = entry?.item || entry;
    const suggestion = routeSuggestion(item);
    if (suggestion) {
      const previous = suggestions.get(suggestion.routingToken);
      if (previous && (previous.model !== suggestion.model || previous.effort !== suggestion.effort)) conflictedTokens.add(suggestion.routingToken);
      else suggestions.set(suggestion.routingToken, suggestion);
    }
    if (item?.type === 'subAgentActivity') {
      const id = text(item.agentThreadId);
      if (!id) continue;
      if (id === threadId) { ignoredParentReferences++; continue; }
      const candidate = ensure(id);
      candidate.agentPath ||= text(item.agentPath);
      if (!latestStates.has(id)) {
        const observed = ({ started: 'running', completed: 'completed', interrupted: 'interrupted', interacted: 'unknown' })[item.kind] || 'unknown';
        latestStates.set(id, observed);
        candidate.observedStatus = observed;
      }
      continue;
    }
    if (item?.type !== 'collabAgentToolCall' || item.senderThreadId !== threadId) continue;
    const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    for (const id of ids) {
      if (!text(id)) continue;
      if (id === threadId) { ignoredParentReferences++; continue; }
      if (!latestStates.has(id)) {
        const observed = normalizedStatus(item.agentsStates?.[id]?.status);
        if (observed !== 'unknown') latestStates.set(id, observed);
      }
      if (item.tool !== 'spawnAgent') continue;
      const candidate = ensure(id);
      candidate.spawnRecord = true;
      candidate.requestedModel = text(item.model);
      candidate.requestedEffort = text(item.reasoningEffort);
    }
  }
  for (const candidate of candidates.values()) {
    candidate.observedStatus = latestStates.get(candidate.childThreadId) || 'unknown';
    const token = candidate.agentPath?.split('/').filter(Boolean).at(-1);
    if (token && ROUTING_TOKEN.test(token)) candidate.routingToken = token;
  }
  const tokenCounts = new Map();
  for (const candidate of candidates.values()) if (candidate.routingToken) tokenCounts.set(candidate.routingToken, (tokenCounts.get(candidate.routingToken) || 0) + 1);
  for (const [token, count] of tokenCounts) if (count > 1) conflictedTokens.add(token);
  return { candidates: [...candidates.values()], suggestions, conflictedTokens, ignoredParentReferences };
}

function comparison(requested, configured) {
  return requested && configured ? (requested === configured ? 'match' : 'different') : 'unknown';
}

function configuredMatches(suggestion, thread) {
  if (!suggestion || !text(thread?.model) || !text(suggestion.model)) return null;
  if (suggestion.model !== thread.model) return false;
  if (!text(suggestion.effort) || !text(thread.reasoningEffort)) return null;
  return suggestion.effort === thread.reasoningEffort;
}

/**
 * Read directly referenced children only. Models below describe requested and
 * configured values; native thread metadata is not execution telemetry.
 * No prompts/results are written to disk, and no task is started or resumed.
 */
export async function inspectSubtasks({ threadId, limit = 20, includeResults = false, readThread, readItems, registrationScope } = {}) {
  if (!text(threadId) || threadId.length > 200 || /[\s\u0000-\u001f]/.test(threadId)) throw new Error('threadId must be a non-empty thread identifier');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer between 1 and 50');
  if (typeof includeResults !== 'boolean') throw new Error('includeResults must be a boolean');
  if ((readThread && !readItems) || (!readThread && readItems)) throw new Error('Provide both readThread and readItems when injecting history readers');
  const report = {
    threadId,
    tasks: [],
    truncated: false,
    coverage: {
      historyMode: 'unknown', parentHistory: 'unknown', globalHistory: 'unknown', parentItemsRead: 0, parentPagesRead: 0,
      parentItemLimit: PARENT_PAGE_SIZE * PARENT_MAX_PAGES, childLimit: limit, candidateCount: 0,
      omittedByLimit: 0, excludedReferences: [], ignoredParentReferences: 0,
      unlinkedRoutingTokens: [], conflictedRoutingTokens: [],
      modelEvidence: 'requested-and-configured-only',
    },
  };
  let native;
  try {
    if (!readThread) {
      native = await createNativeHistoryReader();
      ({ readThread, readItems } = native);
    }
    const parent = unwrapThread(await readThread({ threadId, includeTurns: false }));
    if (parent?.id !== threadId) throw new Error('Parent thread response did not match the requested thread');
    report.coverage.historyMode = text(parent.historyMode) || 'unknown';
    const history = await readHistory(parent, { readThread, readItems, pageSize: PARENT_PAGE_SIZE, maxPages: PARENT_MAX_PAGES, registrationScope });
    report.coverage.parentHistory = history.complete ? 'complete' : 'unknown';
    report.coverage.globalHistory = history.complete ? 'complete' : history.readError ? 'unknown' : 'truncated';
    if (registrationScope) report.coverage.currentPlan = {
      planId: registrationScope.planId,
      coverage: history.boundary ? 'complete' : 'incomplete',
      ...(history.boundary ? { boundary: history.boundary } : { reasonCode: 'registration_boundary_unproven' }),
    };
    report.coverage.parentItemsRead = history.entries.length;
    report.coverage.parentPagesRead = history.pagesRead;
    report.truncated = history.truncated;
    if (history.readError) report.readError = history.readError;
    const { candidates, suggestions, conflictedTokens, ignoredParentReferences } = collectCandidates(history.entries, threadId);
    report.coverage.candidateCount = candidates.length;
    report.coverage.ignoredParentReferences = ignoredParentReferences;
    report.coverage.conflictedRoutingTokens = [...conflictedTokens];
    const linkedTokens = new Set();
    for (const candidate of candidates.slice(0, limit)) {
      const task = {
        childThreadId: candidate.childThreadId,
        name: candidate.agentPath || candidate.childThreadId,
        nickname: null,
        parentThreadId: candidate.spawnRecord ? threadId : null,
        relationship: candidate.spawnRecord ? 'spawnRecordOnly' : 'unknown',
        status: 'unknown', statusSource: 'unknown',
        ...(candidate.spawnRecord ? { requestedModel: candidate.requestedModel, requestedEffort: candidate.requestedEffort } : {}),
        configuredModel: null, configuredEffort: null,
        modelComparison: 'unknown', effortComparison: 'unknown',
        suggestedModel: null, suggestedEffort: null, configuredMatchesSuggestion: null,
        suggestionMatchBasis: 'suggested-vs-configured',
        ...(includeResults ? { result: null, resultTruncated: false } : {}),
      };
      if (candidate.routingToken) task.routingToken = candidate.routingToken;
      try {
        let child = unwrapThread(await readThread({ threadId: candidate.childThreadId, includeTurns: false }));
        if (child?.id !== candidate.childThreadId) throw new Error('Child thread response did not match the requested thread');
        if (Object.hasOwn(child, 'parentThreadId') && child.parentThreadId !== threadId) {
          report.coverage.excludedReferences.push({ childThreadId: candidate.childThreadId, reason: 'parentThreadIdMismatch' });
          continue;
        }
        if (child.parentThreadId === threadId) {
          task.parentThreadId = threadId;
          task.relationship = 'verified';
        } else if (!candidate.spawnRecord) {
          report.coverage.excludedReferences.push({ childThreadId: candidate.childThreadId, reason: 'parentThreadIdUnknown' });
          continue;
        }
        task.nickname = text(child.agentNickname);
        task.name = taskName(child, candidate);
        task.configuredModel = text(child.model);
        task.configuredEffort = text(child.reasoningEffort);
        task.modelComparison = comparison(task.requestedModel, task.configuredModel);
        task.effortComparison = comparison(task.requestedEffort, task.configuredEffort);
        const suggestion = !conflictedTokens.has(candidate.routingToken) && suggestions.get(candidate.routingToken);
        if (suggestion) {
          linkedTokens.add(candidate.routingToken);
          task.suggestedModel = text(suggestion.model);
          task.suggestedEffort = text(suggestion.effort);
          task.configuredMatchesSuggestion = configuredMatches(suggestion, child);
        }
        Object.assign(task, taskStatus(child, candidate));
        if (includeResults || child.historyMode === 'legacy') {
          const results = await readHistory(child, { readThread, readItems, pageSize: RESULT_PAGE_SIZE, maxPages: RESULT_MAX_PAGES });
          child = results.thread;
          if (results.readError) task.readError = results.readError;
          if (includeResults) {
            task.resultCoverage = results.complete ? 'complete' : 'unknown';
            task.resultHistoryTruncated = results.truncated;
            const final = results.entries.find((entry) => entry.item?.type === 'agentMessage' && (
              ['final_answer', 'final'].includes(entry.item.phase) || (!entry.item.phase && entry.turnStatus === 'completed')
            ));
            if (final && typeof final.item.text === 'string') {
              task.result = final.item.text.slice(0, RESULT_MAX_CHARS);
              task.resultTruncated = final.item.text.length > RESULT_MAX_CHARS;
            }
          }
        }
        Object.assign(task, taskStatus(child, candidate));
      } catch (error) {
        task.readError = errorText(error);
      }
      report.tasks.push(task);
    }
    report.coverage.omittedByLimit = Math.max(0, candidates.length - limit);
    report.truncated ||= report.coverage.omittedByLimit > 0;
    report.coverage.unlinkedRoutingTokens = [...suggestions.keys()].filter((token) => !linkedTokens.has(token));
    return report;
  } catch (error) {
    report.readError = errorText(error);
    report.truncated = true;
    return report;
  } finally {
    native?.close();
  }
}
