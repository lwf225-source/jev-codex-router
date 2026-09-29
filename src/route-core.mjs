import { evaluateTask } from "./typesafe-client.mjs";
import {
  boundPrompt,
  buildRoutingContext,
  routingTimeoutMs,
  routingIntent,
} from "./routing-context.mjs";
import {
  POLICY_VERSION,
  TASK_KINDS,
  capabilityRank,
  selectPolicyModel,
} from "./routing-policy.mjs";
const EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
export function detectExplicitOverride(prompt, models = [], context = {}) {
  const found = parseExplicitRequest(
    prompt,
    normalizeCatalog(models, context.inputModalities),
  );
  return found.model || found.effort
    ? {
        model: found.model?.value ?? null,
        ...(found.effort ? { effort: found.effort } : {}),
      }
    : null;
}
export async function chooseRoute({
  prompt,
  context = {},
  models = [],
  settings = {},
  apiKey,
  signal,
  fetchImpl,
  execution = false,
  localOnly = false,
  fallbackReasonCode = "service_error",
} = {}) {
  const started = performance.now();
  const catalog = normalizeCatalog(models, context.inputModalities);
  if (!catalog.length)
    throw Object.assign(
      new Error(
        "No available Codex models support the required input modalities and reasoning efforts",
      ),
      {
        code: "catalog_unavailable",
        reasonCode: "catalog_unavailable",
        nextAction: "stop",
      },
    );
  const statusOnly = !execution && routingIntent(prompt) === "status";
  const bounded = buildRoutingContext(context, { statusOnly });
  if (String(prompt ?? "").length > 12000 || String(prompt ?? "").includes("[TRUNCATED:")) {
    bounded.contextComplete = false;
    bounded.currentContextComplete = false;
  }
  const prior =
    !statusOnly && context.continuation === true && context.goalChanged !== true
      ? context.previousRoute
      : null;
  const select = (tier, kind, stage) =>
    selectPolicyModel(catalog, tier, kind, stage, settings.routingPolicy);
  const finish = (model, desired, source, extra = {}) => {
    const effort = resolveEffort(model, desired);
    const limited =
      EFFORTS.indexOf(effort) < EFFORTS.indexOf(desired) ||
      (extra.capabilityFloor &&
        capabilityRank(model.value, settings.routingPolicy) <
          extra.capabilityFloor);
    return {
      model: model.value,
      effort,
      source,
      confidence: null,
      phase: execution ? "execution" : "direct",
      needsSecondOpinion: false,
      taskKind: "unknown",
      policyVersion: POLICY_VERSION,
      contextComplete: bounded.contextComplete,
      nextAction:
        execution && !bounded.contextComplete ? "needs_context" : "execute",
      reasonCode:
        execution && !bounded.contextComplete ? "context_incomplete" : source,
      reason: source,
      ...extra,
      ...(execution &&
      !bounded.contextComplete &&
      (!extra.nextAction || extra.nextAction === "execute")
        ? { nextAction: "needs_context", reasonCode: "context_incomplete" }
        : {}),
      capabilityLimited: Boolean(limited),
      ...(limited &&
      extra.nextAction !== "stop" &&
      !["explicit", "manual"].includes(source)
        ? { nextAction: "replan", reasonCode: "capability_limited" }
        : {}),
      elapsedMs: Math.round(performance.now() - started),
    };
  };
  if (signal?.aborted)
    return finish(select("strong", "unknown", "planning"), "high", "fallback", {
      nextAction: "stop",
      reasonCode: "aborted",
      reason: "Route cancelled",
    });
  const explicit = parseExplicitRequest(prompt, catalog);
  const manual = findModel(catalog, settings.manualModel);
  if (explicit.model || explicit.effort)
    return finish(
      explicit.model ||
        manual ||
        findModel(catalog, settings.fallbackModel) ||
        select("balanced", "unknown", "execution"),
      explicit.effort || settings.manualEffort || "medium",
      "explicit",
      { confidence: 1 },
    );
  if (manual)
    return finish(manual, settings.manualEffort || "medium", "manual", {
      confidence: 1,
    });
  let judgment;
  try {
    if (localOnly)
      throw Object.assign(new Error("Local fallback"), {
        code: fallbackReasonCode,
      });
    judgment = await evaluateTask({
      prompt: boundPrompt(String(prompt ?? "")),
      context: bounded,
      apiKey,
      signal,
      timeoutMs: routingTimeoutMs(settings.timeoutMs),
      fetchImpl,
    });
  } catch (error) {
    const reasonCode =
      error.code === "context_incomplete"
        ? "context_incomplete"
        : error.code === "catalog_unavailable"
          ? "catalog_unavailable"
          : error.code === "timeout"
            ? "timeout"
            : error.code === "missing_key"
              ? "missing_key"
              : error.code === "aborted"
                ? "aborted"
                : "service_error";
    const taskKind =
      prior?.taskKind ||
      (TASK_KINDS.includes(context.taskKind) ? context.taskKind : "unknown");
    const knownStatus = statusOnly && bounded.contextComplete;
    const known = knownStatus ||
      bounded.contextComplete &&
      (context.contextComplete === true || prior?.contextComplete === true) &&
      taskKind !== "unknown";
    const strong =
      !known ||
      prior?.highRisk ||
      ["plan_execute", "planning_only"].includes(prior?.phase) ||
      prior?.capabilityFloor >= 3;
    const tier = knownStatus ? "balanced" : strong
      ? "strong"
      : taskKind === "routine"
        ? "light"
        : "balanced";
    const priorModel = prior && findModel(catalog, prior.model);
    const model =
      (priorModel &&
        capabilityRank(priorModel.value, settings.routingPolicy) >=
          (strong ? 3 : 1) &&
        priorModel) ||
      (tier === "balanced" && findModel(catalog, settings.fallbackModel)) ||
      select(tier, taskKind, strong ? "planning" : "execution");
    const needsReview = !execution && strong && (prior?.highRisk === true || prior?.needsSecondOpinion === true);
    const fallbackVerifier = needsReview ? alternateStrong(catalog, model) : null;
    return finish(
      model,
      strong && EFFORTS.indexOf(prior?.effort) < EFFORTS.indexOf("high")
        ? "high"
        : prior?.effort ||
            (strong
              ? "high"
              : tier === "light"
                ? "low"
                : settings.fallbackEffort || "medium"),
      "fallback",
      {
        taskKind: knownStatus ? "routine" : taskKind,
        phase: execution ? "execution" : strong ? "plan_execute" : "direct",
        highRisk: prior?.highRisk === true,
        needsSecondOpinion: needsReview,
        ...(fallbackVerifier ? { verifierModel: fallbackVerifier.value, verifierEffort: resolveEffort(fallbackVerifier, 'high') } : {}),
        capabilityFloor: Math.max(
          prior?.capabilityFloor || 0,
          strong ? 3 : tier === "balanced" ? 2 : 1,
        ),
        reasonCode,
        reason:
          reasonCode === "timeout"
            ? "Jev 超时; evidence-based fallback"
            : "Jev unavailable; evidence-based fallback",
        ...(reasonCode === "aborted" ? { nextAction: "stop" } : {}),
      },
    );
  }
  const taskKind = judgment.taskKind;
  const highRisk = prior?.highRisk === true || judgment.highConsequence >= 0.65;
  const complex =
    prior?.capabilityFloor >= 3 ||
    judgment.complexity >= 2.35 ||
    (judgment.complexity >= 1.65 && (highRisk || judgment.confidence < 0.55));
  const incomplete =
    !bounded.contextComplete || judgment.underspecified >= 0.65;
  const statusDirect = statusOnly && !incomplete && !highRisk;
  const uncertainRouting = taskKind === "unknown" || judgment.confidence < 0.55;
  const tier =
    complex || highRisk || incomplete || (uncertainRouting && !statusDirect)
      ? "strong"
      : judgment.complexity >= 0.85 || (statusDirect && uncertainRouting)
        ? "balanced"
        : "light";
  const staged =
    !execution && !statusDirect && (judgment.staged || incomplete || uncertainRouting ||
      ["plan_execute", "planning_only"].includes(prior?.phase));
  const stage = execution
    ? "execution"
    : staged
      ? "planning"
      : taskKind === "review"
        ? "review"
        : "execution";
  const model = select(tier, taskKind, stage);
  const desired =
    judgment.complexity >= 2.65 &&
    judgment.confidence >= 0.65 &&
    ["diagnostic", "architecture", "review"].includes(taskKind)
      ? "xhigh"
      : tier === "strong"
        ? "high"
        : tier === "balanced" || staged
          ? "medium"
          : "low";
  const needsSecondOpinion =
    staged && (judgment.needsSecondOpinion || highRisk || prior?.needsSecondOpinion === true);
  const verifier = needsSecondOpinion ? alternateStrong(catalog, model) : null;
  return finish(model, desired, "jev", {
    confidence: judgment.confidence,
    taskKind,
    contextComplete: !incomplete,
    complexity: judgment.complexity,
    highRisk,
    capabilityFloor: tierRank(tier),
    phase: execution ? "execution" : staged ? "plan_execute" : "direct",
    needsSecondOpinion,
    reasonCode: incomplete ? "context_incomplete" : "judgment",
    ...(incomplete && execution ? { nextAction: "needs_context" } : {}),
    reason: "Jev task-specific policy selection",
    ...(verifier
      ? {
          verifierModel: verifier.value,
          verifierEffort: resolveEffort(verifier, "high"),
        }
      : {}),
  });
}
export async function chooseSubtaskRoute({
  task,
  acceptanceCriteria = "",
  dependencies = "",
  previousModel,
  previousEffort,
  failureSummary = "",
  failureCategory,
  failureType,
  attempt = 1,
  launchState,
  possibleExternalEffects = false,
  sideEffectsPossible = false,
  context = {},
  models = [],
  settings = {},
  apiKey,
  signal,
  fetchImpl,
  localOnly = false,
  fallbackReasonCode = "service_error",
} = {}) {
  if (!String(task ?? "").trim())
    throw new TypeError("task must be a non-empty string");
  const failed = Boolean(failureSummary || failureCategory || failureType);
  const requestedCategory =
    {
      information: "missing_information",
      environment_dependency: "environment",
      capability_insufficient: "capability",
    }[failureCategory || failureType] ||
    failureCategory ||
    failureType ||
    (failed ? "unknown" : null);
  const category = [
    "capability",
    "environment",
    "permission",
    "transient",
    "plan",
    "missing_information",
    "unknown",
  ].includes(requestedCategory)
    ? requestedCategory
    : failed
      ? "unknown"
      : null;
  const decision = signal?.aborted
    ? "stop"
    : Number(attempt) > 2
      ? "stop"
      : failed &&
          (launchState === "unknown" ||
            possibleExternalEffects ||
            sideEffectsPossible)
        ? "needs_context"
        : category === "environment"
          ? "repair_environment"
          : category === "permission"
            ? "stop"
            : category === "plan"
              ? "replan"
              : category === "missing_information"
                ? "needs_context"
                : category === "unknown"
                  ? "needs_context"
                  : null;
  const catalog = normalizeCatalog(models, context.inputModalities);
  if (decision) {
    const model =
      findModel(catalog, previousModel) ||
      selectPolicyModel(
        catalog,
        "strong",
        "unknown",
        "planning",
        settings.routingPolicy,
      );
    if (!model) throw new Error("No available Codex models");
    return {
      model: model.value,
      effort: resolveEffort(model, previousEffort || "high"),
      phase: "execution",
      source: "policy",
      confidence: null,
      policyVersion: POLICY_VERSION,
      taskKind: "unknown",
      contextComplete: buildRoutingContext(context).contextComplete,
      nextAction: decision,
      reasonCode: signal?.aborted
        ? "aborted"
        : Number(attempt) > 2
          ? "attempt_limit"
          : launchState === "unknown" ||
              possibleExternalEffects ||
              sideEffectsPossible
            ? "completion_unknown"
            : `failure_${category}`,
      reason: "Resolve failure cause before starting another execution",
      escalated: false,
      elapsedMs: 0,
    };
  }
  if (failed && category === "transient" && previousModel && previousEffort) {
    const model = findModel(catalog, previousModel);
    if (model && model.efforts.includes(previousEffort))
      return {
        model: model.value,
        effort: previousEffort,
        phase: "execution",
        source: "policy",
        policyVersion: POLICY_VERSION,
        taskKind: "unknown",
        nextAction: buildRoutingContext(context).contextComplete
          ? "execute"
          : "needs_context",
        reasonCode: buildRoutingContext(context).contextComplete
          ? "transient_retry"
          : "context_incomplete",
        contextComplete: buildRoutingContext(context).contextComplete,
        reason: "Retry the same configuration once",
        escalated: false,
        elapsedMs: 0,
      };
  }
  const route = await chooseRoute({
    prompt: `Planned execution task:\n${boundPrompt(String(task), 8000)}\nAcceptance criteria:\n${boundPrompt(String(acceptanceCriteria), 2000)}`,
    context: { ...context, dependencies, acceptanceCriteria, failureSummary },
    models,
    settings,
    apiKey,
    signal,
    fetchImpl,
    execution: true,
    localOnly,
    fallbackReasonCode,
  });
  if (
    category === "capability" &&
    previousModel &&
    previousEffort &&
    !["stop", "needs_context"].includes(route.nextAction) &&
    !["manual", "explicit"].includes(route.source)
  ) {
    const upgrade = upgradeAfterFailure(
      catalog,
      findModel(catalog, route.model),
      route.effort,
      previousModel,
      previousEffort,
      settings.routingPolicy,
    );
    return {
      ...route,
      model: upgrade.model.value,
      effort: upgrade.effort,
      escalated: upgrade.escalated,
      nextAction: upgrade.escalated ? "execute" : "replan",
      reasonCode: upgrade.escalated
        ? "capability_upgrade"
        : "capability_ceiling",
      reason: upgrade.escalated
        ? "Capability failure: upgraded configuration"
        : "当前目录无法升级；需要重新规划",
    };
  }
  return { ...route, ...(failed ? { escalated: false } : {}) };
}

function tierRank(tier) {
  return tier === "strong" ? 3 : tier === "balanced" ? 2 : 1;
}
function upgradeAfterFailure(
  catalog,
  currentModel,
  currentEffort,
  previousModel,
  previousEffort,
  policy = {},
) {
  const modelCapabilityRank = (value) => capabilityRank(value, policy);
  const previousModelEntry = findModel(catalog, previousModel);
  const previousValue = previousModelEntry?.value || previousModel;
  const previousRank = modelCapabilityRank(previousValue);
  const desiredModelRank = Math.max(
    modelCapabilityRank(currentModel.value),
    Math.min(3, previousRank + 1),
  );
  const alternatives = catalog
    .filter((entry) => modelCapabilityRank(entry.value) >= desiredModelRank)
    .sort(
      (a, b) => modelCapabilityRank(a.value) - modelCapabilityRank(b.value),
    );
  const strongestAvailable = [...catalog].sort(
    (a, b) => modelCapabilityRank(b.value) - modelCapabilityRank(a.value),
  )[0];
  const model =
    modelCapabilityRank(currentModel.value) >= desiredModelRank &&
    modelCapabilityRank(currentModel.value) >= previousRank
      ? currentModel
      : alternatives[0] || strongestAvailable;
  // The previous configuration remains the baseline even after its model or
  // effort disappears from the current catalog.
  const baselineRank = EFFORTS.indexOf(previousEffort);
  const effortCeiling = Math.max(
    EFFORTS.indexOf("high"),
    EFFORTS.indexOf(currentEffort),
    baselineRank,
  );
  const permittedEfforts = model.efforts.filter(
    (e) => EFFORTS.indexOf(e) <= effortCeiling,
  );
  const highestEffort = [
    ...(permittedEfforts.length ? permittedEfforts : model.efforts),
  ].sort((a, b) => EFFORTS.indexOf(b) - EFFORTS.indexOf(a))[0];
  const modelChange = modelCapabilityRank(model.value) - previousRank;
  if (
    previousRank === 0 ||
    modelChange < 0 ||
    (modelChange === 0 && model.value !== previousValue)
  )
    return { model, effort: highestEffort, escalated: false };
  const targetEffortRank = Math.max(
    EFFORTS.indexOf(currentEffort),
    baselineRank + 1,
  );
  const strongerEffort =
    baselineRank < 0
      ? null
      : permittedEfforts
          .filter((value) => EFFORTS.indexOf(value) >= targetEffortRank)
          .sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
  const effort = strongerEffort || highestEffort;
  return {
    model,
    effort,
    escalated:
      modelChange > 0 ||
      (baselineRank >= 0 && EFFORTS.indexOf(effort) > baselineRank),
  };
}

function alternateStrong(catalog, primary) {
  const sameFamily = familyOf(primary.value);
  for (const family of ["astra", "sol"]) {
    if (family === sameFamily) continue;
    const model = preferredFamily(catalog, family);
    if (model) return model;
  }
  return null;
}

function familyOf(value) {
  return (
    ["astra", "sol", "terra", "luna"].find((family) =>
      new RegExp(`(?:^|[-\\s])${family}(?:$|[-\\s])`, "i").test(value),
    ) || null
  );
}

function normalizeCatalog(input, inputModalities = ["text"]) {
  const entries = Array.isArray(input)
    ? input
    : Array.isArray(input?.data)
      ? input.data
      : [];
  const required = Array.isArray(inputModalities)
    ? inputModalities.map((m) => (m === "localImage" ? "image" : m))
    : ["text"];
  const seen = new Set();
  return entries.flatMap((item) => {
    if (!item || item.hidden === true) return [];
    const supportedModalities = Array.isArray(item.inputModalities)
      ? item.inputModalities
      : familyOf(String(item.model || item.id || ""))
        ? ["text", "image"]
        : ["text"];
    if (!required.every((modality) => supportedModalities.includes(modality)))
      return [];
    const value =
      typeof item.model === "string" && item.model ? item.model : item.id;
    if (typeof value !== "string" || !value || seen.has(value)) return [];
    const supported = (item.supportedReasoningEfforts || [])
      .map((e) => (typeof e === "string" ? e : e?.reasoningEffort))
      .filter((e) => EFFORTS.includes(e));
    if (!supported.length) return [];
    seen.add(value);
    return [
      {
        description: item.description || "",
        inputModalities: supportedModalities,
        value,
        id: item.id || value,
        name: item.displayName || value,
        efforts: supported,
        defaultEffort: item.defaultReasoningEffort,
        isDefault: item.isDefault === true,
      },
    ];
  });
}

function findModel(catalog, requested) {
  if (!requested || typeof requested !== "string") return null;
  const needle = requested.toLowerCase().trim();
  return (
    catalog.find((m) =>
      [m.value, m.id, m.name].some((v) => v.toLowerCase() === needle),
    ) ||
    (["astra", "sol", "luna"].includes(needle)
      ? preferredFamily(catalog, needle)
      : null)
  );
}

function preferredFamily(catalog, family) {
  const matching = catalog.filter((m) =>
    new RegExp(`(?:^|[-\\s])${family}(?:$|[-\\s])`, "i").test(
      `${m.value} ${m.name}`,
    ),
  );
  return (
    matching.sort((a, b) => versionRank(b.value) - versionRank(a.value))[0] ||
    null
  );
}

function versionRank(value) {
  const match = value.match(/(?:gpt[- ])?(\d+)(?:\.(\d+))?/i);
  return match ? Number(match[1]) * 100 + Number(match[2] || 0) : 0;
}

function resolveEffort(model, desired) {
  if (model.efforts.includes(desired)) return desired;
  const target = EFFORTS.indexOf(desired);
  if (target < 0)
    return model.efforts.includes(model.defaultEffort)
      ? model.defaultEffort
      : model.efforts[0];
  return (
    model.efforts
      .filter((e) => EFFORTS.indexOf(e) >= target)
      .sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0] ||
    [...model.efforts].sort(
      (a, b) => EFFORTS.indexOf(b) - EFFORTS.indexOf(a),
    )[0]
  );
}

function parseExplicitRequest(prompt, catalog) {
  const text = boundPrompt(String(prompt ?? ""))
    .replace(
      /```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|‘[^’]*(?:’|$)|"(?:\\.|[^"\\])*(?:"|$)|(?<![\p{L}\p{N}])'(?:\\.|[^'\\])*(?:'|$)/gu,
      (quoted) => quoted.replace(/[^\n]/gu, " "),
    )
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
  const modelDirectives =
    /(?:这(?:一|次|轮)(?:请)?(?:用|使用|选|切到)|请(?:用|使用|选择|切到)|(?:使用|选择|切换到|模型设为)|(?:^|[，,;；\s])(?:再|就|并)?用|(?:^|[\s,;])(?:use|choose|switch to|model\s*[:=])\s*)\s*([\w.-]+|阿斯特拉|月亮|太阳)/giu;
  const aliases = { 阿斯特拉: "astra", 月亮: "luna", 太阳: "sol" };
  let model = null;
  for (const match of text.matchAll(modelDirectives)) {
    if (isUncertainDirective(text, match.index, match.index + match[0].length))
      continue;
    const named = match[1].toLowerCase();
    const found = findModel(catalog, aliases[named] || named);
    if (found) model = found;
  }
  const effortDirectives =
    /(?:推理(?:强度|档位)?\s*(?:设为|调到|用|拉到|拉)|reasoning(?: effort)?\s*[:=])\s*(none|minimal|low|medium|high|xhigh|max|ultra|最低|低|中|高|最高)/giu;
  let effort = null;
  for (const match of text.matchAll(effortDirectives)) {
    if (isUncertainDirective(text, match.index, match.index + match[0].length))
      continue;
    effort =
      { 最低: "minimal", 低: "low", 中: "medium", 高: "high", 最高: "max" }[
        match[1]
      ] || match[1].toLowerCase();
  }
  return { model, effort };
}

function isUncertainDirective(text, start, end) {
  const sentencePrefix = text
    .slice(0, start)
    .split(/[。.!！?？;；\n]/u)
    .at(-1);
  const clauses = sentencePrefix.split(/[，,]/u);
  const prefix = clauses.at(-1).trim();
  const suffix = text
    .slice(end)
    .split(/[，,。.!！;；\n]/u)[0]
    .trim();
  // A directive inside a negation, quotation report, example, condition, or
  // question is not an unambiguous request to change the running model.
  // Keep the complete clause so intervening adverbs cannot hide its scope.
  const negative =
    /(?:不|无需|无须|禁止|避免|别|勿)|\b(?:never|not|no\s+need|without|avoid|don't|do\s+not|cannot|can't|shouldn't|wouldn't|mustn't)\b/iu;
  if (negative.test(prefix)) return true;
  if (
    /^(?:也|还|或者|或|以及|并且|and\b|or\b|nor\b|also\b)/iu.test(prefix) &&
    negative.test(clauses.slice(0, -1).join(","))
  )
    return true;
  if (/[把将]\s*$/u.test(prefix) && /^(?:改成|改为|替换)/u.test(suffix))
    return true;
  if (
    /(?:例如|比如|举例|引用|原文|文档|示例|日志|此前|之前|上次|刚才|(?:他|她|用户|客户|别人)(?:说|要求)|写着|提到|说过|字符串|提示词|这句话)|\b(?:example|quote|quoted|said|says|wrote|previously|earlier|document|documentation)\b/iu.test(
      sentencePrefix,
    )
  )
    return true;
  if (
    /(?:如果|假如|假设|是否|能否|要不要|为什么|为何|怎么|改成|替换)|\b(?:if|unless|whether|why|can|could|should|would|may|might)\b|(?:或(?:者)?|\bor)\s*$/iu.test(
      prefix,
    )
  )
    return true;
  return /^(?:吗|么|呢|[?？]|或(?:者)?\s*(?:astra|sol|luna|使用|选择|用))|\b(?:or\s+(?:astra|sol|luna|use|choose))\b/iu.test(
    suffix,
  );
}
