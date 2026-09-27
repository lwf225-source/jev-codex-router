import { evaluateTask } from './typesafe-client.mjs';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_TIMEOUT = 2000;

/** Detect a one-turn instruction using the same catalog checks as chooseRoute. */
export function detectExplicitOverride(prompt, models = [], context = {}) {
  const found = parseExplicitRequest(prompt, normalizeCatalog(models, context.inputModalities));
  return found.model || found.effort ? { model: found.model?.value ?? null, ...(found.effort ? { effort: found.effort } : {}) } : null;
}

/** Choose only from the provided current-account Codex model/list catalog. */
export async function chooseRoute({ prompt, context = {}, models = [], settings = {}, apiKey, signal, fetchImpl } = {}) {
  const started = performance.now();
  const catalog = normalizeCatalog(models, context.inputModalities);
  if (!catalog.length) throw new Error('No available Codex models support the required input modalities and reasoning efforts');
  const finish = (model, effort, reason, source, confidence = null, extra = {}) => ({
    model: model.value,
    effort,
    reason,
    source,
    confidence,
    ...extra,
    elapsedMs: Math.round(performance.now() - started),
  });
  const explicit = parseExplicitRequest(prompt, catalog);
  const manualModel = findModel(catalog, settings.manualModel);
  if (explicit.model || explicit.effort) {
    const model = explicit.model || manualModel || findModel(catalog, settings.fallbackModel) || preferred(catalog, 'balanced');
    const effort = resolveEffort(model, explicit.effort || settings.manualEffort || settings.fallbackEffort || 'medium');
    return finish(model, effort, `本轮明确指定${explicit.model ? '模型' : '推理强度'}；按当前模型目录选择可用配置`, 'explicit', 1, { phase: 'direct', needsSecondOpinion: false });
  }
  if (manualModel) {
    const effort = resolveEffort(manualModel, settings.manualEffort || settings.fallbackEffort || 'medium');
    return finish(manualModel, effort, '持续手动选择的模型', 'manual', 1, { phase: 'direct', needsSecondOpinion: false });
  }
  const fallback = (cause) => {
    const model = findModel(catalog, settings.fallbackModel) || preferred(catalog, 'balanced');
    const effort = resolveEffort(model, settings.fallbackEffort || 'medium');
    return finish(model, effort, `Jev ${cause}，使用备用配置`, 'fallback', null, { phase: 'direct', needsSecondOpinion: false });
  };
  if (signal?.aborted) return fallback('请求已取消');
  const timeoutMs = Math.min(Math.max(Number(settings.timeoutMs) || DEFAULT_TIMEOUT, 1), DEFAULT_TIMEOUT);
  let judgment;
  try {
    judgment = await evaluateTask({ prompt: String(prompt ?? '').slice(0, 12000), context: boundedContext(context), apiKey, signal, timeoutMs, fetchImpl });
  } catch (error) {
    return fallback(error?.code === 'timeout' ? '超时' : error?.code === 'missing_key' ? '未配置' : error?.code === 'aborted' ? '请求已取消' : '不可用');
  }
  const highRisk = judgment.highConsequence >= 0.65;
  const uncertainJudgment = judgment.confidence < 0.55;
  const missingDetail = judgment.underspecified >= 0.65;
  const ambiguous = uncertainJudgment || missingDetail;
  const complex = judgment.complexity >= 2.35 || (judgment.complexity >= 1.65 && (highRisk || uncertainJudgment || (missingDetail && judgment.complexity >= 2.1)));
  const staged = judgment.staged === true;
  const needsSecondOpinion = staged && (judgment.needsSecondOpinion === true || highRisk);
  const tier = complex || highRisk || staged ? 'strong' : judgment.complexity >= 0.85 || (ambiguous && judgment.complexity >= 0.35) ? 'balanced' : 'light';
  const model = preferred(catalog, tier);
  const desiredEffort = tier === 'strong' ? (judgment.complexity >= 2.35 || staged ? 'xhigh' : 'high') : tier === 'balanced' ? 'medium' : 'low';
  const effort = resolveEffort(model, desiredEffort);
  const rationale = highRisk ? '后果较大' : complex ? '任务需要多步深入推理' : tier === 'light' ? '任务范围很小，按轻量配置处理' : ambiguous ? '需求信息或判断把握不足' : '任务需要常规多步处理';
  const verifier = needsSecondOpinion ? alternateStrong(catalog, model) : null;
  return finish(model, effort, `Jev 判断：${staged ? '任务适合先规划再交给子代理执行；' : ''}${rationale}；复杂度 ${judgment.complexity.toFixed(2)}/3`, 'jev', judgment.confidence, {
    phase: staged ? 'plan_execute' : 'direct',
    needsSecondOpinion,
    ...(verifier ? { verifierModel: verifier.value, verifierEffort: resolveEffort(verifier, 'high') } : {}),
  });
}

/** Select a cost-conscious route for one concrete, already-planned execution unit. */
export async function chooseSubtaskRoute({ task, acceptanceCriteria = '', dependencies = '', previousModel, previousEffort, failureSummary = '', context = {}, models = [], settings = {}, apiKey, signal, fetchImpl } = {}) {
  const started = performance.now();
  const catalog = normalizeCatalog(models, context.inputModalities);
  if (!catalog.length) throw new Error('No available Codex models support the required input modalities and reasoning efforts');
  const manual = findModel(catalog, settings.manualModel);
  const failedPreviousAttempt = Boolean(failureSummary && previousModel && previousEffort);
  const fallback = (cause) => {
    let model = findModel(catalog, settings.fallbackModel) || preferred(catalog, 'balanced');
    let effort = resolveEffort(model, settings.fallbackEffort || 'medium');
    let escalated = false;
    if (failedPreviousAttempt) {
      const upgrade = upgradeAfterFailure(catalog, model, effort, previousModel, previousEffort);
      ({ model, effort, escalated } = upgrade);
    }
    return { model: model.value, effort, phase: 'execution', source: 'fallback', confidence: null,
      ...(failedPreviousAttempt ? { escalated } : {}),
      reason: `Jev ${cause}，${failedPreviousAttempt ? escalated ? '按上次失败提升配置重试' : '当前目录无法升级到高于上次的配置，已选择当前最高可用配置；需要重新规划' : '子任务使用备用配置'}`,
      elapsedMs: Math.round(performance.now() - started) };
  };
  if (settings.mode === 'manual' && manual) return { model: manual.value, effort: resolveEffort(manual, settings.manualEffort || 'medium'), phase: 'execution', source: 'manual', confidence: 1,
    reason: '沿用当前任务的手动模型配置', elapsedMs: Math.round(performance.now() - started) };
  const boundedTask = String(task ?? '').slice(0, 8000);
  if (!boundedTask.trim()) throw new TypeError('task must be a non-empty string');
  let judgment;
  try {
    judgment = await evaluateTask({
      prompt: `已规划的执行子任务：\n${boundedTask}\n验收标准：\n${String(acceptanceCriteria ?? '').slice(0, 2000)}`,
      context: boundedContext({
        summary: combineContext(context.summary, dependencies, 2500, 1200),
        progress: context.progress,
        lastResult: combineContext(context.lastResult, failureSummary, 1000),
        inputModalities: context.inputModalities,
      }),
      apiKey, signal,
      timeoutMs: Math.min(Math.max(Number(settings.timeoutMs) || DEFAULT_TIMEOUT, 1), DEFAULT_TIMEOUT),
      fetchImpl,
    });
  } catch (error) {
    return fallback(error?.code === 'timeout' ? '超时' : error?.code === 'missing_key' ? '未配置' : error?.code === 'aborted' ? '请求已取消' : '不可用');
  }
  const highRisk = judgment.highConsequence >= 0.65;
  const uncertain = judgment.confidence < 0.55 || judgment.underspecified >= 0.65;
  let tier = highRisk || judgment.complexity >= 2.65 ? 'strong' : judgment.complexity >= 0.8 || uncertain ? 'balanced' : 'light';
  if (failedPreviousAttempt) tier = tierByRank(Math.max(tierRank(tier), Math.min(3, modelCapabilityRank(previousModel) + 1)));
  let model = preferred(catalog, tier);
  let desiredEffort = tier === 'strong' ? (judgment.complexity >= 2.65 ? 'high' : 'medium') : tier === 'balanced' ? 'medium' : 'low';
  let effort = resolveEffort(model, desiredEffort);
  let escalated = false;
  if (failedPreviousAttempt) {
    const upgrade = upgradeAfterFailure(catalog, model, effort, previousModel, previousEffort);
    model = upgrade.model;
    effort = upgrade.effort;
    escalated = upgrade.escalated;
  }
  const rationale = failedPreviousAttempt
    ? escalated ? '上次执行未完成，提升模型或思考等级重试' : '当前目录无法升级到高于上次的配置，已选择当前最高可用配置；需要重新规划'
    : highRisk ? '子任务后果较大' : uncertain ? '子任务仍有关键不确定性' : tier === 'strong' ? '子任务实现难度较高' : tier === 'balanced' ? '满足常规实现质量的均衡配置' : '子任务简单明确，采用轻量配置';
  return { model: model.value, effort, phase: 'execution', source: 'jev', confidence: judgment.confidence,
    ...(failedPreviousAttempt ? { escalated } : {}),
    reason: `Jev 按已规划子任务选型：${rationale}`, elapsedMs: Math.round(performance.now() - started) };
}

function tierRank(tier) { return tier === 'strong' ? 3 : tier === 'balanced' ? 2 : 1; }
function tierByRank(rank) { return rank >= 3 ? 'strong' : rank === 2 ? 'balanced' : 'light'; }

function modelCapabilityRank(value) {
  const family = familyOf(String(value || ''));
  return family === 'astra' ? 3 : family === 'sol' || family === 'terra' ? 2 : 1;
}

function upgradeAfterFailure(catalog, currentModel, currentEffort, previousModel, previousEffort) {
  const previousModelEntry = findModel(catalog, previousModel);
  const previousValue = previousModelEntry?.value || previousModel;
  const previousRank = modelCapabilityRank(previousValue);
  const desiredModelRank = Math.max(modelCapabilityRank(currentModel.value), Math.min(3, previousRank + 1));
  const alternatives = catalog
    .filter((entry) => modelCapabilityRank(entry.value) >= desiredModelRank)
    .sort((a, b) => modelCapabilityRank(a.value) - modelCapabilityRank(b.value) || versionRank(b.value) - versionRank(a.value));
  const strongestAvailable = [...catalog].sort((a, b) => compareModelCapability(b.value, a.value))[0];
  const model = modelCapabilityRank(currentModel.value) >= desiredModelRank && compareModelCapability(currentModel.value, previousValue) >= 0
    ? currentModel : alternatives[0] || strongestAvailable;
  // The previous configuration remains the baseline even after its model or
  // effort disappears from the current catalog.
  const baselineRank = EFFORTS.indexOf(previousEffort);
  const highestEffort = [...model.efforts].sort((a, b) => EFFORTS.indexOf(b) - EFFORTS.indexOf(a))[0];
  const modelChange = compareModelCapability(model.value, previousValue);
  if (modelChange < 0) return { model, effort: highestEffort, escalated: false };
  const targetEffortRank = Math.max(EFFORTS.indexOf(currentEffort), baselineRank + 1);
  const strongerEffort = baselineRank < 0 ? null : model.efforts
    .filter((value) => EFFORTS.indexOf(value) >= targetEffortRank)
    .sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
  const effort = strongerEffort || highestEffort;
  return { model, effort, escalated: modelChange > 0 || (baselineRank >= 0 && EFFORTS.indexOf(effort) > baselineRank) };
}

function compareModelCapability(current, previous) {
  return modelCapabilityRank(current) - modelCapabilityRank(previous) || versionRank(current) - versionRank(previous);
}

function alternateStrong(catalog, primary) {
  const sameFamily = familyOf(primary.value);
  for (const family of ['astra', 'sol']) {
    if (family === sameFamily) continue;
    const model = preferredFamily(catalog, family);
    if (model) return model;
  }
  return null;
}

function familyOf(value) {
  return ['astra', 'sol', 'terra', 'luna'].find((family) => new RegExp(`(?:^|[-\\s])${family}(?:$|[-\\s])`, 'i').test(value)) || null;
}

function normalizeCatalog(input, inputModalities = ['text']) {
  const entries = Array.isArray(input) ? input : Array.isArray(input?.data) ? input.data : [];
  const required = Array.isArray(inputModalities) ? inputModalities.map((m) => m === 'localImage' ? 'image' : m) : ['text'];
  const seen = new Set();
  return entries.flatMap((item) => {
    if (!item || item.hidden === true) return [];
    const supportedModalities = Array.isArray(item.inputModalities) ? item.inputModalities : ['text', 'image'];
    if (!required.every((modality) => supportedModalities.includes(modality))) return [];
    const value = typeof item.model === 'string' && item.model ? item.model : item.id;
    if (typeof value !== 'string' || !value || seen.has(value)) return [];
    const supported = (item.supportedReasoningEfforts || []).map((e) => typeof e === 'string' ? e : e?.reasoningEffort).filter((e) => EFFORTS.includes(e));
    if (!supported.length) return [];
    seen.add(value);
    return [{ value, id: item.id || value, name: item.displayName || value, efforts: supported, defaultEffort: item.defaultReasoningEffort, isDefault: item.isDefault === true }];
  });
}

function findModel(catalog, requested) {
  if (!requested || typeof requested !== 'string') return null;
  const needle = requested.toLowerCase().trim();
  return catalog.find((m) => [m.value, m.id, m.name].some((v) => v.toLowerCase() === needle)) ||
    (['astra', 'sol', 'luna'].includes(needle) ? preferredFamily(catalog, needle) : null);
}

function preferredFamily(catalog, family) {
  const matching = catalog.filter((m) => new RegExp(`(?:^|[-\\s])${family}(?:$|[-\\s])`, 'i').test(`${m.value} ${m.name}`));
  return matching.sort((a, b) => versionRank(b.value) - versionRank(a.value))[0] || null;
}

function versionRank(value) {
  const match = value.match(/(?:gpt[- ])?(\d+)(?:\.(\d+))?/i);
  return match ? Number(match[1]) * 100 + Number(match[2] || 0) : 0;
}

function preferred(catalog, tier) {
  const families = tier === 'strong' ? ['astra', 'sol', 'luna'] : tier === 'light' ? ['luna', 'sol', 'astra'] : ['sol', 'astra', 'luna'];
  for (const family of families) {
    const model = preferredFamily(catalog, family);
    if (model) return model;
  }
  return catalog.find((m) => m.isDefault) || catalog[0];
}

function resolveEffort(model, desired) {
  if (model.efforts.includes(desired)) return desired;
  const target = EFFORTS.indexOf(desired);
  if (target < 0) return model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0];
  return [...model.efforts].sort((a, b) => Math.abs(EFFORTS.indexOf(a) - target) - Math.abs(EFFORTS.indexOf(b) - target) || EFFORTS.indexOf(b) - EFFORTS.indexOf(a))[0];
}

function parseExplicitRequest(prompt, catalog) {
  const text = String(prompt ?? '').slice(0, 12000)
    .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|‘[^’]*(?:’|$)|"(?:\\.|[^"\\])*(?:"|$)|(?<![\p{L}\p{N}])'(?:\\.|[^'\\])*(?:'|$)/gu, (quoted) => quoted.replace(/[^\n]/gu, ' '))
    .split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
  const modelDirectives = /(?:这(?:一|次|轮)(?:请)?(?:用|使用|选|切到)|请(?:用|使用|选择|切到)|(?:使用|选择|切换到|模型设为)|(?:^|[，,;；\s])(?:再|就|并)?用|(?:^|[\s,;])(?:use|choose|switch to|model\s*[:=])\s*)\s*([\w.-]+|阿斯特拉|月亮|太阳)/giu;
  const aliases = { 阿斯特拉: 'astra', 月亮: 'luna', 太阳: 'sol' };
  let model = null;
  for (const match of text.matchAll(modelDirectives)) {
    if (isUncertainDirective(text, match.index, match.index + match[0].length)) continue;
    const named = match[1].toLowerCase();
    const found = findModel(catalog, aliases[named] || named);
    if (found) model = found;
  }
  const effortDirectives = /(?:推理(?:强度|档位)?\s*(?:设为|调到|用|拉到|拉)|reasoning(?: effort)?\s*[:=])\s*(none|minimal|low|medium|high|xhigh|max|ultra|最低|低|中|高|最高)/giu;
  let effort = null;
  for (const match of text.matchAll(effortDirectives)) {
    if (isUncertainDirective(text, match.index, match.index + match[0].length)) continue;
    effort = ({ 最低: 'minimal', 低: 'low', 中: 'medium', 高: 'high', 最高: 'max' })[match[1]] || match[1].toLowerCase();
  }
  return { model, effort };
}

function isUncertainDirective(text, start, end) {
  const sentencePrefix = text.slice(0, start).split(/[。.!！?？;；\n]/u).at(-1);
  const clauses = sentencePrefix.split(/[，,]/u);
  const prefix = clauses.at(-1).trim();
  const suffix = text.slice(end).split(/[，,。.!！;；\n]/u)[0].trim();
  // A directive inside a negation, quotation report, example, condition, or
  // question is not an unambiguous request to change the running model.
  // Keep the complete clause so intervening adverbs cannot hide its scope.
  const negative = /(?:不|无需|无须|禁止|避免|别|勿)|\b(?:never|not|no\s+need|without|avoid|don't|do\s+not|cannot|can't|shouldn't|wouldn't|mustn't)\b/iu;
  if (negative.test(prefix)) return true;
  if (/^(?:也|还|或者|或|以及|并且|and\b|or\b|nor\b|also\b)/iu.test(prefix) && negative.test(clauses.slice(0, -1).join(','))) return true;
  if (/[把将]\s*$/u.test(prefix) && /^(?:改成|改为|替换)/u.test(suffix)) return true;
  if (/(?:例如|比如|举例|引用|原文|文档|示例|日志|此前|之前|上次|刚才|(?:他|她|用户|客户|别人)(?:说|要求)|写着|提到|说过|字符串|提示词|这句话)|\b(?:example|quote|quoted|said|says|wrote|previously|earlier|document|documentation)\b/iu.test(sentencePrefix)) return true;
  if (/(?:如果|假如|假设|是否|能否|要不要|为什么|为何|怎么|改成|替换)|\b(?:if|unless|whether|why|can|could|should|would|may|might)\b|(?:或(?:者)?|\bor)\s*$/iu.test(prefix)) return true;
  return /^(?:吗|么|呢|[?？]|或(?:者)?\s*(?:astra|sol|luna|使用|选择|用))|\b(?:or\s+(?:astra|sol|luna|use|choose))\b/iu.test(suffix);
}

function combineContext(older, critical, limit, criticalLimit = limit) {
  const key = String(critical ?? '').slice(0, Math.min(limit, criticalLimit));
  const first = String(older ?? '').slice(0, Math.max(0, limit - key.length - (key ? 1 : 0)));
  return [first, key].filter(Boolean).join('\n');
}

function boundedContext(context) {
  const cap = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
  return {
    summary: cap(context?.summary, 2500),
    progress: cap(context?.progress, 1000),
    lastResult: cap(context?.lastResult, 1000),
  };
}
