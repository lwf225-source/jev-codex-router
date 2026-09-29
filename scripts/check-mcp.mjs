#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dataDir = await mkdtemp(join(tmpdir(), 'jev-mcp-check-'));
const client = new Client({ name: 'jev-router-check', version: '0.1.0' });
const testTimeout = Number(process.argv.find(arg => arg.startsWith('--timeout-ms='))?.split('=')[1] || 2000);
assert.ok(Number.isInteger(testTimeout) && testTimeout >= 100 && testTimeout <= 10000);
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '..', 'bin', 'jev-router-mcp.mjs')],
    env: { ...process.env, JEV_ROUTER_DATA_DIR: dataDir },
  }));
  const status = (await client.callTool({ name: 'status', arguments: {} })).structuredContent;
  await client.callTool({ name: 'settings', arguments: { timeoutMs: testTimeout } });
  const models = (await client.callTool({ name: 'available_models', arguments: {} })).structuredContent.models;
  const result = await client.callTool({ name: 'route_preview', arguments: {
    prompt: 'Return the exact corrected text for this spelling correction: change "Jev roter selects a model." to "Jev router selects a model." No file access or other changes are needed.',
  } });
  assert.equal(status.typesafeConfigured, true, 'TypeSafe credential is unavailable');
  assert.ok(models.length > 0, 'Native model catalog is empty');
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(result.structuredContent.source, 'jev', `Jev did not return a live judgment: ${result.structuredContent.reasonCode} (${result.structuredContent.elapsedMs}ms)`);
  assert.ok(models.some((model) => model.id === result.structuredContent.model), 'Route selected a model outside the native catalog');
  const task = 'Return the exact corrected sentence: replace "roter" with "router" in "Jev roter selects a model." No tools or file access are needed.';
  const acceptanceCriteria = 'The returned sentence is exactly: Jev router selects a model.';
  await client.callTool({ name: 'register_execution_plan', arguments: { threadId: 'mcp-stage-check', units: [{ unitId: 'spelling', task, acceptanceCriteria }] } });
  const subtask = await client.callTool({ name: 'route_execution_subtask', arguments: {
    threadId: 'mcp-stage-check',
    unitId: 'spelling', task, acceptanceCriteria,
    planSummary: 'This is one already-planned, bounded documentation unit.',
    dependencies: 'No dependencies.',
  } });
  assert.equal(subtask.isError, undefined, subtask.content?.[0]?.text);
  assert.equal(subtask.structuredContent.source, 'jev', 'Jev did not return a live subtask judgment');
  assert.equal(subtask.structuredContent.phase, 'execution');
  assert.equal(subtask.structuredContent.nextAction, 'execute', 'Synthetic execution was blocked by its routing decision');
  assert.ok(models.some((model) => model.id === subtask.structuredContent.model), 'Subtask route selected a model outside the native catalog');
  const history = (await client.callTool({ name: 'recent_routes', arguments: { threadId: 'mcp-stage-check' } })).structuredContent.routes;
  assert.equal(history.length, 1, 'Subtask model choice was not written to local metadata');
  assert.deepEqual([history[0].reasonCode, history[0].phase], [subtask.structuredContent.reasonCode || 'execution_subtask', 'execution']);
  assert.equal(JSON.stringify(history).includes('Update one concise README'), false, 'Subtask text was written to route history');
  process.stdout.write(`${JSON.stringify({
    typeSafeConfigured: status.typesafeConfigured,
    availableModelCount: models.length,
    route: {
      model: result.structuredContent.model,
      effort: result.structuredContent.effort,
      source: result.structuredContent.source,
      elapsedMs: result.structuredContent.elapsedMs,
    },
    subtaskRoute: {
      model: subtask.structuredContent.model,
      effort: subtask.structuredContent.effort,
      source: subtask.structuredContent.source,
      elapsedMs: subtask.structuredContent.elapsedMs,
    },
  })}\n`);
} finally {
  await client.close();
  await rm(dataDir, { recursive: true, force: true });
}
