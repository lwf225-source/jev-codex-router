export const POLICY_VERSION = "2.0";
export const TASK_KINDS = [
  "routine",
  "code",
  "diagnostic",
  "writing",
  "research",
  "architecture",
  "review",
  "unknown",
];
export const DEFAULT_POLICY = Object.freeze({
  tiers: {
    light: ["luna", "sol", "astra"],
    balanced: ["sol", "terra", "astra", "luna"],
    strong: ["astra", "sol", "terra", "luna"],
  },
  tasks: {
    code: ["sol", "astra", "terra", "luna"],
    writing: ["sol", "terra", "astra", "luna"],
    research: ["sol", "astra", "terra", "luna"],
  },
  stages: {
    planning: ["astra", "sol", "terra", "luna"],
    review: ["astra", "sol", "terra", "luna"],
  },
});
export function modelFamily(value) {
  return (
    ["astra", "sol", "terra", "luna"].find((f) =>
      new RegExp(`(?:^|[-\\s])${f}(?:$|[-\\s])`, "i").test(value),
    ) || null
  );
}
export function capabilityRank(value, policy = {}) {
  const configured = policy.models?.[value]?.capability;
  if ([1, 2, 3].includes(configured)) return configured;
  const f = modelFamily(value);
  return f === "astra"
    ? 3
    : ["sol", "terra"].includes(f)
      ? 2
      : f === "luna"
        ? 1
        : 0;
}
export function selectPolicyModel(catalog, tier, taskKind, stage, policy = {}) {
  const rank = tier === "strong" ? 3 : tier === "balanced" ? 2 : 1;
  const families =
    policy.tasks?.[taskKind] ||
    policy.stages?.[stage] ||
    policy.tiers?.[tier] ||
    DEFAULT_POLICY.stages[stage] ||
    (tier === "balanced" && DEFAULT_POLICY.tasks[taskKind]) ||
    DEFAULT_POLICY.tiers[tier];
  const eligible = catalog.filter(
    (m) => capabilityRank(m.value, policy) >= rank,
  );
  const pool = eligible.length
    ? eligible
    : catalog.filter((m) => capabilityRank(m.value, policy) > 0);
  for (const name of families) {
    const candidates = pool.filter(
      (m) => m.value === name || modelFamily(m.value) === name,
    );
    if (candidates.length)
      return candidates.find((m) => m.isDefault) || candidates[0];
  }
  // Unknown models are never silently considered the cheap tier.
  return pool[0] || catalog.find((m) => m.isDefault) || catalog[0];
}
export function validateRoutingPolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("routingPolicy must be an object");
  if (Object.keys(value).length > 4)
    throw new TypeError("Too many policy sections");
  const result = {};
  for (const key of Object.keys(value)) {
    if (!["tiers", "tasks", "stages", "models"].includes(key))
      throw new TypeError(`Unknown routingPolicy key: ${key}`);
    const section = value[key];
    if (!section || typeof section !== "object" || Array.isArray(section))
      throw new TypeError(`Invalid routingPolicy.${key}`);
    if (Object.keys(section).length > 64)
      throw new TypeError("Too many policy entries");
    result[key] = {};
    for (const [name, entry] of Object.entries(section)) {
      if (
        ["__proto__", "prototype", "constructor"].includes(name) ||
        name.length > 120 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
      )
        throw new TypeError("Invalid policy name");
      if (
        (key === "tiers" && !["light", "balanced", "strong"].includes(name)) ||
        (key === "tasks" && !TASK_KINDS.includes(name)) ||
        (key === "stages" &&
          !["planning", "review", "execution"].includes(name))
      )
        throw new TypeError(`Unknown policy entry ${name}`);
      if (key === "models") {
        if (!/^gpt-[a-zA-Z0-9._-]+$/.test(name))
          throw new TypeError("Model keys must be catalog GPT IDs");
        if (
          !entry ||
          ![1, 2, 3].includes(entry.capability) ||
          Object.keys(entry).some((k) => k !== "capability")
        )
          throw new TypeError("Model policy requires capability 1, 2 or 3");
        result[key][name] = { capability: entry.capability };
      } else {
        if (
          !Array.isArray(entry) ||
          !entry.length ||
          entry.length > 32 ||
          entry.some(
            (v) =>
              typeof v !== "string" ||
              v.length > 120 ||
              !/^(?:astra|sol|terra|luna|gpt-[a-zA-Z0-9._-]+)$/.test(v),
          )
        )
          throw new TypeError(
            "Policy preferences require a nonempty string array",
          );
        result[key][name] = [...entry];
      }
    }
  }
  return result;
}
