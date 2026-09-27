import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function checkMigrationChecklist(content) {
  const lines = content.trimEnd().split(/\r?\n/);
  assert.ok(lines.length > 0 && lines.length <= 30, `checklist has ${lines.length} lines (limit 30)`);
  const requirements = {
    sourceType: /NUMERIC\s*\(\s*18\s*,\s*2\s*\)/i,
    targetType: /NUMERIC\s*\(\s*24\s*,\s*6\s*\)/i,
    threeServices: /三个服务|三服务|应收[\s\S]*分录[\s\S]*报表|服务[\s\S]*服务[\s\S]*服务/,
    dualWrite: /双写/,
    oldVersion: /旧版本|老版本|旧版|旧实例|旧消费者|旧型|向后兼容/,
    validation: /校验|核对|对账/,
    rollback: /回滚|回退/,
    steps: /步骤|阶段|执行顺序|切换顺序|\*\*执行\*\*/,
    dependencies: /依赖|前置条件|先决条件/,
    acceptance: /验收|通过标准|准入标准/,
  };
  const missing = Object.entries(requirements).filter(([, pattern]) => !pattern.test(content)).map(([name]) => name);
  assert.deepEqual(missing, [], `checklist misses: ${missing.join(', ')}`);
  return { lineCount: lines.length, requirements: Object.keys(requirements) };
}

function routeDecision(item) {
  const result = item.result;
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const block of result?.content || []) {
    if (block.type !== 'text') continue;
    try { const parsed = JSON.parse(block.text); if (parsed && typeof parsed === 'object') return parsed; } catch {}
  }
  return null;
}

export function findHandoffOrder(items, { requireReview = false, parentId } = {}) {
  const starts = [];
  const seenChildren = new Set(parentId ? [parentId] : []);
  const completions = new Map();
  const routes = [];
  for (const [index, item] of items.entries()) {
    const tool = item.tool || item.name || '';
    const ids = item.type === 'subAgentActivity' && item.kind === 'started' ? [item.agentThreadId]
      : item.type === 'collabAgentToolCall' && /^spawn_?agent$/i.test(tool)
        && (!item.status || item.status === 'completed') ? item.receiverThreadIds || [] : [];
    const childIds = ids.filter(id => id && !seenChildren.has(id));
    if (childIds.length) {
      childIds.forEach(id => seenChildren.add(id));
      starts.push({ index, childIds });
    }
    if (item.type === 'subAgentActivity' && item.kind === 'completed' && item.agentThreadId !== parentId) {
      if (!completions.has(item.agentThreadId)) completions.set(item.agentThreadId, index);
    }
    if (item.type === 'collabAgentToolCall' && item.status === 'completed') {
      for (const [id, state] of Object.entries(item.agentsStates || {})) {
        if (id !== parentId && state?.status === 'completed' && !completions.has(id)) completions.set(id, index);
      }
    }
    if (item.type === 'mcpToolCall' && /route_execution_subtask/.test(tool) && item.status === 'completed'
        && !item.error && !item.result?.isError) {
      const decision = routeDecision(item);
      if (!decision?.isError && !decision?.error) routes.push({ index, decision });
    }
  }
  assert.ok(routes.length, 'No completed route_execution_subtask MCP call observed');
  const reviews = starts.filter(item => item.index < routes[0].index);
  const review = reviews.find(item => item.childIds.every(id => {
    const completedAt = completions.get(id);
    return completedAt > item.index && completedAt < routes[0].index;
  }));
  if (requireReview) {
    assert.ok(reviews.length, 'No native review child spawn before Jev route');
    assert.ok(review, 'Native review child did not complete before Jev route');
  }
  const executions = routes.map((route, i) => {
    const nextRouteIndex = routes[i + 1]?.index ?? Infinity;
    const executor = starts.find(item => item.index > route.index && item.index < nextRouteIndex);
    assert.ok(executor, `No native executor spawn after Jev subtask route ${i + 1}`);
    return { routeIndex: route.index, executorIndex: executor.index, executorChildIds: executor.childIds,
      ...(route.decision ? { decision: route.decision } : {}) };
  });
  return { reviewIndex: review?.index ?? null, reviewChildIds: review?.childIds || [],
    reviewCompletionIndex: review ? Math.max(...review.childIds.map(id => completions.get(id))) : null, executions };
}

// Read once and retain the exact bytes before any acceptance assertion or scratch cleanup.
export async function preserveSyntheticArtifact(scratch, evidenceDir) {
  const name = 'migration-checklist.md';
  let bytes;
  try { bytes = await readFile(join(scratch, name)); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'missing', path: name }; throw error; }
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, name), bytes);
  return { status: 'unaccepted', path: name, byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
