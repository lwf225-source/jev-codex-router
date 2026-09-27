import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.mjs";
import {
  appendRouteRecord,
  listRecentRoutes,
  normalizeRouteRecord,
  pruneRouteRecords,
} from "../src/audit-log.mjs";
import {
  getThreadSettings,
  loadSettings,
  updateSettings,
  updateThreadSettings,
} from "../src/settings.mjs";
import { createQueuedStore } from "../src/queued-submissions.mjs";

async function temporary(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "jev-router-test-"));
  try {
    return await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("settings persist and task override/manual mode resolve", async () =>
  temporary(async (dataDir) => {
    assert.equal((await loadSettings({ dataDir })).enabled, false);
    await updateSettings(
      { enabled: true, fallback: { model: "gpt-6-sol", effort: "medium" } },
      { dataDir },
    );
    await updateThreadSettings(
      "task-1",
      {
        enabled: false,
        mode: "manual",
        manualModel: "gpt-6-astra",
        manualEffort: "high",
      },
      { dataDir },
    );
    assert.deepEqual(await getThreadSettings("task-1", { dataDir }), {
      enabled: false,
      mode: "manual",
      manualModel: "gpt-6-astra",
      manualEffort: "high",
      fallbackModel: "gpt-6-sol",
      fallbackEffort: "medium",
      timeoutMs: 2000,
      retentionDays: 30,
    });
    await updateThreadSettings(
      "task-1",
      { enabled: null, mode: "auto" },
      { dataDir },
    );
    const inherited = await getThreadSettings("task-1", { dataDir });
    assert.equal(inherited.enabled, true);
    assert.equal(inherited.mode, "auto");
    assert.equal(inherited.manualModel, null);
  }));

test("audit log whitelists metadata and prunes after 30 days", async () =>
  temporary(async (dataDir) => {
    const now = Date.now();
    const normalized = normalizeRouteRecord(
      {
        threadId: "task-1",
        model: "gpt-6-sol",
        effort: "medium",
        source: "jev",
        reasonCode: "execution_subtask",
        phase: "execution",
        escalated: true,
        prompt: "private prompt",
        context: "private context",
        apiKey: "secret",
        reason: "could contain prompt",
      },
      { now },
    );
    assert.deepEqual(
      [normalized.phase, normalized.escalated],
      ["execution", true],
    );
    assert.equal(JSON.stringify(normalized).includes("private"), false);
    assert.equal(JSON.stringify(normalized).includes("secret"), false);
    assert.equal(
      pruneRouteRecords(
        [
          {
            ...normalized,
            timestamp: new Date(now - 31 * 86400000).toISOString(),
          },
        ],
        { now },
      ).length,
      0,
    );
    const saved = await appendRouteRecord(normalized, { dataDir });
    assert.equal((await listRecentRoutes({ dataDir }))[0].id, saved.id);
    const raw = await readFile(join(dataDir, "routes.json"), "utf8");
    assert.equal(raw.includes("private"), false);
    await writeFile(
      join(dataDir, "routes.json"),
      JSON.stringify([
        { ...saved, timestamp: new Date(now - 31 * 86400000).toISOString() },
        saved,
      ]),
    );
    assert.equal((await listRecentRoutes({ dataDir })).length, 1);
    assert.equal(
      JSON.parse(await readFile(join(dataDir, "routes.json"), "utf8")).length,
      1,
    );
  }));

test("STDIO MCP handshake and management tools", async () =>
  temporary(async (dataDir) => {
    const client = new Client({ name: "jev-router-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("bin/jev-router-mcp.mjs")],
      env: {
        ...process.env,
        JEV_ROUTER_DATA_DIR: dataDir,
        TYPESAFE_API_KEY: "",
        JEV_ROUTER_DISABLE_KEYCHAIN: "1",
      },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "available_models",
        "feedback",
        "last_decision",
        "queue_status",
        "recent_routes",
        "record_execution_acceptance",
        "register_execution_plan",
        "route_execution_subtask",
        "route_preview",
        "settings",
        "status",
        "subtask_history",
        "thread_settings",
      ]);
      const status = await client.callTool({ name: "status", arguments: {} });
      assert.equal(status.structuredContent.global.enabled, false);
      const changed = await client.callTool({
        name: "settings",
        arguments: { timeoutMs: 1500 },
      });
      assert.equal(changed.structuredContent.timeoutMs, 1500);
      const manual = await client.callTool({
        name: "thread_settings",
        arguments: {
          threadId: "thread-A",
          mode: "manual",
          manualModel: "gpt-6-astra",
          manualEffort: "high",
        },
      });
      assert.equal(manual.structuredContent.mode, "manual");
      const queue = await client.callTool({
        name: "queue_status",
        arguments: { threadId: "thread-A" },
      });
      assert.equal(queue.structuredContent.pendingCountAtLeast, 0);
      assert.equal(
        (await loadSettings({ dataDir })).threads["thread-A"].manualModel,
        "gpt-6-astra",
      );
      const preview = await client.callTool({
        name: "route_preview",
        arguments: {
          prompt: "hello",
          models: [{ id: "gpt-6-sol", supportedReasoningEfforts: ["medium"] }],
        },
      });
      assert.equal(preview.structuredContent.source, "fallback");
      assert.ok(
        ["missing_key", "capability_limited"].includes(
          preview.structuredContent.reasonCode,
        ),
      );
    } finally {
      await client.close();
    }
  }));

test("subtask_history reads explicit parent history without credentials or model execution", async () =>
  temporary(async (dataDir) => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let received;
    const server = createMcpServer({
      dataDir,
      readKey: async () => {
        throw new Error("history must not read a credential");
      },
      listModels: async () => {
        throw new Error("history must not discover routing models");
      },
      inspectHistory: async (args) => {
        received = args;
        return {
          threadId: args.threadId,
          tasks: [
            {
              childThreadId: "child-1",
              name: "review",
              status: "completed",
              configuredModel: "gpt-6-sol",
            },
          ],
          coverage: { truncated: false },
        };
      },
    });
    const client = new Client({ name: "jev-history-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({
        name: "subtask_history",
        arguments: { threadId: "parent-test", limit: 10, includeResults: true },
      });
      assert.deepEqual(received, {
        threadId: "parent-test",
        limit: 10,
        includeResults: true,
      });
      assert.equal(response.structuredContent.tasks[0].status, "completed");
      assert.deepEqual(await listRecentRoutes({ dataDir }), []);
    } finally {
      await client.close();
      await server.close();
    }
  }));

test("route_execution_subtask passes bounded plan inputs to Jev and does not persist task text", async () =>
  temporary(async (dataDir) => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let received;
    let logged;
    const liveCatalog = [
      {
        id: "gpt-6-sol",
        model: "gpt-6-sol",
        supportedReasoningEfforts: ["medium"],
      },
    ];
    const server = createMcpServer({
      dataDir,
      readKey: async () => "test-key",
      listModels: async () => liveCatalog,
      recordRoute: async (record, options) => {
        logged = { record, options };
        return appendRouteRecord(record, options);
      },
      chooseSubtaskRoute: async (options) => {
        received = options;
        return {
          model: "gpt-6-sol",
          effort: "medium",
          phase: "execution",
          source: "jev",
          reason: "Jev 按已规划子任务选型",
        };
      },
    });
    const client = new Client({
      name: "jev-subtask-routing-test",
      version: "1.0.0",
    });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({
        name: "route_execution_subtask",
        arguments: {
          task: "Implement one bounded feature",
          acceptanceCriteria: "The feature passes its acceptance checks",
          planSummary: "Three steps total",
          dependencies: "Step two follows step one",
          threadId: "task-subtask-1",
          previousModel: "gpt-6-luna",
          previousEffort: "low",
          failureSummary: "Missing interface in first attempt",
        },
      });
      assert.deepEqual(
        [
          response.structuredContent.model,
          response.structuredContent.effort,
          response.structuredContent.phase,
        ],
        ["gpt-6-sol", "medium", "execution"],
      );
      assert.match(
        response.structuredContent.routingToken,
        /^jev_[a-f0-9]{32}$/,
      );
      assert.equal(
        response.structuredContent.routingToken,
        `jev_${response.structuredContent.routeId.replaceAll("-", "")}`,
      );
      assert.equal(received.apiKey, "test-key");
      assert.deepEqual(received.models, liveCatalog);
      assert.equal(received.task, "Implement one bounded feature");
      assert.equal(
        received.acceptanceCriteria,
        "The feature passes its acceptance checks",
      );
      assert.equal(received.dependencies, "Step two follows step one");
      assert.deepEqual(
        [
          received.previousModel,
          received.previousEffort,
          received.failureSummary,
        ],
        ["gpt-6-luna", "low", "Missing interface in first attempt"],
      );
      assert.equal(received.threadId, "task-subtask-1");
      assert.equal(logged?.options.dataDir, dataDir);
      assert.equal(logged?.record.threadId, "task-subtask-1");
      assert.equal(logged?.record.id, response.structuredContent.routeId);
      assert.match(received.context.summary, /Three steps total/);
      const routeFile = await readFile(
        join(dataDir, "routes.json"),
        "utf8",
      ).catch(() => "[]");
      assert.notEqual(
        routeFile,
        "[]",
        `route log missing; settings dir: ${dataDir}`,
      );
      assert.equal(
        JSON.stringify(await listRecentRoutes({ dataDir })).includes(
          "Implement one bounded feature",
        ),
        false,
      );
      const records = await listRecentRoutes({
        threadId: "task-subtask-1",
        dataDir,
      });
      assert.deepEqual(
        [records[0].reasonCode, records[0].phase],
        ["execution_subtask", "execution"],
      );
      assert.equal(records[0].escalated, undefined);
    } finally {
      await client.close();
      await server.close();
    }
  }));

test("route_preview forwards bounded catalog and effective task settings without logging prompt", async () =>
  temporary(async (dataDir) => {
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "test-key";
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let received;
    const liveCatalog = [
      {
        id: "gpt-6-astra",
        model: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        inputModalities: ["text", "image"],
      },
    ];
    const server = createMcpServer({
      dataDir,
      listModels: async () => liveCatalog,
      chooseRoute: async (options) => {
        received = options;
        return {
          model: "gpt-6-astra",
          effort: "high",
          reason: "Jev 判断：任务需要深入推理",
          source: "jev",
          confidence: 0.8,
          elapsedMs: 3,
        };
      },
    });
    const client = new Client({ name: "jev-router-test", version: "1.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await updateThreadSettings(
        "task-2",
        { mode: "manual", manualModel: "gpt-6-astra", manualEffort: "high" },
        { dataDir },
      );
      const response = await client.callTool({
        name: "route_preview",
        arguments: {
          prompt: "private prompt",
          threadId: "task-2",
          models: [{ id: "gpt-6-astra", supportedReasoningEfforts: ["high"] }],
        },
      });
      assert.equal(response.structuredContent.model, "gpt-6-astra");
      assert.equal(received.settings.mode, "manual");
      assert.equal(received.settings.manualModel, "gpt-6-astra");
      assert.equal(received.prompt, "private prompt");
      const available = await client.callTool({
        name: "available_models",
        arguments: {},
      });
      assert.equal(available.structuredContent.models[0].id, "gpt-6-astra");
      const discovered = await client.callTool({
        name: "route_preview",
        arguments: { prompt: "A second test prompt" },
      });
      assert.equal(discovered.structuredContent.model, "gpt-6-astra");
      assert.deepEqual(received.models, liveCatalog);
      assert.deepEqual(await listRecentRoutes({ dataDir }), []);
      await appendRouteRecord(
        {
          threadId: "task-2",
          model: "gpt-6-astra",
          effort: "high",
          source: "jev",
          reasonCode: "complex_reasoning",
        },
        { dataDir },
      );
      const last = await client.callTool({
        name: "last_decision",
        arguments: { threadId: "task-2" },
      });
      assert.match(last.structuredContent.route.reason, /深入推理/);
      const pendingQueue = createQueuedStore({ dataDir });
      const queued = await pendingQueue.add({
        threadId: "task-2",
        input: [
          { type: "text", text: "private queue text", text_elements: [] },
        ],
        clientUserMessageId: "client-2",
      });
      await pendingQueue.markStarting("task-2", queued.id, queued.input);
      const queueStatus = await client.callTool({
        name: "queue_status",
        arguments: { threadId: "task-2" },
      });
      assert.equal(
        queueStatus.structuredContent.unconfirmedStarts[0].state,
        "unknown",
      );
      assert.equal(
        JSON.stringify(queueStatus.structuredContent).includes(
          "private queue text",
        ),
        false,
      );
    } finally {
      await client.close();
      await server.close();
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
    }
  }));

test("routing tools bound hung credential reads and do not dispatch late decisions", async () =>
  temporary(async (dataDir) => {
    await updateSettings({ timeoutMs: 100 }, { dataDir });
    const [a, b] = InMemoryTransport.createLinkedPair();
    let calls = 0;
    const catalog = [
      {
        id: "gpt-6-astra",
        supportedReasoningEfforts: ["high", "xhigh"],
        inputModalities: ["text"],
      },
    ];
    const server = createMcpServer({
      dataDir,
      readKey: () => new Promise(() => {}),
      listModels: async () => catalog,
      chooseSubtaskRoute: async () => {
        calls++;
        return { model: "gpt-6-astra", effort: "high" };
      },
    });
    const client = new Client({ name: "deadline-test", version: "1" });
    try {
      await server.connect(b);
      await client.connect(a);
      for (const name of ["route_preview", "route_execution_subtask"]) {
        const started = Date.now();
        const response = await client.callTool({
          name,
          arguments:
            name === "route_preview"
              ? { prompt: "Unknown request" }
              : { threadId: "budget-test", task: "Unknown task" },
        });
        assert.ok(Date.now() - started < 600);
        assert.equal(response.structuredContent.reasonCode, "timeout");
        assert.equal(response.structuredContent.model, "gpt-6-astra");
      }
      assert.equal(calls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  }));

test("preview preserves structured context and cancels hung catalog discovery", async () =>
  temporary(async (dataDir) => {
    await updateSettings({ timeoutMs: 100 }, { dataDir });
    const [a, b] = InMemoryTransport.createLinkedPair();
    let received;
    let discovery;
    const server = createMcpServer({
      dataDir,
      readKey: async () => null,
      listModels: (options) => {
        discovery = options;
        return new Promise(() => {});
      },
      chooseRoute: async (args) => {
        received = args;
        return { nextAction: "execute", model: "gpt-6-astra", effort: "high" };
      },
    });
    const client = new Client({ name: "context-test", version: "1" });
    try {
      await server.connect(b);
      await client.connect(a);
      await client.callTool({
        name: "route_preview",
        arguments: {
          prompt: "Context test",
          models: [{ id: "gpt-6-astra", supportedReasoningEfforts: ["high"] }],
          context: {
            goal: "goal",
            constraints: ["constraint"],
            phase: "planning",
            acceptanceCriteria: "criteria",
            attachmentStatus: "unreadable",
          },
        },
      });
      assert.equal(received.context.goal, "goal");
      assert.deepEqual(received.context.constraints, ["constraint"]);
      assert.equal(received.context.stage, "planning");
      assert.equal(received.context.contextComplete, false);
      await client.callTool({
        name: "route_preview",
        arguments: { prompt: "Catalog test" },
      });
      assert.equal(discovery.signal.aborted, true);
      assert.ok(discovery.timeoutMs <= 100);
    } finally {
      await client.close();
      await server.close();
    }
  }));

test("planned route total deadline prevents a late execution attempt", async () =>
  temporary(async (dataDir) => {
    await updateSettings({ timeoutMs: 100 }, { dataDir });
    const [a, b] = InMemoryTransport.createLinkedPair();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const server = createMcpServer({
      dataDir,
      readKey: async () => null,
      chooseSubtaskRoute: async () => {
        await gate;
        return { model: "gpt-6-astra", effort: "high", nextAction: "execute" };
      },
    });
    const client = new Client({ name: "plan-deadline", version: "1" });
    try {
      await server.connect(b);
      await client.connect(a);
      await client.callTool({
        name: "register_execution_plan",
        arguments: {
          threadId: "budget-plan",
          units: [
            {
              unitId: "one",
              task: "bounded task",
              acceptanceCriteria: "bounded result",
            },
          ],
        },
      });
      const started = Date.now();
      const result = await client.callTool({
        name: "route_execution_subtask",
        arguments: {
          threadId: "budget-plan",
          unitId: "one",
          task: "bounded task",
          acceptanceCriteria: "bounded result",
          models: [{ id: "gpt-6-astra", supportedReasoningEfforts: ["high"] }],
        },
      });
      assert.ok(Date.now() - started < 500);
      assert.equal(result.structuredContent.nextAction, "stop");
      assert.equal(result.structuredContent.reasonCode, "timeout");
      assert.equal(result.structuredContent.routeId, undefined);
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const plans = JSON.parse(
        await readFile(join(dataDir, "execution-plans.json"), "utf8"),
      );
      assert.equal(plans[0].units[0].attempts.length, 0);
    } finally {
      release();
      await client.close();
      await server.close();
    }
  }));
