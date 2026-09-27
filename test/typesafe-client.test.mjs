import { TASK_KINDS } from "../src/routing-policy.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTask, TypeSafeError } from "../src/typesafe-client.mjs";

const validAnswers = {
  task_kind: {
    type: "choice",
    choice: "code",
    confidence: 0.9,
    probabilities: Object.fromEntries(
      TASK_KINDS.map((k) => [k, k === "code" ? 1 : 0]),
    ),
  },
  complexity: { type: "score", score: 2, confidence: 0.91 },
  high_consequence: { type: "noul", noul: 0.2 },
  underspecified: { type: "noul", noul: 0.4 },
  staged_execution: { type: "noul", noul: 0.85 },
  second_opinion: { type: "noul", noul: 0.7 },
};

test("requests bounded stage and review judgments and preserves existing result fields", async () => {
  let request;
  const result = await evaluateTask({
    prompt: "Implement a multi-step change",
    context: { previous: "Requirements are confirmed" },
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      request = options;
      return { ok: true, json: async () => ({ answers: validAnswers }) };
    },
  });

  const body = JSON.parse(request.body);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state, {
    prompt: "Implement a multi-step change",
    context: { previous: "Requirements are confirmed" },
  });
  assert.equal(body.questions.staged_execution.type, "noul");
  assert.equal(body.questions.second_opinion.type, "noul");
  assert.match(
    body.questions.staged_execution.instructions,
    /acceptance criteria/i,
  );
  assert.match(
    body.questions.second_opinion.instructions,
    /critical assumption remains unresolved/i,
  );
  assert.deepEqual(result, {
    taskKind: "code",
    taskKindConfidence: 0.9,
    complexity: 2,
    confidence: 0.91,
    highConsequence: 0.2,
    underspecified: 0.4,
    staged: true,
    needsSecondOpinion: true,
  });
});

test("rejects missing or malformed added judgments", async () => {
  for (const [name, value] of [
    ["missing stage judgment", undefined],
    ["wrong review type", { type: "score", noul: 0.5 }],
    ["out of range review judgment", { type: "noul", noul: 1.1 }],
  ]) {
    const answers = { ...validAnswers };
    if (name === "missing stage judgment") delete answers.staged_execution;
    else answers.second_opinion = value;
    await assert.rejects(
      evaluateTask({
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: true, json: async () => ({ answers }) }),
      }),
      (error) =>
        error instanceof TypeSafeError && error.code === "invalid_response",
      name,
    );
  }
});

test("retains the 2 second default deadline behavior and cancellation", async () => {
  const started = Date.now();
  await assert.rejects(
    evaluateTask({
      apiKey: "test-key",
      timeoutMs: 15,
      fetchImpl: () => new Promise(() => {}),
    }),
    (error) => error instanceof TypeSafeError && error.code === "timeout",
  );
  assert.ok(Date.now() - started < 500);

  const controller = new AbortController();
  const pending = evaluateTask({
    apiKey: "test-key",
    signal: controller.signal,
    fetchImpl: () => new Promise(() => {}),
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof TypeSafeError && error.code === "aborted",
  );
});

test("Choice category contract is validated and low confidence is unknown", async () => {
  const run = (task_kind) =>
    evaluateTask({
      apiKey: "test",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ answers: { ...validAnswers, task_kind } }),
      }),
    });
  for (const value of [
    undefined,
    { ...validAnswers.task_kind, choice: "invalid" },
    { ...validAnswers.task_kind, probabilities: { code: 1 } },
    { ...validAnswers.task_kind, confidence: NaN },
  ])
    await assert.rejects(
      run(value),
      (error) => error.code === "invalid_response",
    );
  const result = await run({ ...validAnswers.task_kind, confidence: 0.2 });
  assert.equal(result.taskKind, "unknown");
});


test("judgment instructions distinguish report scope from historical implementation", async () => {
  let body;
  await evaluateTask({ prompt: "What is the status?", context: { turnIntent: "status", historyTruncated: true }, apiKey: "test",
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ answers: validAnswers }) }; } });
  assert.match(body.questions.complexity.instructions, /execution continuation inherits/i);
  assert.match(body.questions.complexity.instructions, /status-only question/i);
  assert.match(body.questions.underspecified.instructions, /optional historical truncation/i);
  assert.match(body.questions.task_kind.instructions, /Quoted or negated/);
});
