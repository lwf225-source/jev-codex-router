import test from "node:test";
import assert from "node:assert/strict";
import {
  boundPrompt,
  buildRoutingContext,
  routingTimeoutMs,
  routingIntent,
} from "../src/routing-context.mjs";
import { validateRoutingPolicy } from "../src/routing-policy.mjs";
test("head and tail preserved in full prompt and prioritized structured budget", () => {
  const text = "START" + "x".repeat(15000) + "CRITICAL_END";
  const bound = boundPrompt(text);
  assert.equal(bound.length, 12000);
  assert.ok(bound.startsWith("START"));
  assert.ok(bound.endsWith("CRITICAL_END"));
  assert.match(bound, /TRUNCATED/);
  const context = buildRoutingContext({
    constraints: text,
    failureSummary: text,
    acceptanceCriteria: text,
    summary: text,
    lastResult: text,
    secret: "never send",
  });
  assert.ok(
    Object.values(context)
      .filter((x) => typeof x === "string")
      .reduce((n, x) => n + x.length, 0) <= 4500,
  );
  assert.match(context.constraints, /CRITICAL_END/);
  assert.match(context.failureSummary, /CRITICAL_END/);
  assert.equal(context.secret, undefined);
  assert.equal(context.contextComplete, false);
});
test("custom timeout works and residual deadline can be less than configured minimum", () => {
  assert.equal(routingTimeoutMs(), 2000);
  assert.equal(routingTimeoutMs(4500), 4500);
  assert.equal(routingTimeoutMs(4), 4);
  assert.equal(routingTimeoutMs(Infinity), 2000);
});
test("policy rejects malformed overrides", () => {
  assert.deepEqual(
    validateRoutingPolicy({
      tasks: { writing: ["sol"] },
      models: { "gpt-custom": { capability: 2 } },
    }),
    {
      tasks: { writing: ["sol"] },
      models: { "gpt-custom": { capability: 2 } },
    },
  );
  for (const value of [
    null,
    [],
    JSON.parse('{"models":{"__proto__":{"capability":3}}}'),
    { tasks: { code: ["constructor"] } },
    { evil: {} },
    { tiers: { light: [] } },
    { models: { x: { capability: 0 } } },
  ])
    assert.throws(() => validateRoutingPolicy(value));
});


test("status scope separates optional history from current missing requirements", () => {
  const input = { summary: "Historical implementation detail. ".repeat(500),
    lastResult: "Two tests passed; deployment remains pending.", constraints: "Report only observed completion." };
  const status = buildRoutingContext(input, { statusOnly: true });
  assert.equal(status.historyTruncated, true);
  assert.equal(status.currentContextComplete, true);
  assert.equal(status.contextComplete, true);
  assert.equal(status.turnIntent, "status");
  assert.ok(status.summary.length <= 900);
  assert.equal(buildRoutingContext(input).contextComplete, false);
  for (const patch of [
    { constraints: "critical ".repeat(500) },
    { acceptanceCriteria: "criterion ".repeat(500) },
    { contextComplete: false }, { currentContextComplete: false },
    { inputModalities: ["image"] }, { attachmentState: "unread" },
  ]) assert.equal(buildRoutingContext({ ...input, ...patch }, { statusOnly: true }).contextComplete, false);
  assert.equal(buildRoutingContext({}, { statusOnly: true }).contextComplete, false);
});

test("only complete unquoted status questions receive status scope", () => {
  for (const prompt of ["还有什么优化没做完？只汇报当前状态，不执行改动。", "还有什么优化没做完", "还有哪些任务未完成？", "目前进展怎么样？", "完成了吗", "What is the status?", "What remains unfinished?", "What's left to do?"])
    assert.equal(routingIntent(prompt), "status", prompt);
  for (const prompt of ["还有什么优化没做完，继续做", "先说进度，再部署", "不要只告诉我进度，继续执行", "不是问你还有什么没做完", "“还有什么优化没做完”", "Translate: What is the status?", "What is the status? Then deploy.", "Don't give me status, execute."])
    assert.notEqual(routingIntent(prompt), "status", prompt);
  for (const prompt of ["Continue", "Continue the remaining rollout after checking status", "继续处理剩下的工作", "按原计划执行"])
    assert.equal(routingIntent(prompt), "continuation", prompt);
});


test("truncated old history alone is not a complete status snapshot", () => {
  const summary = "Old project discussion. ".repeat(300);
  for (const context of [{ summary }, { summary, lastResult: "Long previous output. ".repeat(100) }]) {
    const result = buildRoutingContext(context, { statusOnly: true });
    assert.equal(result.statusEvidenceAvailable, false);
    assert.equal(result.currentContextComplete, true);
    assert.equal(result.contextComplete, false);
  }
  const short = buildRoutingContext({ summary: "Last observed result: tests passed; deployment pending." }, { statusOnly: true });
  assert.equal(short.statusEvidenceAvailable, true);
});
