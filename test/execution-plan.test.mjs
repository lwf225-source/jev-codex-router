import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerExecutionPlan,
  routePlannedUnit,
  reconcileExecutionPlan,
  recordExecutionAcceptance,
} from "../src/execution-plan.mjs";
const temporary = (fn) => async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "jev-plan-"));
  try {
    await fn({ dataDir });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
};
const unit = {
  unitId: "first",
  task: "Private implementation task",
  acceptanceCriteria: "Private acceptance requirement",
};
const args = { threadId: "parent", ...unit };
const decide = async () => ({
  model: "gpt-6-sol",
  effort: "medium",
  source: "jev",
  nextAction: "execute",
});
const report = (decision, status = "completed") => ({
  coverage: { parentHistory: "complete" },
  tasks: [
    {
      routingToken: decision.routingToken,
      configuredModel: "gpt-6-sol",
      configuredEffort: "medium",
      status,
    },
  ],
});
test(
  "plan stores hashes only, rejects cycles and changed requests, serializes concurrent routes",
  temporary(async (options) => {
    await assert.rejects(
      registerExecutionPlan(
        { threadId: "parent", units: [{ ...unit, dependencies: ["first"] }] },
        options,
      ),
      /cycle/,
    );
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    let calls = 0;
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        routePlannedUnit(
          args,
          async () => {
            calls++;
            return decide();
          },
          options,
        ),
      ),
    );
    assert.equal(calls, 1);
    assert.equal(a.routeId, b.routeId);
    assert.equal(
      (await routePlannedUnit({ ...args, task: "Changed" }, decide, options))
        .nextAction,
      "replan",
    );
    const raw = await readFile(
      join(options.dataDir, "execution-plans.json"),
      "utf8",
    );
    assert.ok(!raw.includes("Private"));
    assert.equal(
      (await stat(join(options.dataDir, "execution-plans.json"))).mode & 0o777,
      0o600,
    );
  }),
);
test(
  "native completion and acceptance are independent and incomplete history never verifies",
  temporary(async (options) => {
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    const d = await routePlannedUnit(args, decide, options);
    let r = await reconcileExecutionPlan("parent", report(d), options);
    assert.equal(r.units[0].status, "completed_pending_acceptance");
    assert.equal(r.allVerified, false);
    await recordExecutionAcceptance(
      {
        ...args,
        routeId: d.routeId,
        accepted: true,
        evidence: "Private evidence",
      },
      options,
    );
    r = await reconcileExecutionPlan("parent", report(d), options);
    assert.equal(r.allVerified, true);
    for (const h of [
      { ...report(d), truncated: true },
      { ...report(d), tasks: [...report(d).tasks, ...report(d).tasks] },
      { ...report(d), readError: "oops" },
    ])
      assert.equal(
        (await reconcileExecutionPlan("parent", h, options)).allVerified,
        false,
      );
    assert.equal(
      (await reconcileExecutionPlan("missing", report(d), options)).coverage,
      "incomplete",
    );
  }),
);
test(
  "dependencies and failed-attempt evidence gate retry, two attempt limit",
  temporary(async (options) => {
    await registerExecutionPlan(
      {
        threadId: "parent",
        units: [unit, { ...unit, unitId: "second", dependencies: ["first"] }],
      },
      options,
    );
    assert.equal(
      (await routePlannedUnit({ ...args, unitId: "second" }, decide, options))
        .reasonCode,
      "dependency_incomplete",
    );
    const d = await routePlannedUnit(args, decide, options);
    assert.equal(
      (await routePlannedUnit({ ...args, retry: true }, decide, options))
        .reasonCode,
      "completion_check_required",
    );
    await reconcileExecutionPlan("parent", report(d, "failed"), options);
    const d2 = await routePlannedUnit(
      { ...args, retry: true, attempt: 2 },
      decide,
      options,
    );
    assert.equal(d2.attempt, 2);
    assert.equal(
      (await routePlannedUnit({ ...args, retry: true }, decide, options))
        .reasonCode,
      "attempt_limit",
    );
  }),
);
test(
  "nonexecution decisions do not assign attempt tokens",
  temporary(async (options) => {
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    const d = await routePlannedUnit(
      args,
      async () => ({ nextAction: "repair_environment" }),
      options,
    );
    assert.equal(d.routeId, undefined);
    assert.equal((await routePlannedUnit(args, decide, options)).attempt, 1);
  }),
);

test(
  "completed rejected work can retry with authoritative prior configuration",
  temporary(async (options) => {
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    const d = await routePlannedUnit(args, decide, options);
    await reconcileExecutionPlan("parent", report(d), options);
    await recordExecutionAcceptance(
      { ...args, routeId: d.routeId, accepted: false },
      options,
    );
    let retry;
    const d2 = await routePlannedUnit(
      { ...args, retry: true, failureCategory: "capability" },
      async (evidence) => {
        retry = evidence;
        return decide();
      },
      options,
    );
    assert.equal(d2.attempt, 2);
    assert.deepEqual(retry, {
      attempt: 2,
      previousModel: "gpt-6-sol",
      previousEffort: "medium",
    });
  }),
);

test(
  "configuration drift revokes dependency readiness and plan replacement preserves attempt history",
  temporary(async (options) => {
    const second = { ...unit, unitId: "second", dependencies: ["first"] };
    await registerExecutionPlan(
      { threadId: "parent", units: [unit, second] },
      options,
    );
    const d = await routePlannedUnit(args, decide, options);
    await assert.rejects(
      registerExecutionPlan(
        {
          threadId: "parent",
          units: [unit, second, { ...unit, unitId: "third" }],
          replace: true,
        },
        options,
      ),
      /Reconcile/,
    );
    await reconcileExecutionPlan("parent", report(d), options);
    await recordExecutionAcceptance(
      {
        ...args,
        routeId: d.routeId,
        accepted: true,
        evidence: "Checked exact deliverable",
      },
      options,
    );
    const drift = report(d);
    drift.tasks[0].configuredModel = "gpt-6-luna";
    await reconcileExecutionPlan("parent", drift, options);
    assert.equal(
      (await routePlannedUnit({ ...args, unitId: "second" }, decide, options))
        .reasonCode,
      "dependency_incomplete",
    );
    const plan = await registerExecutionPlan(
      {
        threadId: "parent",
        units: [unit, second, { ...unit, unitId: "third" }],
        replace: true,
      },
      options,
    );
    assert.equal(plan.units[0].attempts[0].routeId, d.routeId);
  }),
);

test(
  "idempotent replays require dispatch evidence and never rerun completed work",
  temporary(async (options) => {
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    const d = await routePlannedUnit(args, decide, options);
    const pending = await routePlannedUnit(args, decide, options);
    assert.equal(pending.routeId, d.routeId);
    assert.equal(pending.nextAction, "needs_context");
    await reconcileExecutionPlan(
      "parent",
      { coverage: { parentHistory: "complete" }, tasks: [] },
      options,
    );
    assert.equal(
      (await routePlannedUnit(args, decide, options)).nextAction,
      "execute",
    );
    await reconcileExecutionPlan("parent", report(d), options);
    assert.equal(
      (await routePlannedUnit(args, decide, options)).nextAction,
      "stop",
    );
  }),
);

test(
  "acceptance cannot pre-authorize unfinished work or omit verification evidence",
  temporary(async (options) => {
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    const d = await routePlannedUnit(args, decide, options);
    await assert.rejects(
      recordExecutionAcceptance(
        { ...args, routeId: d.routeId, accepted: true, evidence: "done" },
        options,
      ),
      /native history/,
    );
    await reconcileExecutionPlan("parent", report(d), options);
    await assert.rejects(
      recordExecutionAcceptance(
        { ...args, routeId: d.routeId, accepted: true },
        options,
      ),
      /verification summary/,
    );
  }),
);

test(
  "slow routing releases global lock and joined duplicate cannot dispatch twice",
  temporary(async (options) => {
    const { updateSettings } = await import("../src/settings.mjs");
    const { appendRouteRecord } = await import("../src/audit-log.mjs");
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    let release,
      started,
      calls = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const begin = new Promise((resolve) => {
      started = resolve;
    });
    const slow = async () => {
      calls++;
      started();
      await gate;
      return decide();
    };
    const first = routePlannedUnit(args, slow, options);
    await begin;
    const second = routePlannedUnit(args, slow, options);
    const saved = await Promise.race([
      Promise.all([
        updateSettings({ timeoutMs: 300 }, options),
        appendRouteRecord(
          {
            threadId: "other",
            model: "gpt-6-sol",
            effort: "medium",
            source: "jev",
          },
          options,
        ),
      ]),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Global lock blocked")),
          500,
        );
        timer.unref();
      }),
    ]);
    assert.equal(saved.length, 2);
    const foreign = await import(
      "../src/execution-plan.mjs?reservation-other-process"
    );
    const blocked = await foreign.routePlannedUnit(args, decide, options);
    assert.equal(blocked.reasonCode, "routing_in_progress");
    await assert.rejects(
      registerExecutionPlan(
        {
          threadId: "parent",
          units: [unit, { ...unit, unitId: "second" }],
          replace: true,
        },
        options,
      ),
      /Reconcile/,
    );
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(a.routeId, b.routeId);
    assert.equal(b.nextAction, "needs_context");
    assert.equal(b.reused, true);
  }),
);

test(
  "failed routing cleans its reservation and permits a new bounded attempt",
  temporary(async (options) => {
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    await assert.rejects(
      routePlannedUnit(
        args,
        async () => {
          throw new Error("synthetic");
        },
        options,
      ),
      /synthetic/,
    );
    assert.equal((await routePlannedUnit(args, decide, options)).attempt, 1);
  }),
);

test(
  "expired reservation cannot overwrite a newer completed routing decision",
  temporary(async (options) => {
    const { writeFile } = await import("node:fs/promises");
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    let release, started;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const begin = new Promise((resolve) => {
      started = resolve;
    });
    const old = routePlannedUnit(
      args,
      async () => {
        started();
        await gate;
        return { model: "gpt-6-luna", effort: "low", nextAction: "execute" };
      },
      options,
    );
    await begin;
    const file = join(options.dataDir, "execution-plans.json");
    const plans = JSON.parse(await readFile(file, "utf8"));
    plans[0].units[0].pending.expiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();
    await writeFile(file, JSON.stringify(plans));
    const foreign = await import(
      "../src/execution-plan.mjs?reservation-new-owner"
    );
    const newer = await foreign.routePlannedUnit(args, decide, options);
    release();
    assert.equal((await old).reasonCode, "routing_reservation_expired");
    const saved = JSON.parse(await readFile(file, "utf8"))[0].units[0];
    assert.equal(saved.attempts.length, 1);
    assert.equal(saved.attempts[0].routeId, newer.routeId);
    assert.equal(saved.attempts[0].decision.model, "gpt-6-sol");
  }),
);

test(
  "joined caller abort does not cancel owner and owner abort rejects late commit",
  temporary(async (options) => {
    await registerExecutionPlan({ threadId: "parent", units: [unit] }, options);
    let release, started;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const begin = new Promise((resolve) => {
      started = resolve;
    });
    const owner = new AbortController(),
      joiner = new AbortController();
    const first = routePlannedUnit(
      args,
      async () => {
        started();
        await gate;
        return decide();
      },
      { ...options, signal: owner.signal },
    );
    await begin;
    const second = routePlannedUnit(args, decide, {
      ...options,
      signal: joiner.signal,
    });
    joiner.abort();
    assert.equal((await second).nextAction, "stop");
    assert.equal(owner.signal.aborted, false);
    owner.abort();
    assert.equal((await first).reasonCode, "timeout");
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const saved = JSON.parse(
      await readFile(join(options.dataDir, "execution-plans.json"), "utf8"),
    )[0].units[0];
    assert.equal(saved.attempts.length, 0);
    assert.equal(saved.pending, undefined);
  }),
);

// Real native entry envelopes, bounded pagination, and a persisted metadata plan.
import { inspectSubtasks } from '../src/subtask-history.mjs';
import { executionHistoryScope, readExecutionPlan } from '../src/execution-plan.mjs';
const registrationEntry = (plan, changes = {}) => ({
  turnId: 'parent-turn', startedAtMs: Date.parse(plan.createdAt) - 1,
  completedAtMs: Date.parse(plan.createdAt) + 1,
  item: {
    type: 'mcpToolCall', server: 'jev-router', tool: 'register_execution_plan',
    status: 'completed', arguments: { threadId: 'parent' }, error: null,
    result: { content: [{ type: 'text', text: JSON.stringify(plan) }] },
  }, ...changes,
});
const activityEntry = (token, id = 'child') => ({ item: {
  type: 'subAgentActivity', agentThreadId: id, agentPath: `/root/${token}`, kind: 'completed',
} });
const routeEntry = (d) => ({ item: {
  type: 'mcpToolCall', server: 'jev-router', tool: 'route_execution_subtask',
  status: 'completed', result: { structuredContent: d },
} });
const ancient = () => Array.from({ length: 700 }, (_, i) => ({ item: {
  type: 'subAgentActivity', agentThreadId: `ancient-${i}`, agentPath: `/root/ancient-${i}`, kind: 'completed',
} }));
function nativeReaders(entries, { childModel = 'gpt-6-sol', childHistoryIncomplete = false, badCursor = false } = {}) {
  const calls = [];
  return {
    calls,
    readThread: async ({ threadId }) => ({ thread: {
      id: threadId, historyMode: 'paginated', parentThreadId: threadId === 'parent' ? null : 'parent',
      model: childModel, reasoningEffort: 'medium', turns: [], status: { type: 'idle' },
    } }),
    readItems: async ({ threadId, cursor, limit }) => {
      calls.push({ threadId, cursor, limit });
      if (threadId !== 'parent') return { data: [], nextCursor: childHistoryIncomplete ? String(Number(cursor || 0) + 1) : null };
      const offset = Number(cursor || 0);
      return { data: entries.slice(offset, offset + limit), ...(badCursor ? {} : {
        nextCursor: offset + limit < entries.length ? String(offset + limit) : null,
      }) };
    },
  };
}
async function scopedHistory(plan, entries, opts = {}) {
  const io = nativeReaders(entries, opts);
  const h = await inspectSubtasks({ threadId: 'parent', registrationScope: executionHistoryScope(plan),
    ...io, ...(opts.inspect || {}) });
  return { h, io };
}
async function acceptedFixture(options) {
  const plan = await registerExecutionPlan({ threadId: 'parent', units: [unit] }, options);
  const d = await routePlannedUnit(args, decide, options);
  await reconcileExecutionPlan('parent', report(d), options);
  await recordExecutionAcceptance({ ...args, routeId: d.routeId, accepted: true, evidence: 'Private native deliverable checked' }, options);
  return { plan: await readExecutionPlan('parent', options), d, original: plan };
}

test('original native registration proves a complete current plan despite 700 older unrelated items', temporary(async (options) => {
  const { plan, d, original } = await acceptedFixture(options);
  const entries = [activityEntry(d.routingToken), routeEntry(d), registrationEntry(original), ...ancient()];
  const { h, io } = await scopedHistory(plan, entries);
  assert.equal(h.truncated, true);
  assert.equal(h.coverage.globalHistory, 'truncated');
  assert.equal(h.coverage.parentHistory, 'unknown');
  assert.equal(h.coverage.currentPlan.coverage, 'complete');
  assert.equal(h.coverage.candidateCount, 1);
  assert.equal(h.coverage.parentItemLimit, 500);
  assert.equal(io.calls.filter((x) => x.threadId === 'parent').length, 1);
  const result = await reconcileExecutionPlan('parent', h, options);
  assert.equal(result.allVerified, true);
  assert.equal(result.coverageScope, 'currentPlan');
  const persisted = await readFile(join(options.dataDir, 'execution-plans.json'), 'utf8');
  for (const secret of [unit.task, unit.acceptanceCriteria, 'Private native deliverable checked']) assert.equal(persisted.includes(secret), false);
}));

test('missing or mismatched registration proof and idempotent replay cannot shorten the plan interval', temporary(async (options) => {
  const { plan, d, original } = await acceptedFixture(options);
  const created = Date.parse(plan.createdAt);
  const valid = registrationEntry(original);
  const invalid = [
    null,
    { ...valid, startedAtMs: undefined },
    { ...valid, completedAtMs: null },
    { ...valid, startedAtMs: created + 2, completedAtMs: created + 3 },
    { ...valid, item: { ...valid.item, arguments: { threadId: 'another-parent' } } },
    { ...valid, item: { ...valid.item, server: 'another-server' } },
    { ...valid, item: { ...valid.item, status: 'failed' } },
    { ...valid, item: { ...valid.item, result: { structuredContent: { planId: 'wrong-plan' } } } },
  ];
  for (const boundary of invalid) {
    const entries = [activityEntry(d.routingToken), routeEntry(d), ...(boundary ? [boundary] : []), ...ancient()];
    const { h } = await scopedHistory(plan, entries);
    assert.equal(h.coverage.currentPlan.coverage, 'incomplete');
    assert.equal((await reconcileExecutionPlan('parent', h, options)).allVerified, false);
    assert.ok(h.coverage.parentItemsRead <= 500);
  }
  const reused = registrationEntry(original, { startedAtMs: created + 20, completedAtMs: created + 30 });
  const padding = Array.from({ length: 105 }, () => ({ item: { type: 'userMessage' } }));
  const { h } = await scopedHistory(plan, [reused, ...padding, activityEntry(d.routingToken), routeEntry(d), valid, ...ancient()]);
  assert.equal(h.coverage.parentPagesRead, 2);
  assert.equal(h.coverage.currentPlan.boundary.startedAtMs, created - 1);
  assert.equal((await reconcileExecutionPlan('parent', h, options)).allVerified, true);
}));

test('current-plan events exceeding 500 items, pagination errors and unread children never verify', temporary(async (options) => {
  const { plan, d, original } = await acceptedFixture(options);
  const entries = [activityEntry(d.routingToken), routeEntry(d), registrationEntry(original), ...ancient()];
  for (const [input, opts] of [
    [[...Array.from({ length: 500 }, () => ({ item: { type: 'userMessage' } })), ...entries], {}],
    [entries, { badCursor: true }],
    [entries, { childHistoryIncomplete: true, inspect: { includeResults: true } }],
    [[activityEntry('jev_' + 'b'.repeat(32), 'another'), ...entries], { inspect: { limit: 1 } }],
    [[activityEntry(d.routingToken, 'duplicate'), ...entries], {}],
    [entries, { childModel: 'gpt-6-luna' }],
    [[activityEntry(d.routingToken), routeEntry({ ...d, model: 'gpt-6-astra' }), registrationEntry(original), ...ancient()], {}],
  ]) {
    const { h } = await scopedHistory(plan, input, opts);
    assert.equal((await reconcileExecutionPlan('parent', h, options)).allVerified, false);
    assert.ok(h.coverage.parentItemsRead <= 500);
  }
}));

test('replacement retains original registration target and cannot scope inherited attempts to replacement time', temporary(async (options) => {
  const { plan, d, original } = await acceptedFixture(options);
  const added = { ...unit, unitId: 'added' };
  const replacement = await registerExecutionPlan({ threadId: 'parent', units: [unit, added], replace: true }, options);
  assert.deepEqual(replacement.historyOrigin, { planId: plan.planId, createdAt: plan.createdAt });
  const newD = await routePlannedUnit({ ...args, unitId: 'added' }, decide, options);
  await reconcileExecutionPlan('parent', { coverage: { parentHistory: 'complete' }, tasks: [...report(d).tasks, ...report(newD).tasks] }, options);
  await recordExecutionAcceptance({ ...args, unitId: 'added', routeId: newD.routeId, accepted: true, evidence: 'checked' }, options);
  const current = await readExecutionPlan('parent', options);
  const recent = [activityEntry(newD.routingToken, 'new-child'), routeEntry(newD), registrationEntry(replacement)];
  let h = (await scopedHistory(current, [...recent, ...ancient()])).h;
  assert.equal(h.coverage.currentPlan.coverage, 'incomplete');
  assert.equal((await reconcileExecutionPlan('parent', h, options)).allVerified, false);
  h = (await scopedHistory(current, [...recent, activityEntry(d.routingToken), routeEntry(d), registrationEntry(original), ...ancient()])).h;
  assert.equal((await reconcileExecutionPlan('parent', h, options)).allVerified, true);
  const { writeFile } = await import('node:fs/promises');
  // Legacy replacement has no provenance and carries an attempt predating its registration.
  delete current.historyOrigin;
  current.createdAt = new Date(Date.parse(d.createdAt || original.createdAt) + 1000).toISOString();
  await writeFile(join(options.dataDir, 'execution-plans.json'), JSON.stringify([current]));
  assert.equal(executionHistoryScope(current).originPlanId, undefined);
  h = (await scopedHistory(current, [...recent, activityEntry(d.routingToken), registrationEntry(current), ...ancient()])).h;
  assert.equal((await reconcileExecutionPlan('parent', h, options)).allVerified, false);
}));

test('a registration found on a broken pagination page cannot bypass the read error', temporary(async (options) => {
  const { plan, d, original } = await acceptedFixture(options);
  let page = 0;
  const io = nativeReaders([]);
  io.readItems = async () => ({ data: ++page === 1
    ? [activityEntry(d.routingToken), routeEntry(d)] : [registrationEntry(original)], nextCursor: 'repeat' });
  const h = await inspectSubtasks({ threadId: 'parent', registrationScope: executionHistoryScope(plan), ...io });
  assert.match(h.readError, /repeated a cursor/);
  assert.equal(h.coverage.currentPlan.coverage, 'incomplete');
  assert.equal((await reconcileExecutionPlan('parent', h, options)).allVerified, false);
}));

test('unlinked route evidence and mismatched scoped plan proof cannot verify', temporary(async (options) => {
  const { plan, d, original } = await acceptedFixture(options);
  const { h } = await scopedHistory(plan, [activityEntry(d.routingToken), routeEntry(d), registrationEntry(original), ...ancient()]);
  for (const changed of [
    { ...h, coverage: { ...h.coverage, unlinkedRoutingTokens: ['jev_' + 'c'.repeat(32)] } },
    { ...h, coverage: { ...h.coverage, currentPlan: { ...h.coverage.currentPlan, planId: 'other-plan' } } },
    { ...h, tasks: [...h.tasks, { childThreadId: 'unread', readError: 'unavailable' }] },
  ]) assert.equal((await reconcileExecutionPlan('parent', changed, options)).allVerified, false);
}));


test("a new review or goal uses a fresh stable unit while same-unit changes cannot bypass identity", temporary(async options => {
  const review = { unitId: "review-plan", task: "Independently review the plan", acceptanceCriteria: "Plan constraints checked" };
  const execute = { ...unit, unitId: "execute-plan", dependencies: [review.unitId] };
  await registerExecutionPlan({ threadId: "parent", units: [review, execute] }, options);
  let calls = 0;
  const picker = async () => { calls++; return decide(); };
  const request = { threadId: "parent", ...review, structuredContext: { stage: "review", goal: "Validate plan" } };
  const first = await routePlannedUnit(request, picker, options);
  const same = await routePlannedUnit(request, picker, options);
  assert.equal(same.reused, true);
  assert.equal(same.routingToken, first.routingToken);
  assert.equal(calls, 1);
  assert.equal((await routePlannedUnit({ ...request, structuredContext: { stage: "execution", goal: "Implement plan" } }, picker, options)).reasonCode, "unit_changed");
  assert.equal((await routePlannedUnit({ threadId: "parent", ...execute }, picker, options)).reasonCode, "dependency_incomplete");
  assert.equal((await routePlannedUnit({ ...request, retry: true, launchState: "unknown" }, picker, options)).reasonCode, "completion_check_required");
  await reconcileExecutionPlan("parent", report(first), options);
  await recordExecutionAcceptance({ threadId: "parent", unitId: review.unitId, routeId: first.routeId, accepted: true, evidence: "Checked exact plan constraints" }, options);
  const second = await routePlannedUnit({ threadId: "parent", ...execute, structuredContext: { stage: "execution" } }, picker, options);
  assert.equal(second.nextAction, "execute");
  assert.notEqual(second.routingToken, first.routingToken);
  assert.equal(calls, 2);
}));
