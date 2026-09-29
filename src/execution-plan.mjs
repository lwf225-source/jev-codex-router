import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getDataDir, validateThreadId, withDataLock } from "./settings.mjs";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const path = (dir) => join(getDataDir(dir), "execution-plans.json");
const retained = (records) =>
  records.filter((p) => Date.now() - Date.parse(p.updatedAt) < 30 * 86400000);
async function read(dir) {
  try {
    return retained(JSON.parse(await readFile(path(dir), "utf8")));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
async function save(dir, plans) {
  const tmp = `${path(dir)}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(plans), { mode: 0o600 });
  await rename(tmp, path(dir));
}
export async function readExecutionPlan(threadId, { dataDir } = {}) {
  return withDataLock(dataDir, async (dir) => {
    const plans = await read(dir);
    await save(dir, plans);
    return plans.find((p) => p.threadId === threadId) || null;
  });
}
/** Metadata-only lower boundary; native history must prove this registration. */
export function executionHistoryScope(plan) {
  if (!plan) return null;
  const origin = Object.hasOwn(plan, "historyOrigin")
    ? plan.historyOrigin
    : { planId: plan.planId, createdAt: plan.createdAt };
  const createdAtMs = Date.parse(origin?.createdAt);
  const attempts = plan.units.flatMap((unit) => unit.attempts || []);
  const valid = origin?.planId && Number.isFinite(createdAtMs) &&
    createdAtMs <= Date.parse(plan.createdAt) && attempts.every((attempt) =>
      Number.isFinite(Date.parse(attempt.createdAt)) && Date.parse(attempt.createdAt) >= createdAtMs);
  return {
    planId: plan.planId,
    ...(valid ? { originPlanId: origin.planId, createdAt: origin.createdAt } : {}),
  };
}

export async function registerExecutionPlan(
  { threadId, units, replace = false },
  { dataDir } = {},
) {
  validateThreadId(threadId);
  if (!Array.isArray(units) || !units.length || units.length > 50)
    throw new TypeError("Plan requires 1..50 units");
  const ids = new Set(units.map((u) => u.unitId));
  if (
    ids.size !== units.length ||
    units.some(
      (u) =>
        !identifier(u.unitId) ||
        typeof u.task !== "string" ||
        !u.task ||
        typeof u.acceptanceCriteria !== "string" ||
        !u.acceptanceCriteria,
    )
  )
    throw new TypeError(
      "Unique unit IDs, task and acceptance criteria are required",
    );
  const visiting = new Set(),
    visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new TypeError("Dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of units.find((u) => u.unitId === id).dependencies || []) {
      if (!ids.has(dep)) throw new TypeError("Unknown dependency");
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  }
  units.forEach((u) => visit(u.unitId));
  const normalized = units.map((u) => ({
    unitId: u.unitId,
    taskHash: hash(u.task),
    acceptanceHash: hash(u.acceptanceCriteria),
    dependencies: [...new Set(u.dependencies || [])],
    attempts: [],
  }));
  const planHash = hash(normalized);
  return withDataLock(dataDir, async (dir) => {
    const plans = await read(dir);
    const previous = plans.find((p) => p.threadId === threadId);
    if (previous?.planHash === planHash) return previous;
    if (previous && !replace)
      throw new TypeError("Plan changed; explicitly replace and replan");
    if (previous) {
      if (
        previous.units.some((unit) => {
          if (unit.pending && Date.parse(unit.pending.expiresAt) > Date.now())
            return true;
          const last = unit.attempts.at(-1);
          return (
            last &&
            !["completed", "failed", "interrupted", "not_dispatched"].includes(
              last.nativeStatus,
            )
          );
        })
      )
        throw new TypeError(
          "Reconcile unfinished or unknown execution starts before replacing the plan",
        );
      for (const unit of normalized) {
        const old = previous.units.find(
          (value) => value.unitId === unit.unitId,
        );
        if (old?.attempts.length) {
          if (
            old.taskHash !== unit.taskHash ||
            old.acceptanceHash !== unit.acceptanceHash
          )
            throw new TypeError(
              "An executed unit cannot change task or criteria; use a new unit ID for a new task",
            );
          unit.attempts = old.attempts;
        }
      }
    }
    const now = new Date().toISOString();
    const plan = {
      threadId,
      planId: randomUUID(),
      planHash,
      createdAt: now,
      updatedAt: now,
      units: normalized,
      ...(normalized.some((unit) => unit.attempts.length) ? {
        historyOrigin: (() => {
          const scope = executionHistoryScope(previous);
          return scope?.originPlanId ? { planId: scope.originPlanId, createdAt: scope.createdAt } : null;
        })(),
      } : {}),
    };
    await save(dir, [...plans.filter((p) => p.threadId !== threadId), plan]);
    return plan;
  });
}
const DECISION_ENUMS = {
  source: ["jev", "fallback", "manual", "explicit", "policy", "disabled"],
  phase: ["execution", "planning", "plan_execute", "direct"],
  reasonCode: [
    "explicit",
    "manual",
    "aborted",
    "catalog_unavailable",
    "timeout",
    "missing_key",
    "service_error",
    "context_incomplete",
    "judgment",
    "capability_limited",
    "independent_review_unavailable",
    "review_planner_missing",
    "attempt_limit",
    "completion_unknown",
    "failure_environment",
    "failure_permission",
    "failure_plan",
    "failure_missing_information",
    "failure_unknown",
    "transient_retry",
    "capability_upgrade",
    "capability_ceiling",
  ],
  taskKind: [
    "routine",
    "code",
    "diagnostic",
    "writing",
    "research",
    "architecture",
    "review",
    "unknown",
  ],
  nextAction: [
    "execute",
    "repair_environment",
    "needs_context",
    "replan",
    "stop",
  ],
};
function decisionMetadata(d) {
  const metadata = {};
  for (const [key, values] of Object.entries(DECISION_ENUMS))
    if (values.includes(d[key])) metadata[key] = d[key];
  if (/^gpt-[a-z0-9][a-z0-9.-]{1,80}$/i.test(d.model)) metadata.model = d.model;
  if (
    [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ].includes(d.effort)
  )
    metadata.effort = d.effort;
  if (
    typeof d.policyVersion === "string" &&
    /^[0-9.]{1,20}$/.test(d.policyVersion)
  )
    metadata.policyVersion = d.policyVersion;
  if (Number.isFinite(d.elapsedMs)) metadata.elapsedMs = d.elapsedMs;
  if (typeof d.escalated === "boolean") metadata.escalated = d.escalated;
  return metadata;
}
const inFlightRoutes = new Map();
const RESERVATION_TTL_MS = 15000;
const abortedDecision = (unitId) => ({
  unitId,
  nextAction: "stop",
  reasonCode: "timeout",
});
async function awaitRoute(operation, signal, unitId) {
  if (!signal) return operation;
  if (signal.aborted) return abortedDecision(unitId);
  let listener;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve) => {
        listener = () => resolve(abortedDecision(unitId));
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
export async function routePlannedUnit(args, decide, { dataDir, signal } = {}) {
  if (signal?.aborted) return abortedDecision(args.unitId);
  const key = hash({ dataDir: getDataDir(dataDir), args });
  if (inFlightRoutes.has(key)) {
    const decision = await awaitRoute(
      inFlightRoutes.get(key),
      signal,
      args.unitId,
    );
    return {
      ...decision,
      reused: true,
      dispatchNeedsCheck: true,
      nextAction:
        decision.nextAction === "execute"
          ? "needs_context"
          : decision.nextAction,
    };
  }
  const operation = routeReservedUnit(args, decide, dataDir, signal);
  inFlightRoutes.set(key, operation);
  try {
    return await awaitRoute(operation, signal, args.unitId);
  } finally {
    // An aborted caller must not expose an unfinished operation as a fresh request.
    void operation.then(
      () => {
        if (inFlightRoutes.get(key) === operation) inFlightRoutes.delete(key);
      },
      () => {
        if (inFlightRoutes.get(key) === operation) inFlightRoutes.delete(key);
      },
    );
  }
}
async function routeReservedUnit(args, decide, dataDir, signal) {
  const claim = await withDataLock(dataDir, async (dir) => {
    if (signal?.aborted) return abortedDecision(args.unitId);
    const plans = await read(dir),
      plan = plans.find((p) => p.threadId === args.threadId),
      unit = plan?.units.find((u) => u.unitId === args.unitId);
    const blocked = (reasonCode) => ({
      nextAction: "replan",
      reasonCode,
      unitId: args.unitId,
    });
    if (!unit) return blocked("plan_missing");
    if (
      unit.taskHash !== hash(args.task) ||
      unit.acceptanceHash !== hash(args.acceptanceCriteria || "")
    )
      return blocked("unit_changed");
    const requestHash = hash({
      task: args.task,
      acceptanceCriteria: args.acceptanceCriteria,
      planSummary: args.planSummary,
      dependencies: args.dependencies,
      structuredContext: args.structuredContext,
      routingConfiguration: args.routingConfiguration,
    });
    if (unit.pending && Date.parse(unit.pending.expiresAt) > Date.now())
      return {
        nextAction: "needs_context",
        reasonCode: "routing_in_progress",
        unitId: args.unitId,
      };
    delete unit.pending;
    const last = unit.attempts.at(-1);
    if (last && !args.retry)
      return last.requestHash === requestHash
        ? {
            ...last.decision,
            routeId: last.routeId,
            routingToken: last.routingToken,
            unitId: unit.unitId,
            attempt: last.attempt,
            reused: true,
            nextAction:
              last.nativeStatus === "not_dispatched"
                ? "execute"
                : last.nativeStatus === "completed"
                  ? "stop"
                  : "needs_context",
            dispatchNeedsCheck: last.nativeStatus !== "not_dispatched",
            reasonCode:
              last.nativeStatus === "not_dispatched"
                ? last.decision.reasonCode
                : "completion_check_required",
          }
        : blocked("unit_changed");
    if (args.retry && !last) return blocked("previous_attempt_missing");
    if (
      last &&
      (last.attempt >= 2 || (args.attempt && args.attempt !== last.attempt + 1))
    )
      return {
        nextAction: "stop",
        reasonCode: "attempt_limit",
        unitId: unit.unitId,
      };
    if (!last && args.attempt && args.attempt !== 1)
      return blocked("attempt_mismatch");
    if (
      last &&
      (args.launchState === "unknown" ||
        args.possibleExternalEffects ||
        !(
          ["failed", "interrupted"].includes(last.nativeStatus) ||
          (last.nativeStatus === "completed" &&
            last.acceptance?.accepted === false)
        ))
    )
      return {
        nextAction: "stop",
        reasonCode: "completion_check_required",
        unitId: unit.unitId,
      };
    if (
      unit.dependencies.some((id) => {
        const dependency = plan.units
          .find((u) => u.unitId === id)
          ?.attempts.at(-1);
        return (
          !dependency?.acceptance?.accepted ||
          dependency.nativeStatus !== "completed" ||
          dependency.configurationMatch !== true
        );
      })
    )
      return blocked("dependency_incomplete");
    const reservation = {
      id: randomUUID(),
      requestHash,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
    };
    if (signal?.aborted) return abortedDecision(args.unitId);
    unit.pending = reservation;
    plan.updatedAt = reservation.createdAt;
    await save(dir, plans);
    return {
      reserved: true,
      reservation,
      planId: plan.planId,
      previousRouteId: last?.routeId,
      evidence: last
        ? {
            attempt: last.attempt + 1,
            previousModel: last.decision.model,
            previousEffort: last.decision.effort,
          }
        : { attempt: 1 },
    };
  });
  if (!claim.reserved) return claim;
  let decision;
  try {
    decision = signal?.aborted
      ? abortedDecision(args.unitId)
      : await decide(claim.evidence);
  } catch (error) {
    await withDataLock(dataDir, async (dir) => {
      const plans = await read(dir),
        plan = plans.find((p) => p.threadId === args.threadId),
        unit = plan?.units.find((u) => u.unitId === args.unitId);
      if (
        plan?.planId === claim.planId &&
        unit?.pending?.id === claim.reservation.id
      ) {
        delete unit.pending;
        await save(dir, plans);
      }
    });
    throw error;
  }
  return withDataLock(dataDir, async (dir) => {
    const plans = await read(dir),
      plan = plans.find((p) => p.threadId === args.threadId),
      unit = plan?.units.find((u) => u.unitId === args.unitId),
      last = unit?.attempts.at(-1);
    if (
      signal?.aborted ||
      plan?.planId !== claim.planId ||
      unit?.pending?.id !== claim.reservation.id ||
      last?.routeId !== claim.previousRouteId ||
      Date.parse(claim.reservation.expiresAt) <= Date.now()
    ) {
      if (unit?.pending?.id === claim.reservation.id) {
        delete unit.pending;
        await save(dir, plans);
      }
      return {
        nextAction: signal?.aborted ? "stop" : "needs_context",
        reasonCode: signal?.aborted ? "timeout" : "routing_reservation_expired",
        unitId: args.unitId,
      };
    }
    if (
      unit.dependencies.some((id) => {
        const d = plan.units.find((u) => u.unitId === id)?.attempts.at(-1);
        return (
          !d?.acceptance?.accepted ||
          d.nativeStatus !== "completed" ||
          d.configurationMatch !== true
        );
      })
    ) {
      delete unit.pending;
      await save(dir, plans);
      return {
        nextAction: "replan",
        reasonCode: "dependency_incomplete",
        unitId: args.unitId,
      };
    }
    const requestHash = claim.reservation.requestHash;
    delete unit.pending;
    if (decision.nextAction && decision.nextAction !== "execute") {
      unit.lastDecision = decisionMetadata(decision);
      plan.updatedAt = new Date().toISOString();
      await save(dir, plans);
      return { ...decision, unitId: unit.unitId };
    }
    const routeId = randomUUID(),
      routingToken = `jev_${routeId.replaceAll("-", "")}`,
      attempt = (last?.attempt || 0) + 1;
    unit.attempts.push({
      routeId,
      routingToken,
      attempt,
      requestHash,
      decision: decisionMetadata({ ...decision, nextAction: "execute" }),
      createdAt: new Date().toISOString(),
      nativeStatus: "unknown",
    });
    plan.updatedAt = new Date().toISOString();
    await save(dir, plans);
    return {
      ...decision,
      nextAction: "execute",
      routeId,
      routingToken,
      unitId: unit.unitId,
      attempt,
    };
  });
}
export async function recordExecutionAcceptance(
  { threadId, unitId, routeId, accepted, evidence = "" },
  { dataDir } = {},
) {
  return withDataLock(dataDir, async (dir) => {
    const plans = await read(dir),
      plan = plans.find((p) => p.threadId === threadId),
      unit = plan?.units.find((u) => u.unitId === unitId),
      attempt = unit?.attempts.at(-1);
    if (!attempt || attempt.routeId !== routeId)
      throw new TypeError(
        "Acceptance must reference the latest execution attempt",
      );
    if (
      accepted &&
      (attempt.nativeStatus !== "completed" ||
        attempt.configurationMatch !== true)
    )
      throw new TypeError(
        "Read complete native history with a matching completed child before acceptance",
      );
    if (accepted && (typeof evidence !== "string" || !evidence.trim()))
      throw new TypeError(
        "Accepted work requires an explicit delivery verification summary",
      );
    attempt.acceptance = {
      accepted: Boolean(accepted),
      evidenceHash: hash(evidence),
      declaredAt: new Date().toISOString(),
      source: "main_agent",
    };
    plan.updatedAt = new Date().toISOString();
    await save(dir, plans);
    return {
      unitId,
      routeId,
      acceptance: attempt.acceptance,
      nativeStatus: attempt.nativeStatus,
      configurationMatch: attempt.configurationMatch ?? null,
    };
  });
}
export async function reconcileExecutionPlan(
  threadId,
  history,
  { dataDir } = {},
) {
  return withDataLock(dataDir, async (dir) => {
    const plans = await read(dir),
      plan = plans.find((p) => p.threadId === threadId);
    if (!plan)
      return {
        coverage: "incomplete",
        reasonCode: "plan_missing",
        allVerified: false,
        units: [],
      };
    const scope = executionHistoryScope(plan);
    const current = history.coverage?.currentPlan;
    const boundary = current?.boundary;
    const createdAtMs = Date.parse(scope?.createdAt);
    const scopedComplete = current?.coverage === "complete" &&
      current.planId === plan.planId && scope?.originPlanId &&
      boundary?.originPlanId === scope.originPlanId && boundary.createdAt === scope.createdAt &&
      Number.isFinite(boundary.startedAtMs) && Number.isFinite(boundary.completedAtMs) &&
      boundary.startedAtMs <= createdAtMs && createdAtMs <= boundary.completedAtMs;
    const globalComplete = !history.truncated && history.coverage?.parentHistory === "complete";
    const complete = Boolean(
      !history.readError && (globalComplete || scopedComplete) &&
      !history.coverage?.omittedByLimit &&
      !history.coverage?.excludedReferences?.length &&
      !history.coverage?.conflictedRoutingTokens?.length &&
      !history.coverage?.unlinkedRoutingTokens?.length &&
      !(history.tasks || []).some((child) => child.readError ||
        child.resultHistoryTruncated || (child.resultCoverage && child.resultCoverage !== "complete"))
    );
    const units = plan.units.map((unit) => {
      const attempt = unit.attempts.at(-1);
      if (!attempt)
        return {
          unitId: unit.unitId,
          status: "not_routed",
          ...(unit.lastDecision ? { lastDecision: unit.lastDecision } : {}),
        };
      const children = (history.tasks || []).filter(
        (t) => t.routingToken === attempt.routingToken,
      );
      const child = children.length === 1 ? children[0] : null;
      const match =
        child &&
        !child.readError &&
        child.configuredModel === attempt.decision.model &&
        child.configuredEffort === attempt.decision.effort &&
        (!child.suggestedModel || child.suggestedModel === attempt.decision.model) &&
        (!child.suggestedEffort || child.suggestedEffort === attempt.decision.effort);
      attempt.nativeStatus =
        complete && children.length === 0
          ? "not_dispatched"
          : complete && child && !child.readError
            ? child.status
            : "unknown";
      attempt.configurationMatch =
        complete && child && !child.readError ? Boolean(match) : null;
      let status =
        !complete || children.length > 1 || child?.readError
          ? "unknown"
          : !child
            ? "not_dispatched"
            : !match
              ? "configuration_mismatch"
              : child.status === "completed"
                ? attempt.acceptance?.accepted
                  ? "verified"
                  : "completed_pending_acceptance"
                : child.status;
      return {
        unitId: unit.unitId,
        attempt: attempt.attempt,
        routeId: attempt.routeId,
        routingToken: attempt.routingToken,
        status,
        nativeStatus: attempt.nativeStatus,
        configurationMatch: attempt.configurationMatch,
        acceptance: attempt.acceptance || null,
      };
    });
    await save(dir, plans);
    return {
      planId: plan.planId,
      coverage: complete ? "complete" : "incomplete",
      coverageScope: globalComplete ? "globalHistory" : scopedComplete ? "currentPlan" : "unknown",
      allVerified: complete && units.every((u) => u.status === "verified"),
      units,
    };
  });
}

/** Apply the same retention window even when no task history is queried. */
export async function pruneExecutionPlans({ dataDir } = {}) {
  return withDataLock(dataDir, async (dir) => {
    const plans = await read(dir);
    await save(dir, plans);
    return { retainedPlans: plans.length };
  });
}
