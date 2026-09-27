import test from "node:test";
import assert from "node:assert/strict";
import { boundPrompt } from "../src/routing-context.mjs";
import { TASK_KINDS } from "../src/routing-policy.mjs";
import {
  chooseRoute,
  chooseSubtaskRoute,
  detectExplicitOverride,
} from "../src/route-core.mjs";

const models = [
  {
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "Astra",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-6-sol",
    model: "gpt-6-sol",
    displayName: "Sol",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ],
  },
  {
    id: "gpt-6-luna",
    model: "gpt-6-luna",
    displayName: "Luna",
    supportedReasoningEfforts: ["low", "medium"],
  },
];

const jev =
  ({
    score = 0.1,
    confidence = 0.95,
    risk = 0.1,
    ambiguous = 0.1,
    staged = false,
    secondOpinion = false,
    taskKind = "code",
  } = {}) =>
  async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const request = JSON.parse(options.body);
    assert.equal(request.model, "jev-latest");
    assert.equal(request.questions.complexity.type, "score");
    assert.equal(request.questions.high_consequence.type, "noul");
    assert.equal(request.questions.underspecified.type, "noul");
    assert.equal(request.questions.staged_execution.type, "noul");
    assert.equal(request.questions.second_opinion.type, "noul");
    return {
      ok: true,
      json: async () => ({
        answers: {
          task_kind: {
            type: "choice",
            choice: taskKind,
            confidence: 0.95,
            probabilities: Object.fromEntries(
              TASK_KINDS.map((k) => [k, k === taskKind ? 1 : 0]),
            ),
          },
          complexity: { type: "score", score, confidence },
          high_consequence: { type: "noul", noul: risk },
          underspecified: { type: "noul", noul: ambiguous },
          staged_execution: { type: "noul", noul: staged ? 0.9 : 0.1 },
          second_opinion: { type: "noul", noul: secondOpinion ? 0.9 : 0.1 },
        },
      }),
    };
  };

test("routine task uses a lighter available model; deep task escalates", async () => {
  const simple = await chooseRoute({
    prompt: "Rename a variable",
    models,
    apiKey: "test",
    fetchImpl: jev(),
  });
  assert.deepEqual(
    [simple.model, simple.effort, simple.source],
    ["gpt-6-luna", "low", "jev"],
  );
  assert.equal(simple.confidence, 0.95);
  assert.ok(simple.elapsedMs >= 0);
  const deep = await chooseRoute({
    prompt: "Diagnose and redesign the architecture",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 2.8, staged: true, taskKind: "architecture" }),
  });
  assert.deepEqual([deep.model, deep.effort], ["gpt-6-astra", "xhigh"]);
  assert.equal(deep.phase, "plan_execute");
  assert.equal(deep.needsSecondOpinion, false);
});

test("consequence and uncertainty move a borderline task to stronger route", async () => {
  const highRisk = await chooseRoute({
    prompt: "Audit transaction handling",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 1.7, risk: 0.9 }),
  });
  assert.equal(highRisk.model, "gpt-6-astra");
  const uncertain = await chooseRoute({
    prompt: "Continue",
    context: { summary: "Resolve multi-module defect" },
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 1.8, confidence: 0.4 }),
  });
  assert.equal(uncertain.model, "gpt-6-astra");
});

test("missing details conservatively select strong judgment even for short tasks", async () => {
  const simple = await chooseRoute({
    prompt: "Change the button color",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 0.08, confidence: 0.94, ambiguous: 0.88 }),
  });
  assert.deepEqual([simple.model, simple.effort], ["gpt-6-astra", "high"]);
  const borderline = await chooseRoute({
    prompt: "Compare two indexes",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 1.8, confidence: 0.8, ambiguous: 0.9 }),
  });
  assert.deepEqual(
    [borderline.model, borderline.effort],
    ["gpt-6-astra", "high"],
  );
});

test("explicit instruction takes priority and never requests a missing effort", async () => {
  const result = await chooseRoute({
    prompt: "这次用 Luna，推理拉高，修复这个 bug",
    models,
    apiKey: "test",
    fetchImpl: () => {
      throw new Error("must not call Jev");
    },
  });
  assert.deepEqual(
    [result.model, result.effort, result.source],
    ["gpt-6-luna", "medium", "explicit"],
  );
  assert.equal(result.confidence, 1);
});

test("manual model persists through settings; explicit prompt overrides it once", async () => {
  const settings = { manualModel: "gpt-6-sol", manualEffort: "high" };
  const manual = await chooseRoute({ prompt: "Continue", models, settings });
  assert.deepEqual(
    [manual.model, manual.effort, manual.source],
    ["gpt-6-sol", "high", "manual"],
  );
  const override = await chooseRoute({
    prompt: "请用 Astra",
    models,
    settings,
  });
  assert.deepEqual(
    [override.model, override.source],
    ["gpt-6-astra", "explicit"],
  );
});

test("TypeSafe failure and timeout return catalog-backed fallback", async () => {
  const unavailable = await chooseRoute({
    prompt: "Test",
    models,
    apiKey: "test",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(
    [unavailable.model, unavailable.effort, unavailable.source],
    ["gpt-6-astra", "high", "fallback"],
  );
  const timeout = await chooseRoute({
    prompt: "Test",
    models,
    apiKey: "test",
    settings: { timeoutMs: 10 },
    fetchImpl: () => new Promise(() => {}),
  });
  assert.deepEqual(
    [timeout.model, timeout.effort, timeout.source],
    ["gpt-6-astra", "high", "fallback"],
  );
  assert.match(timeout.reason, /超时/);
});

test("only non-hidden catalog models and supported efforts can be returned", async () => {
  const sparse = {
    data: [
      {
        id: "gpt-6-astra",
        hidden: true,
        supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
      },
      {
        id: "gpt-6-sol",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
    ],
  };
  const result = await chooseRoute({
    prompt: "hard problem",
    models: sparse,
    apiKey: "test",
    fetchImpl: jev({ score: 3 }),
  });
  assert.deepEqual([result.model, result.effort], ["gpt-6-sol", "low"]);
  const fallback = await chooseRoute({
    prompt: "test",
    models: sparse,
    settings: { fallbackModel: "missing", fallbackEffort: "ultra" },
  });
  assert.deepEqual([fallback.model, fallback.effort], ["gpt-6-sol", "low"]);
  await assert.rejects(
    () => chooseRoute({ prompt: "test", models: [] }),
    /No available/,
  );
});

test("context passed to Jev is bounded", async () => {
  let state;
  await chooseRoute({
    prompt: "Continue",
    context: {
      summary: "a".repeat(9999),
      progress: "b".repeat(9999),
      lastResult: "c".repeat(9999),
      secret: "excluded",
    },
    models,
    apiKey: "test",
    fetchImpl: async (_, options) => {
      state = JSON.parse(options.body).state;
      return jev()(_, options);
    },
  });
  assert.equal(state.context.summary.length, 2500);
  assert.equal(state.context.progress.length, 1000);
  assert.equal(state.context.lastResult.length, 1000);
  assert.equal(state.context.secret, undefined);
});

test("a cancelled request returns quickly even when fetch ignores AbortSignal", async () => {
  const controller = new AbortController();
  const pending = chooseRoute({
    prompt: "test",
    models,
    apiKey: "test",
    signal: controller.signal,
    fetchImpl: () => new Promise(() => {}),
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.source, "fallback");
  assert.ok(result.elapsedMs < 100);
});

test("colloquial one-turn model instruction is honored", async () => {
  const result = await chooseRoute({
    prompt: "先分析，再用 astra，推理拉高",
    models,
  });
  assert.deepEqual(
    [result.model, result.effort, result.source],
    ["gpt-6-astra", "high", "explicit"],
  );
  assert.deepEqual(detectExplicitOverride("这次用 Astra，推理拉高", models), {
    model: "gpt-6-astra",
    effort: "high",
  });
  assert.deepEqual(
    detectExplicitOverride("请用 Astra 把按钮改成蓝色并替换文字", models),
    { model: "gpt-6-astra" },
  );
  assert.equal(detectExplicitOverride("请比较 Astra 和 Sol", models), null);
});

test("negated and quoted model names do not override a positive instruction", async () => {
  const prompt =
    "不要使用 Luna，请用 Astra 完成复杂审计。此前的说法“请用 Sol”只是引用。";
  assert.deepEqual(detectExplicitOverride(prompt, models), {
    model: "gpt-6-astra",
  });
  const result = await chooseRoute({
    prompt,
    models,
    fetchImpl: () => {
      throw new Error("must not call Jev");
    },
  });
  assert.deepEqual([result.model, result.source], ["gpt-6-astra", "explicit"]);
  assert.equal(
    detectExplicitOverride("不要用 Luna。文档写着“请用 Sol”。", models),
    null,
  );
  assert.equal(
    detectExplicitOverride("> 请用 Luna\n请用 Sol", models)?.model,
    "gpt-6-sol",
  );
  assert.equal(
    detectExplicitOverride("Do not use Luna; use Astra", models)?.model,
    "gpt-6-astra",
  );
  assert.equal(
    detectExplicitOverride("先用 Sol；最终请用 Astra", models)?.model,
    "gpt-6-astra",
  );
});

test("negation scope survives intervening words and combines with a positive directive", async () => {
  const negativeClauses = [
    "不要再使用 Luna",
    "无需使用 Luna",
    "无须继续选择 Luna",
    "不需要重新切换到 Luna",
    "请不要在仍未完成验收且当前工作尚未提交审查的情况下继续使用 Luna",
    "不要使用 Luna，或者选择 Sol",
    "do not under any circumstances use Luna",
    "don't ever choose Luna",
    "never again switch to Luna",
  ];
  for (const negative of negativeClauses) {
    assert.equal(detectExplicitOverride(negative, models), null, negative);
    for (const prompt of [
      `请用 Astra，${negative}`,
      `${negative}；请用 Astra`,
    ]) {
      assert.deepEqual(
        detectExplicitOverride(prompt, models),
        { model: "gpt-6-astra" },
        prompt,
      );
      const result = await chooseRoute({
        prompt,
        models,
        settings: { manualModel: "gpt-6-sol" },
      });
      assert.deepEqual(
        [result.model, result.source],
        ["gpt-6-astra", "explicit"],
        prompt,
      );
    }
  }
  assert.deepEqual(
    detectExplicitOverride(
      "请用 Astra，推理拉高；无需再把推理强度调到 low",
      models,
    ),
    { model: "gpt-6-astra", effort: "high" },
  );
});

test("quoted reports, examples, and ambiguous questions never force a model or effort", () => {
  const ambiguous = [
    "'请用 Luna，推理拉高'",
    "‘请用 Luna，推理拉高’",
    "“请用 Luna\n推理拉高”",
    "文档写着：请用 Luna，推理拉高",
    "示例：使用 Luna，推理拉高",
    "The document says: use Luna, reasoning effort: high",
    "此前用户说请用 Luna",
    "如果使用 Luna，结果会怎样",
    "Should we use Luna?",
    "请用 Luna 或 Sol",
    "use Luna or choose Sol",
    "请把使用 Luna 改成使用 Sol",
    "“请用 Luna",
    "```\n请用 Luna",
  ];
  for (const prompt of ambiguous) {
    assert.equal(detectExplicitOverride(prompt, models), null, prompt);
    assert.deepEqual(
      detectExplicitOverride(`请用 Astra。${prompt}`, models),
      { model: "gpt-6-astra" },
      prompt,
    );
  }
});

test("image input routes only through a model that supports images", async () => {
  const catalog = [
    { ...models[0], inputModalities: ["text"] },
    { ...models[1], inputModalities: ["text", "image"] },
    { ...models[2], inputModalities: ["text"] },
  ];
  const route = await chooseRoute({
    prompt: "Explain this image",
    context: { inputModalities: ["text", "image"] },
    models: catalog,
    apiKey: "test",
    fetchImpl: jev({ score: 3 }),
  });
  assert.equal(route.model, "gpt-6-sol");
  assert.equal(
    detectExplicitOverride("这次用 Astra", catalog, {
      inputModalities: ["text", "image"],
    }),
    null,
  );
  assert.equal(
    detectExplicitOverride("这次用 Sol", catalog, {
      inputModalities: ["text", "image"],
    })?.model,
    "gpt-6-sol",
  );
});

test("Jev marks high impact staged plans for a second strong-model review", async () => {
  const route = await chooseRoute({
    prompt: "Plan a production database migration",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 1.8, risk: 0.9, staged: true }),
  });
  assert.deepEqual(
    [route.phase, route.needsSecondOpinion, route.model, route.effort],
    ["plan_execute", true, "gpt-6-astra", "high"],
  );
  assert.deepEqual(
    [route.verifierModel, route.verifierEffort],
    ["gpt-6-sol", "high"],
  );
});

test("an already-planned subtask uses the lowest adequate model tier", async () => {
  const task = "Rename a local variable";
  let observed;
  const light = await chooseSubtaskRoute({
    task,
    acceptanceCriteria: "Tests pass",
    dependencies: "None",
    context: { summary: "The approved plan has three steps" },
    models,
    apiKey: "test",
    fetchImpl: async (url, options) => {
      observed = JSON.parse(options.body).state;
      return jev({ score: 0.1 })(url, options);
    },
  });
  assert.deepEqual(
    [light.phase, light.model, light.effort],
    ["execution", "gpt-6-luna", "low"],
  );
  assert.match(observed.prompt, /Tests pass/);
  assert.match(observed.context.dependencies, /None/);

  const normal = await chooseSubtaskRoute({
    task: "Implement a component and update its tests",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 1.6 }),
  });
  assert.deepEqual([normal.model, normal.effort], ["gpt-6-sol", "medium"]);
  const hard = await chooseSubtaskRoute({
    task: "Implement a novel compiler optimization",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 2.8 }),
  });
  assert.deepEqual([hard.model, hard.effort], ["gpt-6-astra", "high"]);
});

test("subtask route preserves manual model mode and uses fallback on Jev failure", async () => {
  const manual = await chooseSubtaskRoute({
    task: "Do planned work",
    models,
    settings: {
      mode: "manual",
      manualModel: "gpt-6-astra",
      manualEffort: "high",
    },
  });
  assert.deepEqual(
    [manual.source, manual.model, manual.effort],
    ["manual", "gpt-6-astra", "high"],
  );
  const failed = await chooseSubtaskRoute({
    task: "Do planned work",
    models,
    apiKey: "test",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(
    [failed.source, failed.model, failed.effort],
    ["fallback", "gpt-6-astra", "high"],
  );
});

test("Jev failure on a child retry keeps the previous capability floor", async () => {
  const retry = await chooseSubtaskRoute({
    task: "Repair failed migration",
    previousModel: "gpt-6-astra",
    previousEffort: "high",
    failureCategory: "capability",
    failureSummary: "Previous attempt failed a required invariant",
    models,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(
    [retry.model, retry.effort, retry.source, retry.escalated],
    ["gpt-6-astra", "high", "fallback", false],
  );
  const ceiling = await chooseSubtaskRoute({
    task: "Repair failed migration",
    previousModel: "gpt-6-astra",
    previousEffort: "xhigh",
    failureCategory: "capability",
    failureSummary: "Still failing",
    models,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(
    [ceiling.model, ceiling.effort, ceiling.escalated],
    ["gpt-6-astra", "xhigh", false],
  );
});

test("a missing previous model uses the current ceiling without claiming an upgrade", async () => {
  const cases = [
    {
      catalog: models.slice(1),
      previousModel: "gpt-6-astra",
      previousEffort: "xhigh",
      model: "gpt-6-sol",
      effort: "high",
    },
    {
      catalog: models.slice(1),
      previousModel: "gpt-6-astra",
      previousEffort: "low",
      model: "gpt-6-sol",
      effort: "high",
    },
    {
      catalog: [
        { ...models[0], supportedReasoningEfforts: ["low", "medium"] },
        ...models.slice(1),
      ],
      previousModel: "gpt-6-astra",
      previousEffort: "xhigh",
      model: "gpt-6-astra",
      effort: "medium",
    },
    {
      catalog: [
        { ...models[0], id: "gpt-5.6-astra", model: "gpt-5.6-astra" },
        ...models.slice(1),
      ],
      previousModel: "gpt-6-astra",
      previousEffort: "low",
      model: "gpt-5.6-astra",
      effort: "high",
    },
  ];
  for (const entry of cases) {
    for (const source of ["fallback", "jev"]) {
      const route = await chooseSubtaskRoute({
        task: "Repair an incomplete execution unit",
        models: entry.catalog,
        previousModel: entry.previousModel,
        previousEffort: entry.previousEffort,
        failureCategory: "capability",
        failureSummary: "Required invariant failed",
        settings: { fallbackModel: "gpt-6-luna", fallbackEffort: "low" },
        apiKey: "test",
        fetchImpl:
          source === "jev"
            ? jev({ score: 0.1 })
            : async () => {
                throw new Error("offline");
              },
      });
      assert.deepEqual(
        [route.model, route.effort, route.source, route.escalated],
        [entry.model, entry.effort, source, false],
      );
      assert.match(route.reason, /无法升级/);
      assert.match(route.reason, /重新规划/);
    }
  }
});

test("catalog changes still permit a real model upgrade from the previous configuration", async () => {
  for (const source of ["fallback", "jev"]) {
    const route = await chooseSubtaskRoute({
      task: "Repair an incomplete execution unit",
      models: models.slice(0, 2),
      previousModel: "gpt-6-luna",
      previousEffort: "medium",
      failureCategory: "capability",
      failureSummary: "Required invariant failed",
      settings: { fallbackModel: "gpt-6-sol", fallbackEffort: "low" },
      apiKey: "test",
      fetchImpl:
        source === "jev"
          ? jev({ score: 0.1 })
          : async () => {
              throw new Error("offline");
            },
    });
    assert.deepEqual(
      [route.model, route.effort, route.source, route.escalated],
      [
        source === "fallback" ? "gpt-6-astra" : "gpt-6-sol",
        "high",
        source,
        true,
      ],
    );
  }
});

test("long plan and prior result retain current dependencies and failure evidence", async () => {
  let context;
  await chooseSubtaskRoute({
    task: "Execute the next planned unit",
    acceptanceCriteria: "Required acceptance",
    dependencies: "MUST_WAIT_FOR_APPROVED_SCHEMA",
    failureCategory: "capability",
    failureSummary: "PREVIOUS_ATTEMPT_CORRUPTED_INDEX",
    context: { summary: "p".repeat(3000), lastResult: "r".repeat(1500) },
    models,
    apiKey: "test",
    fetchImpl: async (url, options) => {
      context = JSON.parse(options.body).state.context;
      return jev()(url, options);
    },
  });
  assert.ok(context.summary.length <= 2500);
  assert.ok(context.lastResult.length <= 1000);
  assert.match(context.dependencies, /MUST_WAIT_FOR_APPROVED_SCHEMA/);
  assert.match(context.failureSummary, /PREVIOUS_ATTEMPT_CORRUPTED_INDEX/);
});

test("failure evidence uses the full budget and takes priority over older results", async () => {
  const marker = "ACTUAL_FAILURE: required invariant was lost!";
  for (const lastResult of ["", "old".repeat(500)]) {
    for (const length of [650, 1000, 1100]) {
      const failureSummary = "r".repeat(length - marker.length) + marker;
      let observed;
      await chooseSubtaskRoute({
        task: "Repair the failed unit",
        failureCategory: "capability",
        failureSummary,
        context: { lastResult },
        models,
        apiKey: "test",
        fetchImpl: async (url, options) => {
          observed = JSON.parse(options.body).state.context.failureSummary;
          return jev()(url, options);
        },
      });
      const expectedFailure = boundPrompt(failureSummary, 1000);
      assert.ok(observed.length <= 1000);
      assert.ok(observed.endsWith(expectedFailure));
      if (!lastResult || failureSummary.length >= 1000)
        assert.equal(observed, expectedFailure);
    }
  }
});

test("a failed child attempt escalates model and effort, then stops at the available ceiling", async () => {
  const newlyHighRisk = await chooseSubtaskRoute({
    task: "Repair a high-impact migration",
    previousModel: "gpt-6-luna",
    previousEffort: "low",
    failureCategory: "capability",
    failureSummary: "Data integrity risk found",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 2.8, risk: 0.9 }),
  });
  assert.equal(
    newlyHighRisk.model,
    "gpt-6-astra",
    "retry upgrade must not downgrade Jev’s new strong recommendation",
  );
  const firstRetry = await chooseSubtaskRoute({
    task: "Implement one bounded unit",
    previousModel: "gpt-6-luna",
    previousEffort: "low",
    failureCategory: "capability",
    failureSummary: "The first attempt missed a required interface",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 0.2 }),
  });
  assert.deepEqual(
    [firstRetry.model, firstRetry.effort, firstRetry.escalated],
    ["gpt-6-sol", "medium", true],
  );
  const secondRetry = await chooseSubtaskRoute({
    task: "Implement one bounded unit",
    previousModel: "gpt-6-sol",
    previousEffort: "medium",
    failureCategory: "capability",
    failureSummary: "The implementation still fails the contract",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 0.2 }),
  });
  assert.deepEqual(
    [secondRetry.model, secondRetry.effort, secondRetry.escalated],
    ["gpt-6-astra", "high", true],
  );
  const ceiling = await chooseSubtaskRoute({
    task: "Implement one bounded unit",
    previousModel: "gpt-6-astra",
    previousEffort: "xhigh",
    failureCategory: "capability",
    failureSummary: "The highest route still failed",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 0.2 }),
  });
  assert.deepEqual(
    [ceiling.model, ceiling.effort, ceiling.escalated],
    ["gpt-6-astra", "xhigh", false],
  );
});

test("planning does not force xhigh and xhigh requires kind, confidence and difficulty", async () => {
  for (const [score, confidence, taskKind, expected] of [
    [1.2, 0.9, "code", "medium"],
    [2.8, 0.9, "code", "high"],
    [2.8, 0.6, "architecture", "high"],
    [2.64, 0.9, "review", "high"],
    [2.65, 0.65, "diagnostic", "xhigh"],
  ]) {
    const result = await chooseRoute({
      prompt: "Plan the work",
      models,
      apiKey: "test",
      fetchImpl: jev({ score, confidence, taskKind, staged: true }),
    });
    assert.equal(result.effort, expected);
    assert.equal(result.phase, "plan_execute");
  }
});
test("policy changes family preference within the capability floor", async () => {
  const result = await chooseRoute({
    prompt: "Write explanation",
    models,
    settings: { routingPolicy: { tasks: { writing: ["astra", "sol"] } } },
    apiKey: "test",
    fetchImpl: jev({ score: 1.3, taskKind: "writing" }),
  });
  assert.equal(result.model, "gpt-6-astra");
  assert.equal(result.effort, "medium");
});
test("unknown catalog model is not a cheap substitute and reports capability limit", async () => {
  const onlyUnknown = [
    {
      id: "novel",
      isDefault: true,
      description: "Unverified capability",
      inputModalities: ["text"],
      supportedReasoningEfforts: ["low", "high"],
    },
  ];
  const result = await chooseRoute({
    prompt: "Routine work",
    models: onlyUnknown,
    apiKey: "test",
    fetchImpl: jev({ taskKind: "routine" }),
  });
  assert.equal(result.capabilityLimited, true);
  assert.equal(result.nextAction, "replan");
  const manual = await chooseRoute({
    prompt: "use novel",
    models: onlyUnknown,
  });
  assert.equal(manual.source, "explicit");
  assert.equal(manual.nextAction, "execute");
});
test("unknown and unread attachment failures use strong planning, new goals discard old routes", async () => {
  const prior = {
    model: "gpt-6-luna",
    effort: "low",
    taskKind: "routine",
    phase: "direct",
  };
  for (const context of [
    {},
    { inputModalities: ["image"] },
    { previousRoute: prior },
    { previousRoute: prior, continuation: true, goalChanged: true },
  ]) {
    const result = await chooseRoute({ prompt: "Proceed", context, models });
    assert.equal(result.model, "gpt-6-astra");
    assert.equal(result.effort, "high");
    assert.equal(result.phase, "plan_execute");
  }
  const continuation = await chooseRoute({
    prompt: "Continue",
    context: {
      previousRoute: {
        ...prior,
        model: "gpt-6-astra",
        effort: "xhigh",
        phase: "plan_execute",
        highRisk: true,
      },
      continuation: true,
    },
    models,
  });
  assert.equal(continuation.effort, "xhigh");
  assert.equal(continuation.highRisk, true);
});
test("cancellation never starts execution and late response never replaces fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  const stopped = await chooseRoute({
    prompt: "use Astra",
    models,
    signal: controller.signal,
  });
  assert.equal(stopped.nextAction, "stop");
  const result = await chooseRoute({
    prompt: "Unknown",
    models,
    apiKey: "test",
    settings: { timeoutMs: 5 },
    fetchImpl: async (...args) => {
      await new Promise((r) => setTimeout(r, 25));
      return jev()(...args);
    },
  });
  assert.equal(result.reasonCode, "timeout");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(result.source, "fallback");
});
test("failure categories gate work without unconditional model escalation", async () => {
  for (const [failureCategory, nextAction] of [
    ["environment", "repair_environment"],
    ["permission", "stop"],
    ["plan", "replan"],
    ["missing_information", "needs_context"],
    ["unknown", "needs_context"],
  ]) {
    const result = await chooseSubtaskRoute({
      task: "Execute",
      models,
      previousModel: "gpt-6-sol",
      previousEffort: "medium",
      failureSummary: "Failed",
      failureCategory,
      attempt: 2,
      fetchImpl: () => {
        throw Error("should not request");
      },
    });
    assert.equal(result.nextAction, nextAction);
    assert.equal(result.model, "gpt-6-sol");
    assert.equal(result.escalated, false);
  }
  const exhausted = await chooseSubtaskRoute({
    task: "Execute",
    models,
    attempt: 3,
  });
  assert.equal(exhausted.nextAction, "stop");
  const uncertain = await chooseSubtaskRoute({
    task: "Execute",
    models,
    attempt: 2,
    failureCategory: "transient",
    launchState: "unknown",
  });
  assert.equal(uncertain.nextAction, "needs_context");
  const transient = await chooseSubtaskRoute({
    task: "Execute",
    models,
    attempt: 2,
    failureCategory: "transient",
    previousModel: "gpt-6-sol",
    previousEffort: "medium",
    launchState: "completed",
  });
  assert.equal(transient.nextAction, "execute");
  assert.equal(transient.effort, "medium");
});

test("low confidence cannot cheap-route a short prompt and execution asks for context", async () => {
  const route = await chooseRoute({
    prompt: "Do it",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 0.1, confidence: 0.3 }),
  });
  assert.equal(route.model, "gpt-6-astra");
  assert.equal(route.effort, "high");
  const child = await chooseSubtaskRoute({
    task: "Do it",
    models,
    apiKey: "test",
    fetchImpl: jev({ score: 0.1, ambiguous: 0.9 }),
  });
  assert.equal(child.nextAction, "needs_context");
});
test("local fallback neither calls Jev nor overrides explicit and manual controls", async () => {
  const blocked = () => {
    throw Error("network forbidden");
  };
  const result = await chooseRoute({
    prompt: "Unknown task",
    models,
    localOnly: true,
    fallbackReasonCode: "timeout",
    apiKey: "test",
    fetchImpl: blocked,
  });
  assert.equal(result.reasonCode, "timeout");
  const explicit = await chooseRoute({
    prompt: "use Luna",
    models,
    localOnly: true,
    fetchImpl: blocked,
  });
  assert.equal(explicit.source, "explicit");
});

test("ambiguous task category alone permits fully specified execution with conservative model", async () => {
  for (const judgment of [
    { taskKind: "unknown", score: 0, confidence: 1, ambiguous: 0.07 },
    { taskKind: "routine", score: 0, confidence: 0.4, ambiguous: 0.07 },
  ]) {
    const route = await chooseSubtaskRoute({
      task: "Replace teh with the in supplied text: teh cat",
      acceptanceCriteria: "Output exactly: the cat",
      context: { contextComplete: true },
      models,
      apiKey: "test",
      fetchImpl: jev(judgment),
    });
    assert.equal(route.nextAction, "execute");
    assert.equal(route.model, "gpt-6-astra");
    assert.equal(route.effort, "high");
  }
});
test("unread and truncated child context blocks execution through fallback and manual selection", async () => {
  for (const context of [
    { inputModalities: ["image"] },
    { summary: "x".repeat(10000) },
    { contextComplete: false },
  ]) {
    for (const settings of [
      {},
      { manualModel: "gpt-6-sol", manualEffort: "medium" },
    ]) {
      const route = await chooseSubtaskRoute({
        task: "Perform supplied task",
        context,
        settings,
        models,
        localOnly: true,
      });
      assert.equal(route.nextAction, "needs_context");
      if (settings.manualModel) assert.equal(route.model, "gpt-6-sol");
    }
  }
});

test("explicit task stage tier preferences take precedence over defaults", async () => {
  for (const [routingPolicy, expected] of [
    [{ stages: { execution: ["astra", "sol"] } }, "gpt-6-astra"],
    [{ tiers: { balanced: ["astra", "sol"] } }, "gpt-6-astra"],
    [
      {
        tasks: { code: ["sol"] },
        stages: { execution: ["astra"] },
        tiers: { balanced: ["astra"] },
      },
      "gpt-6-sol",
    ],
    [
      { stages: { execution: ["sol"] }, tiers: { balanced: ["astra"] } },
      "gpt-6-sol",
    ],
  ]) {
    const result = await chooseSubtaskRoute({
      task: "Implement a bounded component",
      models,
      settings: { routingPolicy },
      apiKey: "test",
      fetchImpl: jev({ score: 1.2 }),
    });
    assert.equal(result.model, expected);
  }
  const planned = await chooseRoute({
    prompt: "Plan normal work",
    models,
    settings: { routingPolicy: { tiers: { balanced: ["sol"] } } },
    apiKey: "test",
    fetchImpl: jev({ score: 1.2, staged: true }),
  });
  assert.equal(planned.model, "gpt-6-sol");
});
test("capability retry compares configured profiles without inferring strength from versions", async () => {
  const custom = {
    id: "gpt-custom",
    model: "gpt-custom",
    supportedReasoningEfforts: ["low", "medium", "high"],
  };
  const result = await chooseSubtaskRoute({
    task: "Repair bounded implementation",
    models: [...models, custom],
    previousModel: "gpt-6-sol",
    previousEffort: "medium",
    failureCategory: "capability",
    attempt: 2,
    settings: {
      routingPolicy: {
        models: { "gpt-custom": { capability: 3 } },
        tiers: { strong: ["gpt-custom"] },
        tasks: { code: ["gpt-custom"] },
      },
    },
    apiKey: "test",
    fetchImpl: jev({ score: 1.2 }),
  });
  assert.equal(result.model, "gpt-custom");
  assert.equal(result.escalated, true);
  assert.equal(result.nextAction, "execute");
  const unknown = await chooseSubtaskRoute({
    task: "Repair",
    models,
    previousModel: "gpt-mystery",
    previousEffort: "low",
    failureCategory: "capability",
    attempt: 2,
    apiKey: "test",
    fetchImpl: jev({ score: 1.2 }),
  });
  assert.equal(unknown.escalated, false);
  assert.equal(unknown.nextAction, "replan");
});

test('fallback preserves an established high-risk review obligation only for continuation', async () => {
 const previousRoute={model:'gpt-6-astra',effort:'high',phase:'plan_execute',taskKind:'architecture',highRisk:true,needsSecondOpinion:true,contextComplete:true};
 const result=await chooseRoute({prompt:'Continue',models,context:{continuation:true,previousRoute},localOnly:true,fallbackReasonCode:'timeout'});
 assert.equal(result.needsSecondOpinion,true); assert.equal(result.verifierModel,'gpt-6-sol');
 const changed=await chooseRoute({prompt:'New task',models,context:{goalChanged:true,previousRoute},localOnly:true});
 assert.equal(changed.needsSecondOpinion,false);
});


test("long-history status uses scoped Jev context and direct routing even for uncertain category", async () => {
  let state;
  const fetch = jev({ score: 0.4, taskKind: "unknown", staged: true });
  const result = await chooseRoute({
    prompt: "还有什么优化没做完", models, apiKey: "test",
    context: { summary: "Historical architecture and deployment work. ".repeat(300),
      lastResult: "Implementation is tested; native acceptance remains pending.",
      constraints: "Report observed evidence only.", continuation: true,
      previousRoute: { highRisk: true, phase: "plan_execute", taskKind: "architecture" } },
    fetchImpl: (url, options) => { state = JSON.parse(options.body).state; return fetch(url, options); },
  });
  assert.equal(state.context.historyTruncated, true);
  assert.equal(state.context.currentContextComplete, true);
  assert.equal(state.context.contextComplete, true);
  assert.equal(state.context.turnIntent, "status");
  assert.ok(state.context.summary.length <= 900);
  assert.equal(result.phase, "direct");
  assert.equal(result.model, "gpt-6-sol");
  assert.equal(result.effort, "medium");
  assert.equal(result.source, "jev");
  assert.equal(result.highRisk, false);
  assert.equal(result.needsSecondOpinion, false);
});

test("known status fallback is balanced direct without discarding missing current evidence", async () => {
  const context = { summary: "history ".repeat(2000), lastResult: "One unit pending.",
    previousRoute: { highRisk: true, phase: "plan_execute", taskKind: "architecture" }, continuation: true };
  const status = await chooseRoute({ prompt: "What is the status?", models, context, localOnly: true });
  assert.deepEqual([status.model, status.effort, status.phase], ["gpt-6-sol", "medium", "direct"]);
  for (const patch of [{ constraints: "must ".repeat(1000) }, { inputModalities: ["image"] }, { contextComplete: false }]) {
    const result = await chooseRoute({ prompt: "What is the status?", models, context: { ...context, ...patch }, apiKey: "test", fetchImpl: jev() });
    assert.equal(result.contextComplete, false);
    assert.equal(result.model, "gpt-6-astra");
    assert.equal(result.phase, "plan_execute");
  }
  const absent = await chooseRoute({ prompt: "What is the status?", models, localOnly: true });
  assert.equal(absent.contextComplete, false);
  assert.equal(absent.model, "gpt-6-astra");
});

test("status optimization cannot erase execution risk or override manual choices", async () => {
  const context = { summary: "Deployment has unresolved checks.", continuation: true,
    previousRoute: { highRisk: true, phase: "plan_execute", needsSecondOpinion: true, capabilityFloor: 3 } };
  for (const prompt of ["Continue after reporting status", "还有什么优化没做完，继续做", "不要只说进度，执行上线", '"What is the status?"']) {
    const result = await chooseRoute({ prompt, models, context, apiKey: "test", fetchImpl: jev() });
    assert.equal(result.highRisk, true, prompt);
    assert.equal(result.model, "gpt-6-astra", prompt);
    assert.equal(result.needsSecondOpinion, true, prompt);
  }
  const manual = await chooseRoute({ prompt: "还有什么优化没做完", models, context,
    settings: { manualModel: "gpt-6-astra", manualEffort: "xhigh" } });
  assert.equal(manual.source, "manual"); assert.equal(manual.effort, "xhigh");
});


test("a status query with only truncated historical evidence stays conservative", async () => {
  const result = await chooseRoute({ prompt: "还有什么优化没做完", models,
    context: { summary: "Old implementation discussion. ".repeat(300) },
    apiKey: "test", fetchImpl: jev({ score: 0.1, taskKind: "routine" }) });
  assert.equal(result.contextComplete, false);
  assert.equal(result.phase, "plan_execute");
  assert.equal(result.model, "gpt-6-astra");
});
