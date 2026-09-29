import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  loadSettings,
  updateSettings,
  getThreadSettings,
  updateThreadSettings,
} from "./settings.mjs";
import {
  addRouteFeedback,
  appendRouteRecord,
  listRecentRoutes,
} from "./audit-log.mjs";
import { readTypeSafeKey } from "./credential.mjs";
import { listNativeCodexModels } from "./model-catalog.mjs";
import { createQueuedStore } from "./queued-submissions.mjs";
import { inspectSubtasks } from "./subtask-history.mjs";
import { buildRoutePresentation, ROUTE_OBSERVABILITY_VERSION, ROUTE_REASON_TEXT } from "./route-presentation.mjs";
import { announceRoute, scheduleRouteNotice } from "./desktop-notice.mjs";
import {
  registerExecutionPlan,
  readExecutionPlan,
  executionHistoryScope,
  recordExecutionAcceptance,
  routePlannedUnit,
  reconcileExecutionPlan,
} from "./execution-plan.mjs";

const effort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const model = z.string().regex(/^gpt-[a-z0-9][a-z0-9.-]{1,80}$/i);
const threadId = z.string().min(1).max(256);
const contextSchema = z.object({
  goal: z.string().max(2000).optional(),
  plannerModel: model.optional(),
  requireIndependentReview: z.boolean().optional(),
  constraints: z.array(z.string().max(1000)).max(20).optional(),
  phase: z.string().max(100).optional(),
  stage: z.string().max(100).optional(),
  dependencies: z.string().max(1200).optional(),
  acceptanceCriteria: z.string().max(2000).optional(),
  lastResult: z.string().max(2000).optional(),
  summary: z.string().max(4000).optional(),
  progress: z.string().max(2000).optional(),
  attachmentStatus: z
    .enum(["none", "readable", "unreadable", "unknown"])
    .optional(),
  inputModalities: z
    .array(z.enum(["text", "image", "localImage", "audio"]))
    .max(4)
    .optional(),
  contextComplete: z.boolean().optional(),
  continuation: z.boolean().optional(),
  goalChanged: z.boolean().optional(),
  taskKind: z
    .enum([
      "routine",
      "code",
      "diagnostic",
      "writing",
      "research",
      "architecture",
      "review",
      "unknown",
    ])
    .optional(),
  previousRoute: z
    .object({
      model,
      effort,
      taskKind: z.string().max(30).optional(),
      phase: z.enum(["direct", "plan_execute", "execution"]).optional(),
      highRisk: z.boolean().optional(),
      needsSecondOpinion: z.boolean().optional(),
      capabilityFloor: z.number().min(0).max(3).optional(),
    })
    .optional(),
});
const routeContext = (context) => ({
  ...context,
  stage: context?.stage ?? context?.phase,
  attachmentState: context?.attachmentStatus,
  inputModalities:
    context?.inputModalities ??
    (context?.attachmentStatus && context.attachmentStatus !== "none"
      ? ["text", "image"]
      : ["text"]),
  contextComplete:
    context?.contextComplete !== false &&
    !["unknown", "unreadable"].includes(context?.attachmentStatus),
});
const result = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const failure = (error) => ({
  isError: true,
  content: [
    {
      type: "text",
      text:
        error instanceof TypeError
          ? error.message
          : "Jev router operation failed; check local server logs.",
    },
  ],
});
const safely = (fn) => async (args) => {
  try {
    return result(await fn(args));
  } catch (error) {
    console.error("Jev router MCP operation failed:", error?.name ?? "Error");
    return failure(error);
  }
};
const reasonText = ROUTE_REASON_TEXT;
const describeRoute = (route) =>
  route
    ? { ...route, reason: reasonText[route.reasonCode] || reasonText.unknown }
    : null;

export function createMcpServer({
  dataDir,
  chooseRoute,
  chooseSubtaskRoute,
  recordRoute = appendRouteRecord,
  readKey = readTypeSafeKey,
  listModels = listNativeCodexModels,
  inspectHistory = inspectSubtasks,
  announce = announceRoute,
} = {}) {
  const server = new McpServer({ name: "jev-codex-router", version: "0.2.0" });
  const queuedStore = createQueuedStore({ dataDir });

  server.registerTool(
    "status",
    {
      description:
        "Read current Jev router status and global settings. No prompt or API credential is returned.",
      inputSchema: {
        threadId: threadId
          .optional()
          .describe("Optional Codex thread ID for effective per-task settings"),
      },
    },
    safely(async ({ threadId: id }) => {
      const settings = await loadSettings({ dataDir });
      const { threads, ...global } = settings;
      const pendingChecks = id
        ? (await queuedStore.listLaunchStates(id)).map(
            ({ id, state, attemptedAt }) => ({ id, state, attemptedAt }),
          )
        : undefined;
      return {
        routerVersion: "0.2.0",
        routeObservabilityVersion: ROUTE_OBSERVABILITY_VERSION,
        historyVerificationVersion: "current-plan-boundary-v1",
        contextCalibrationVersion: "status-scope-v1",
        policyVersion: "2.0",
        global,
        typesafeConfigured: Boolean(await readKey()),
        configuredThreadCount: Object.keys(threads).length,
        ...(id
          ? {
              thread: await getThreadSettings(id, { dataDir }),
              unconfirmedQueueStarts: pendingChecks,
            }
          : {}),
      };
    }),
  );

  server.registerTool(
    "queue_status",
    {
      description:
        "Inspect a task queue without exposing queued prompt text. An unconfirmed launch blocks automatic retry until execution is verified.",
      inputSchema: { threadId: threadId.describe("Exact Codex task ID") },
    },
    safely(async ({ threadId: id }) => {
      const pending = await queuedStore.list(id, { limit: 100 });
      const unconfirmed = await queuedStore.listLaunchStates(id);
      return {
        pendingCountAtLeast: pending.data.length,
        hasMorePending: Boolean(pending.nextCursor),
        unconfirmedStarts: unconfirmed.map(({ id, state, attemptedAt }) => ({
          id,
          state,
          attemptedAt,
        })),
      };
    }),
  );

  server.registerTool(
    "subtask_history",
    {
      description:
        "Read direct subagent history for one exact native Codex parent task, including completed children. Does not start or resume tasks, call Jev, or save conversation text. Requested models and latest configured models are reported separately; configured values are not per-turn execution telemetry. Incomplete history and child read errors are explicit.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        threadId: threadId.describe("Exact native parent task ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum children to read, default 20"),
        includeResults: z
          .boolean()
          .optional()
          .describe(
            "Include bounded child results in this response only; default false",
          ),
      },
    },
    safely(async (args) => {
      const plan = await readExecutionPlan(args.threadId, { dataDir });
      const registrationScope = executionHistoryScope(plan);
      const history = await inspectHistory({ ...args, ...(registrationScope ? { registrationScope } : {}) });
      return {
        ...history,
        executionPlan: await reconcileExecutionPlan(args.threadId, history, {
          dataDir,
        }),
        routing: await getThreadSettings(args.threadId, { dataDir }),
      };
    }),
  );

  server.registerTool(
    "available_models",
    {
      description:
        "Read the current native Codex account model catalog and supported reasoning efforts. Does not run a task.",
      inputSchema: {},
    },
    safely(async () => ({
      models: (await listModels()).map((entry) => ({
        id: entry.model || entry.id,
        displayName: entry.displayName || entry.model || entry.id,
        description: entry.description || "",
        supportedReasoningEfforts: (entry.supportedReasoningEfforts || []).map(
          (value) =>
            typeof value === "string" ? value : value.reasoningEffort,
        ),
        inputModalities: entry.inputModalities || ["text", "image"],
      })),
    })),
  );

  server.registerTool(
    "settings",
    {
      description:
        "Read or update global Jev routing settings. Updates persist locally. Automatic routing should remain disabled until desktop acceptance is complete.",
      inputSchema: {
        routingPolicy: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Validated model family and task routing preferences"),
        enabled: z
          .boolean()
          .optional()
          .describe(
            "Global automatic routing switch; false during pre-acceptance testing",
          ),
        fallbackModel: model
          .optional()
          .describe(
            "Codex model used when Jev fails or times out; default gpt-6-sol",
          ),
        fallbackEffort: effort
          .optional()
          .describe("Reasoning effort for the fallback model; default medium"),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(10000)
          .optional()
          .describe("Jev deadline in milliseconds; default 2000"),
      },
    },
    safely(async (args) => {
      const patch = {};
      if (args.routingPolicy !== undefined)
        patch.routingPolicy = args.routingPolicy;
      if (args.enabled !== undefined) patch.enabled = args.enabled;
      if (args.timeoutMs !== undefined) patch.timeoutMs = args.timeoutMs;
      if (
        args.fallbackModel !== undefined ||
        args.fallbackEffort !== undefined
      ) {
        const current = await loadSettings({ dataDir });
        patch.fallback = {
          model: args.fallbackModel ?? current.fallback.model,
          effort: args.fallbackEffort ?? current.fallback.effort,
        };
      }
      return Object.keys(patch).length
        ? updateSettings(patch, { dataDir })
        : loadSettings({ dataDir });
    }),
  );

  server.registerTool(
    "thread_settings",
    {
      description:
        "Read or update one Codex task. enabled=false disables automatic routing for this task. mode=manual persists model choice until mode=auto is set.",
      inputSchema: {
        threadId: threadId.describe("Exact Codex thread ID"),
        enabled: z
          .boolean()
          .nullable()
          .optional()
          .describe("Task switch; null inherits global setting"),
        mode: z
          .enum(["auto", "manual"])
          .optional()
          .describe("Persistent task mode"),
        manualModel: model
          .optional()
          .describe("Codex model for manual mode; supply with manualEffort"),
        manualEffort: effort
          .optional()
          .describe("Effort for manual mode; supply with manualModel"),
      },
    },
    safely(async ({ threadId: id, ...patch }) =>
      Object.values(patch).some((value) => value !== undefined)
        ? updateThreadSettings(
            id,
            Object.fromEntries(
              Object.entries(patch).filter(([, value]) => value !== undefined),
            ),
            { dataDir },
          )
        : getThreadSettings(id, { dataDir }),
    ),
  );

  server.registerTool(
    "route_preview",
    {
      description:
        "Ask Jev for a bounded model/effort recommendation without starting a Codex turn or saving the prompt. Reads the current native Codex model catalog when models are omitted. Credential comes from the existing TypeSafe environment variable or macOS Keychain.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(20000)
          .describe(
            "Current user prompt; sent to TypeSafe Jev, never stored in route logs",
          ),
        threadId: threadId
          .optional()
          .describe("Existing Codex thread ID, if available"),
        models: z
          .array(
            z.object({
              id: model,
              model: model.optional(),
              displayName: z.string().optional(),
              description: z.string().optional(),
              supportedReasoningEfforts: z
                .array(z.union([effort, z.object({ reasoningEffort: effort })]))
                .min(1),
              inputModalities: z.array(z.enum(["text", "image"])).optional(),
              hidden: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Optional current-account native Codex model catalog. Omit to discover it automatically.",
          ),
        context: contextSchema
          .optional()
          .describe(
            "Bounded same-task structured context; no project file reading",
          ),
      },
    },
    safely(async ({ prompt, threadId: id, models, context }) => {
      const settings = id
        ? await getThreadSettings(id, { dataDir })
        : await loadSettings({ dataDir }).then((global) => ({
            enabled: global.enabled,
            fallbackModel: global.fallback.model,
            fallbackEffort: global.fallback.effort,
            timeoutMs: global.timeoutMs,
            routingPolicy: global.routingPolicy,
          }));
      const started = Date.now(),
        deadlineAt = started + (settings.timeoutMs || 2000);
      const controller = new AbortController();
      let timer,
        available = models || [];
      const input = {
        prompt,
        context: routeContext(context ?? {}),
        settings,
        models: available,
      };
      try {
        return await Promise.race([
          (async () => {
            const [key, catalog] = await Promise.all([
              Promise.resolve()
                .then(readKey)
                .catch(() => null),
              models
                ? Promise.resolve(models)
                : listModels({
                    signal: controller.signal,
                    timeoutMs: Math.max(1, deadlineAt - Date.now()),
                  }).then((value) => {
                    available = value;
                    return value;
                  }),
            ]);
            if (controller.signal.aborted) return null;
            const route =
              chooseRoute ?? (await import("./route-core.mjs")).chooseRoute;
            return route({
              ...input,
              models: catalog,
              apiKey: key,
              signal: controller.signal,
              settings: {
                ...settings,
                timeoutMs: Math.max(1, deadlineAt - Date.now()),
              },
            });
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => {
                controller.abort();
                reject(
                  Object.assign(new Error("Routing deadline"), {
                    code: "timeout",
                  }),
                );
              },
              Math.max(1, deadlineAt - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        if (available.length && error.code === "timeout") {
          const fallback = await (
            await import("./route-core.mjs")
          ).chooseRoute({
            ...input,
            models: available,
            localOnly: true,
            fallbackReasonCode: "timeout",
          });
          return {
            ...fallback,
            elapsedMs: Date.now() - started,
          };
        }
        return {
          source: "fallback",
          nextAction: "stop",
          reasonCode:
            error.code === "timeout" ? "timeout" : "catalog_unavailable",
          elapsedMs: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  server.registerTool(
    "register_execution_plan",
    {
      description:
        "Register planned native execution units and their dependencies. Stores identifiers and hashes only; does not dispatch tasks. Changed plans require explicit replacement.",
      inputSchema: {
        threadId,
        replace: z.boolean().optional(),
        units: z
          .array(
            z.object({
              unitId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
              task: z.string().min(1).max(8000),
              acceptanceCriteria: z.string().min(1).max(2000),
              dependencies: z.array(z.string().max(128)).max(50).optional(),
            }),
          )
          .min(1)
          .max(50),
      },
    },
    safely((args) => registerExecutionPlan(args, { dataDir })),
  );
  server.registerTool(
    "record_execution_acceptance",
    {
      description:
        "Record main-agent acceptance separately from native completion and model configuration. Run subtask_history to verify native evidence.",
      inputSchema: {
        threadId,
        unitId: z.string().max(128),
        routeId: z.string().uuid(),
        accepted: z.boolean(),
        evidence: z.string().max(2000).optional(),
      },
    },
    safely((args) => recordExecutionAcceptance(args, { dataDir })),
  );

  server.registerTool(
    "route_execution_subtask",
    {
      description:
        "After a complex task has a clear plan, ask Jev which native Codex model and reasoning effort should execute one concrete subtask. Pass the task, acceptance criteria, and only the bounded plan/dependency context needed for that subtask. If retrying after failure, also pass the previous model, effort, and a concise failure summary so Jev can recommend an escalation. Only nextAction=execute permits dispatch; repair_environment, needs_context, replan, or stop must be resolved first. Register a plan and pass unitId for idempotency and verification. Before dispatch, display presentation.text to the user unless the user explicitly requires an exact output format; respect that format instead. Notification scheduling is not proof of user visibility. Use the returned model and effort when calling native spawn_agent, and its routingToken as task_name to correlate the child in subtask_history. Never include credentials or full conversation history; this tool does not store prompt text.",
      inputSchema: {
        unitId: z.string().max(128).optional(),
        attempt: z.number().int().min(1).max(2).optional(),
        retry: z.boolean().optional(),
        failureCategory: z
          .enum([
            "capability",
            "environment",
            "permission",
            "transient",
            "plan",
            "missing_information",
            "unknown",
          ])
          .optional(),
        launchState: z.enum(["not_started", "completed", "unknown"]).optional(),
        possibleExternalEffects: z.boolean().optional(),
        structuredContext: contextSchema.optional(),
        task: z
          .string()
          .min(1)
          .max(8000)
          .describe("One concrete planned execution unit"),
        acceptanceCriteria: z
          .string()
          .max(2000)
          .optional()
          .describe("Observable completion criteria for this unit"),
        planSummary: z
          .string()
          .max(3000)
          .optional()
          .describe("Bounded summary of the approved task plan"),
        dependencies: z
          .string()
          .max(1200)
          .optional()
          .describe("Dependencies or constraints that affect this unit"),
        previousModel: model
          .optional()
          .describe(
            "Previous child model when retrying after an incomplete attempt",
          ),
        previousEffort: effort
          .optional()
          .describe(
            "Previous child reasoning effort when retrying after an incomplete attempt",
          ),
        failureSummary: z
          .string()
          .max(1000)
          .optional()
          .describe(
            "Concise error or blocker from the previous attempt; used to escalate safely",
          ),
        threadId: threadId.describe(
          "Parent Codex task ID for effective manual/fallback settings and local route metadata",
        ),
        models: z
          .array(
            z.object({
              id: model,
              model: model.optional(),
              displayName: z.string().optional(),
              description: z.string().optional(),
              supportedReasoningEfforts: z
                .array(z.union([effort, z.object({ reasoningEffort: effort })]))
                .min(1),
              inputModalities: z.array(z.enum(["text", "image"])).optional(),
              hidden: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Optional current-account native Codex catalog. Omit to discover it automatically.",
          ),
      },
    },
    safely(async (args) => {
      const {
        task,
        acceptanceCriteria = "",
        planSummary = "",
        dependencies = "",
        previousModel,
        previousEffort,
        failureSummary = "",
        threadId: id,
        models,
      } = args;
      const settings = await getThreadSettings(id, { dataDir });
      const started = Date.now();
      const budget = settings.timeoutMs || 2000;
      const deadlineAt = started + budget;
      const controller = new AbortController();
      const deadline = async (operation) => {
        let timer;
        try {
          return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => {
                  controller.abort();
                  reject(
                    Object.assign(new Error("Routing deadline"), {
                      code: "ROUTING_TIMEOUT",
                    }),
                  );
                },
                Math.max(1, deadlineAt - Date.now()),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const decide = async (retryEvidence = {}) => {
        let key = null,
          available = models || [];
        const routeTask =
          chooseSubtaskRoute ??
          (await import("./route-core.mjs")).chooseSubtaskRoute;
        try {
          [key, available] = await deadline(() =>
            Promise.all([
              Promise.resolve()
                .then(readKey)
                .catch(() => null),
              models
                ? Promise.resolve(models)
                : listModels({
                    signal: controller.signal,
                    timeoutMs: Math.max(1, deadlineAt - Date.now()),
                  }).then((value) => {
                    available = value;
                    return value;
                  }),
            ]),
          );
          return await deadline(() =>
            routeTask({
              ...args,
              task,
              acceptanceCriteria,
              dependencies,
              previousModel,
              previousEffort,
              ...retryEvidence,
              failureSummary,
              threadId: id,
              context: routeContext({
                summary: planSummary,
                ...args.structuredContext,
              }),
              signal: controller.signal,
              models: available,
              settings: {
                ...settings,
                timeoutMs: Math.max(1, deadlineAt - Date.now()),
              },
              apiKey: key,
            }),
          );
        } catch (error) {
          if (available.length && error.code === "ROUTING_TIMEOUT") {
            const fallback = await (
              await import("./route-core.mjs")
            ).chooseSubtaskRoute({
              ...args,
              ...retryEvidence,
              context: routeContext({
                summary: planSummary,
                ...args.structuredContext,
              }),
              models: available,
              settings,
              localOnly: true,
              fallbackReasonCode: "timeout",
            });
            return {
              ...fallback,
              elapsedMs: Date.now() - started,
            };
          }
          return {
            source: "fallback",
            nextAction: "stop",
            reasonCode:
              error.code === "ROUTING_TIMEOUT"
                ? "timeout"
                : "catalog_unavailable",
            phase: "planning",
            elapsedMs: Date.now() - started,
          };
        }
      };
      let decision;
      if (args.unitId) {
        try {
          decision = await deadline(() =>
            routePlannedUnit(
              {
                ...args,
                acceptanceCriteria,
                planSummary,
                dependencies,
                routingConfiguration: { settings, models },
              },
              decide,
              { dataDir, signal: controller.signal },
            ),
          );
        } catch (error) {
          if (error.code !== "ROUTING_TIMEOUT") throw error;
          decision = {
            unitId: args.unitId,
            nextAction: "stop",
            source: "fallback",
            reasonCode: "timeout",
            elapsedMs: Date.now() - started,
          };
        }
      } else {
        decision = await decide();
        if (!decision.nextAction || decision.nextAction === "execute") {
          const routeId = randomUUID();
          decision = {
            ...decision,
            nextAction: "execute",
            routeId,
            routingToken: `jev_${routeId.replaceAll("-", "")}`,
            handoffCoverage: "incomplete",
          };
        }
      }
      const presentationOptions = {
        scope: args.structuredContext?.stage === "review" || args.structuredContext?.phase === "review" ? "review" : "subtask",
        previousModel,
        previousEffort,
      };
      // Missing configuration never authorizes a dispatch, even from an injected provider.
      decision.presentation = buildRoutePresentation(decision, presentationOptions);
      if (decision.presentation.nextAction === "stop" && decision.nextAction === "execute") {
        decision.nextAction = "stop";
      }
      if (decision.routeId && !decision.reused) {
        try {
          await recordRoute(
            {
              id: decision.routeId,
              threadId: id,
              model: decision.model,
              effort: decision.effort,
              source: decision.source,
              reasonCode:
                decision.reasonCode ||
                (decision.source === "fallback" || decision.source === "manual"
                  ? decision.source
                  : "execution_subtask"),
              phase: decision.phase || "execution",
              taskKind: decision.taskKind,
              policyVersion: decision.policyVersion,
              nextAction: decision.nextAction,
              contextComplete: decision.contextComplete,
              capabilityLimited: decision.capabilityLimited,
              elapsedMs: decision.elapsedMs,
              fallback: decision.source === "fallback",
              escalated: decision.escalated,
              routeScope: decision.presentation.scope,
              selectionEvent: decision.presentation.event,
              sameConfiguration: decision.presentation.sameConfiguration,
            },
            { dataDir },
          );
          decision.auditRecorded = true;
        } catch (error) {
          decision.auditRecorded = false;
          decision.auditError = "route_log_unavailable";
          console.error(
            "Jev subtask route log failed:",
            error?.name ?? "Error",
          );
        }
      }
      if (!decision.reused && decision.presentation.model && decision.presentation.effort) {
        // Delivery runs outside the routing deadline and cannot mutate or retry the decision.
        void scheduleRouteNotice(decision, { announce, ...presentationOptions });
        decision.notification = { delivery: "scheduled", userSeen: null };
      }
      return decision;
    }),
  );

  server.registerTool(
    "feedback",
    {
      description:
        "Mark a previous route as too weak or overkill. Saves only feedback on existing local metadata; never stores prompt text.",
      inputSchema: {
        recordId: z.string().uuid().describe("ID returned by recent_routes"),
        feedback: z
          .enum(["too_weak", "overkill"])
          .describe("Correction for the selected model and effort"),
      },
    },
    safely(async ({ recordId, feedback }) =>
      addRouteFeedback(recordId, feedback, { dataDir }),
    ),
  );

  server.registerTool(
    "recent_routes",
    {
      description:
        "List recent local routing metadata. Records are retained for 30 days by default and contain no prompts, conversation text or API credentials.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum records, default 20"),
        threadId: threadId
          .optional()
          .describe("Only records for this Codex task"),
      },
    },
    safely(async (args) => ({
      routes: (await listRecentRoutes({ ...args, dataDir })).map(describeRoute),
    })),
  );

  server.registerTool(
    "last_decision",
    {
      description:
        "Read the latest route with its short explanation. Provide threadId for an exact task; without it this returns the latest record across all tasks.",
      inputSchema: {
        threadId: threadId.optional().describe("Optional exact Codex task ID"),
      },
    },
    safely(async (args) => ({
      route: describeRoute(
        (await listRecentRoutes({ ...args, limit: 1, dataDir }))[0],
      ),
    })),
  );

  return server;
}

export async function runStdioServer(options = {}) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
