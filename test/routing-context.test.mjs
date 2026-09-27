import test from "node:test";
import assert from "node:assert/strict";
import {
  boundPrompt,
  buildRoutingContext,
  routingTimeoutMs,
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
