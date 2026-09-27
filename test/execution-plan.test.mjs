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
