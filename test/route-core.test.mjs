import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRoute, chooseSubtaskRoute, detectExplicitOverride } from '../src/route-core.mjs';

const models = [
  { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'Astra', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
  { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'Luna', supportedReasoningEfforts: ['low', 'medium'] },
];

const jev = ({ score = 0.1, confidence = 0.95, risk = 0.1, ambiguous = 0.1, staged = false, secondOpinion = false } = {}) => async (url, options) => {
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  const request = JSON.parse(options.body);
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.questions.complexity.type, 'score');
  assert.equal(request.questions.high_consequence.type, 'noul');
  assert.equal(request.questions.underspecified.type, 'noul');
  assert.equal(request.questions.staged_execution.type, 'noul');
  assert.equal(request.questions.second_opinion.type, 'noul');
  return { ok: true, json: async () => ({ answers: {
    complexity: { type: 'score', score, confidence },
    high_consequence: { type: 'noul', noul: risk },
    underspecified: { type: 'noul', noul: ambiguous },
    staged_execution: { type: 'noul', noul: staged ? 0.9 : 0.1 },
    second_opinion: { type: 'noul', noul: secondOpinion ? 0.9 : 0.1 },
  } }) };
};

test('routine task uses a lighter available model; deep task escalates', async () => {
  const simple = await chooseRoute({ prompt: 'Rename a variable', models, apiKey: 'test', fetchImpl: jev() });
  assert.deepEqual([simple.model, simple.effort, simple.source], ['gpt-6-luna', 'low', 'jev']);
  assert.equal(simple.confidence, 0.95);
  assert.ok(simple.elapsedMs >= 0);
  const deep = await chooseRoute({ prompt: 'Diagnose and redesign the architecture', models, apiKey: 'test', fetchImpl: jev({ score: 2.8, staged: true }) });
  assert.deepEqual([deep.model, deep.effort], ['gpt-6-astra', 'xhigh']);
  assert.equal(deep.phase, 'plan_execute');
  assert.equal(deep.needsSecondOpinion, false);
});

test('consequence and uncertainty move a borderline task to stronger route', async () => {
  const highRisk = await chooseRoute({ prompt: 'Audit transaction handling', models, apiKey: 'test', fetchImpl: jev({ score: 1.7, risk: 0.9 }) });
  assert.equal(highRisk.model, 'gpt-6-astra');
  const uncertain = await chooseRoute({ prompt: 'Continue', context: { summary: 'Resolve multi-module defect' }, models, apiKey: 'test', fetchImpl: jev({ score: 1.8, confidence: 0.4 }) });
  assert.equal(uncertain.model, 'gpt-6-astra');
});

test('missing file details do not make a tiny reversible edit consume a stronger model', async () => {
  const simple = await chooseRoute({ prompt: 'Change the button color', models, apiKey: 'test', fetchImpl: jev({ score: 0.08, confidence: 0.94, ambiguous: 0.88 }) });
  assert.deepEqual([simple.model, simple.effort], ['gpt-6-luna', 'low']);
  const borderline = await chooseRoute({ prompt: 'Compare two indexes', models, apiKey: 'test', fetchImpl: jev({ score: 1.8, confidence: 0.8, ambiguous: 0.9 }) });
  assert.deepEqual([borderline.model, borderline.effort], ['gpt-6-sol', 'medium']);
});

test('explicit instruction takes priority and never requests a missing effort', async () => {
  const result = await chooseRoute({ prompt: '这次用 Luna，推理拉高，修复这个 bug', models, apiKey: 'test', fetchImpl: () => { throw new Error('must not call Jev'); } });
  assert.deepEqual([result.model, result.effort, result.source], ['gpt-6-luna', 'medium', 'explicit']);
  assert.equal(result.confidence, 1);
});

test('manual model persists through settings; explicit prompt overrides it once', async () => {
  const settings = { manualModel: 'gpt-6-sol', manualEffort: 'high' };
  const manual = await chooseRoute({ prompt: 'Continue', models, settings });
  assert.deepEqual([manual.model, manual.effort, manual.source], ['gpt-6-sol', 'high', 'manual']);
  const override = await chooseRoute({ prompt: '请用 Astra', models, settings });
  assert.deepEqual([override.model, override.source], ['gpt-6-astra', 'explicit']);
});

test('TypeSafe failure and timeout return catalog-backed fallback', async () => {
  const unavailable = await chooseRoute({ prompt: 'Test', models, apiKey: 'test', fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual([unavailable.model, unavailable.effort, unavailable.source], ['gpt-6-sol', 'medium', 'fallback']);
  const timeout = await chooseRoute({ prompt: 'Test', models, apiKey: 'test', settings: { timeoutMs: 10 }, fetchImpl: () => new Promise(() => {}) });
  assert.deepEqual([timeout.model, timeout.effort, timeout.source], ['gpt-6-sol', 'medium', 'fallback']);
  assert.match(timeout.reason, /超时/);
});

test('only non-hidden catalog models and supported efforts can be returned', async () => {
  const sparse = { data: [
    { id: 'gpt-6-astra', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] },
    { id: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  ] };
  const result = await chooseRoute({ prompt: 'hard problem', models: sparse, apiKey: 'test', fetchImpl: jev({ score: 3 }) });
  assert.deepEqual([result.model, result.effort], ['gpt-6-sol', 'low']);
  const fallback = await chooseRoute({ prompt: 'test', models: sparse, settings: { fallbackModel: 'missing', fallbackEffort: 'ultra' } });
  assert.deepEqual([fallback.model, fallback.effort], ['gpt-6-sol', 'low']);
  await assert.rejects(() => chooseRoute({ prompt: 'test', models: [] }), /No available/);
});

test('context passed to Jev is bounded', async () => {
  let state;
  await chooseRoute({ prompt: 'Continue', context: { summary: 'a'.repeat(9999), progress: 'b'.repeat(9999), lastResult: 'c'.repeat(9999), secret: 'excluded' }, models, apiKey: 'test', fetchImpl: async (_, options) => {
    state = JSON.parse(options.body).state;
    return jev()(_, options);
  } });
  assert.equal(state.context.summary.length, 2500);
  assert.equal(state.context.progress.length, 1000);
  assert.equal(state.context.lastResult.length, 1000);
  assert.equal(state.context.secret, undefined);
});

test('a cancelled request returns quickly even when fetch ignores AbortSignal', async () => {
  const controller = new AbortController();
  const pending = chooseRoute({ prompt: 'test', models, apiKey: 'test', signal: controller.signal, fetchImpl: () => new Promise(() => {}) });
  controller.abort();
  const result = await pending;
  assert.equal(result.source, 'fallback');
  assert.ok(result.elapsedMs < 100);
});

test('colloquial one-turn model instruction is honored', async () => {
  const result = await chooseRoute({ prompt: '先分析，再用 astra，推理拉高', models });
  assert.deepEqual([result.model, result.effort, result.source], ['gpt-6-astra', 'high', 'explicit']);
  assert.deepEqual(detectExplicitOverride('这次用 Astra，推理拉高', models), { model: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual(detectExplicitOverride('请用 Astra 把按钮改成蓝色并替换文字', models), { model: 'gpt-6-astra' });
  assert.equal(detectExplicitOverride('请比较 Astra 和 Sol', models), null);
});

test('negated and quoted model names do not override a positive instruction', async () => {
  const prompt = '不要使用 Luna，请用 Astra 完成复杂审计。此前的说法“请用 Sol”只是引用。';
  assert.deepEqual(detectExplicitOverride(prompt, models), { model: 'gpt-6-astra' });
  const result = await chooseRoute({ prompt, models, fetchImpl: () => { throw new Error('must not call Jev'); } });
  assert.deepEqual([result.model, result.source], ['gpt-6-astra', 'explicit']);
  assert.equal(detectExplicitOverride('不要用 Luna。文档写着“请用 Sol”。', models), null);
  assert.equal(detectExplicitOverride('> 请用 Luna\n请用 Sol', models)?.model, 'gpt-6-sol');
  assert.equal(detectExplicitOverride('Do not use Luna; use Astra', models)?.model, 'gpt-6-astra');
  assert.equal(detectExplicitOverride('先用 Sol；最终请用 Astra', models)?.model, 'gpt-6-astra');
});

test('negation scope survives intervening words and combines with a positive directive', async () => {
  const negativeClauses = [
    '不要再使用 Luna', '无需使用 Luna', '无须继续选择 Luna', '不需要重新切换到 Luna',
    '请不要在仍未完成验收且当前工作尚未提交审查的情况下继续使用 Luna',
    '不要使用 Luna，或者选择 Sol', 'do not under any circumstances use Luna',
    "don't ever choose Luna", 'never again switch to Luna',
  ];
  for (const negative of negativeClauses) {
    assert.equal(detectExplicitOverride(negative, models), null, negative);
    for (const prompt of [`请用 Astra，${negative}`, `${negative}；请用 Astra`]) {
      assert.deepEqual(detectExplicitOverride(prompt, models), { model: 'gpt-6-astra' }, prompt);
      const result = await chooseRoute({ prompt, models, settings: { manualModel: 'gpt-6-sol' } });
      assert.deepEqual([result.model, result.source], ['gpt-6-astra', 'explicit'], prompt);
    }
  }
  assert.deepEqual(detectExplicitOverride('请用 Astra，推理拉高；无需再把推理强度调到 low', models), { model: 'gpt-6-astra', effort: 'high' });
});

test('quoted reports, examples, and ambiguous questions never force a model or effort', () => {
  const ambiguous = [
    "'请用 Luna，推理拉高'", '‘请用 Luna，推理拉高’', '“请用 Luna\n推理拉高”',
    '文档写着：请用 Luna，推理拉高', '示例：使用 Luna，推理拉高',
    'The document says: use Luna, reasoning effort: high', '此前用户说请用 Luna',
    '如果使用 Luna，结果会怎样', 'Should we use Luna?', '请用 Luna 或 Sol',
    'use Luna or choose Sol', '请把使用 Luna 改成使用 Sol',
    '“请用 Luna', '```\n请用 Luna',
  ];
  for (const prompt of ambiguous) {
    assert.equal(detectExplicitOverride(prompt, models), null, prompt);
    assert.deepEqual(detectExplicitOverride(`请用 Astra。${prompt}`, models), { model: 'gpt-6-astra' }, prompt);
  }
});

test('image input routes only through a model that supports images', async () => {
  const catalog = [
    { ...models[0], inputModalities: ['text'] },
    { ...models[1], inputModalities: ['text', 'image'] },
    { ...models[2], inputModalities: ['text'] },
  ];
  const route = await chooseRoute({ prompt: 'Explain this image', context: { inputModalities: ['text', 'image'] }, models: catalog, apiKey: 'test', fetchImpl: jev({ score: 3 }) });
  assert.equal(route.model, 'gpt-6-sol');
  assert.equal(detectExplicitOverride('这次用 Astra', catalog, { inputModalities: ['text', 'image'] }), null);
  assert.equal(detectExplicitOverride('这次用 Sol', catalog, { inputModalities: ['text', 'image'] })?.model, 'gpt-6-sol');
});

test('Jev marks high impact staged plans for a second strong-model review', async () => {
  const route = await chooseRoute({ prompt: 'Plan a production database migration', models, apiKey: 'test', fetchImpl: jev({ score: 1.8, risk: 0.9, staged: true }) });
  assert.deepEqual([route.phase, route.needsSecondOpinion, route.model, route.effort], ['plan_execute', true, 'gpt-6-astra', 'xhigh']);
  assert.deepEqual([route.verifierModel, route.verifierEffort], ['gpt-6-sol', 'high']);
});

test('an already-planned subtask uses the lowest adequate model tier', async () => {
  const task = 'Rename a local variable';
  let observed;
  const light = await chooseSubtaskRoute({ task, acceptanceCriteria: 'Tests pass', dependencies: 'None', context: { summary: 'The approved plan has three steps' }, models, apiKey: 'test', fetchImpl: async (url, options) => {
    observed = JSON.parse(options.body).state;
    return jev({ score: 0.1 })(url, options);
  } });
  assert.deepEqual([light.phase, light.model, light.effort], ['execution', 'gpt-6-luna', 'low']);
  assert.match(observed.prompt, /Tests pass/);
  assert.match(observed.context.summary, /None/);

  const normal = await chooseSubtaskRoute({ task: 'Implement a component and update its tests', models, apiKey: 'test', fetchImpl: jev({ score: 1.6 }) });
  assert.deepEqual([normal.model, normal.effort], ['gpt-6-sol', 'medium']);
  const hard = await chooseSubtaskRoute({ task: 'Implement a novel compiler optimization', models, apiKey: 'test', fetchImpl: jev({ score: 2.8 }) });
  assert.deepEqual([hard.model, hard.effort], ['gpt-6-astra', 'high']);
});

test('subtask route preserves manual model mode and uses fallback on Jev failure', async () => {
  const manual = await chooseSubtaskRoute({ task: 'Do planned work', models, settings: { mode: 'manual', manualModel: 'gpt-6-astra', manualEffort: 'high' } });
  assert.deepEqual([manual.source, manual.model, manual.effort], ['manual', 'gpt-6-astra', 'high']);
  const failed = await chooseSubtaskRoute({ task: 'Do planned work', models, apiKey: 'test', fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual([failed.source, failed.model, failed.effort], ['fallback', 'gpt-6-sol', 'medium']);
});

test('Jev failure on a child retry keeps the previous capability floor', async () => {
  const retry = await chooseSubtaskRoute({ task: 'Repair failed migration', previousModel: 'gpt-6-astra', previousEffort: 'high', failureSummary: 'Previous attempt failed a required invariant', models, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual([retry.model, retry.effort, retry.source, retry.escalated], ['gpt-6-astra', 'xhigh', 'fallback', true]);
  const ceiling = await chooseSubtaskRoute({ task: 'Repair failed migration', previousModel: 'gpt-6-astra', previousEffort: 'xhigh', failureSummary: 'Still failing', models, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual([ceiling.model, ceiling.effort, ceiling.escalated], ['gpt-6-astra', 'xhigh', false]);
});

test('a missing previous model uses the current ceiling without claiming an upgrade', async () => {
  const cases = [
    { catalog: models.slice(1), previousModel: 'gpt-6-astra', previousEffort: 'xhigh', model: 'gpt-6-sol', effort: 'high' },
    { catalog: models.slice(1), previousModel: 'gpt-6-astra', previousEffort: 'low', model: 'gpt-6-sol', effort: 'high' },
    { catalog: [{ ...models[0], supportedReasoningEfforts: ['low', 'medium'] }, ...models.slice(1)], previousModel: 'gpt-6-astra', previousEffort: 'xhigh', model: 'gpt-6-astra', effort: 'medium' },
    { catalog: [{ ...models[0], id: 'gpt-5.6-astra', model: 'gpt-5.6-astra' }, ...models.slice(1)], previousModel: 'gpt-6-astra', previousEffort: 'low', model: 'gpt-5.6-astra', effort: 'xhigh' },
  ];
  for (const entry of cases) {
    for (const source of ['fallback', 'jev']) {
      const route = await chooseSubtaskRoute({
        task: 'Repair an incomplete execution unit', models: entry.catalog,
        previousModel: entry.previousModel, previousEffort: entry.previousEffort, failureSummary: 'Required invariant failed',
        settings: { fallbackModel: 'gpt-6-luna', fallbackEffort: 'low' }, apiKey: 'test',
        fetchImpl: source === 'jev' ? jev({ score: 0.1 }) : async () => { throw new Error('offline'); },
      });
      assert.deepEqual([route.model, route.effort, route.source, route.escalated], [entry.model, entry.effort, source, false]);
      assert.match(route.reason, /无法升级/);
      assert.match(route.reason, /重新规划/);
    }
  }
});

test('catalog changes still permit a real model upgrade from the previous configuration', async () => {
  for (const source of ['fallback', 'jev']) {
    const route = await chooseSubtaskRoute({
      task: 'Repair an incomplete execution unit', models: models.slice(0, 2),
      previousModel: 'gpt-6-luna', previousEffort: 'medium', failureSummary: 'Required invariant failed',
      settings: { fallbackModel: 'gpt-6-sol', fallbackEffort: 'low' }, apiKey: 'test',
      fetchImpl: source === 'jev' ? jev({ score: 0.1 }) : async () => { throw new Error('offline'); },
    });
    assert.deepEqual([route.model, route.effort, route.source, route.escalated], ['gpt-6-sol', 'high', source, true]);
  }
});

test('long plan and prior result retain current dependencies and failure evidence', async () => {
  let context;
  await chooseSubtaskRoute({
    task: 'Execute the next planned unit', acceptanceCriteria: 'Required acceptance',
    dependencies: 'MUST_WAIT_FOR_APPROVED_SCHEMA', failureSummary: 'PREVIOUS_ATTEMPT_CORRUPTED_INDEX',
    context: { summary: 'p'.repeat(3000), lastResult: 'r'.repeat(1500) },
    models, apiKey: 'test', fetchImpl: async (url, options) => {
      context = JSON.parse(options.body).state.context;
      return jev()(url, options);
    },
  });
  assert.ok(context.summary.length <= 2500);
  assert.ok(context.lastResult.length <= 1000);
  assert.match(context.summary, /MUST_WAIT_FOR_APPROVED_SCHEMA/);
  assert.match(context.lastResult, /PREVIOUS_ATTEMPT_CORRUPTED_INDEX/);
});

test('failure evidence uses the full budget and takes priority over older results', async () => {
  const marker = 'ACTUAL_FAILURE: required invariant was lost!';
  for (const lastResult of ['', 'old'.repeat(500)]) {
    for (const length of [650, 1000, 1100]) {
      const failureSummary = 'r'.repeat(length - marker.length) + marker;
      let observed;
      await chooseSubtaskRoute({
        task: 'Repair the failed unit', failureSummary, context: { lastResult }, models, apiKey: 'test',
        fetchImpl: async (url, options) => {
          observed = JSON.parse(options.body).state.context.lastResult;
          return jev()(url, options);
        },
      });
      const expectedFailure = failureSummary.slice(0, 1000);
      assert.ok(observed.length <= 1000);
      assert.ok(observed.endsWith(expectedFailure));
      if (!lastResult || failureSummary.length >= 1000) assert.equal(observed, expectedFailure);
    }
  }
});

test('a failed child attempt escalates model and effort, then stops at the available ceiling', async () => {
  const newlyHighRisk = await chooseSubtaskRoute({ task: 'Repair a high-impact migration', previousModel: 'gpt-6-luna', previousEffort: 'low', failureSummary: 'Data integrity risk found', models, apiKey: 'test', fetchImpl: jev({ score: 2.8, risk: 0.9 }) });
  assert.equal(newlyHighRisk.model, 'gpt-6-astra', 'retry upgrade must not downgrade Jev’s new strong recommendation');
  const firstRetry = await chooseSubtaskRoute({ task: 'Implement one bounded unit', previousModel: 'gpt-6-luna', previousEffort: 'low', failureSummary: 'The first attempt missed a required interface', models, apiKey: 'test', fetchImpl: jev({ score: 0.2 }) });
  assert.deepEqual([firstRetry.model, firstRetry.effort, firstRetry.escalated], ['gpt-6-sol', 'medium', true]);
  const secondRetry = await chooseSubtaskRoute({ task: 'Implement one bounded unit', previousModel: 'gpt-6-sol', previousEffort: 'medium', failureSummary: 'The implementation still fails the contract', models, apiKey: 'test', fetchImpl: jev({ score: 0.2 }) });
  assert.deepEqual([secondRetry.model, secondRetry.effort, secondRetry.escalated], ['gpt-6-astra', 'high', true]);
  const ceiling = await chooseSubtaskRoute({ task: 'Implement one bounded unit', previousModel: 'gpt-6-astra', previousEffort: 'xhigh', failureSummary: 'The highest route still failed', models, apiKey: 'test', fetchImpl: jev({ score: 0.2 }) });
  assert.deepEqual([ceiling.model, ceiling.effort, ceiling.escalated], ['gpt-6-astra', 'xhigh', false]);
});
