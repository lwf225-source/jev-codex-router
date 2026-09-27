/** Bound text without silently losing the user's final constraint. */
export function boundPrompt(value, limit = 12000) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= limit) return text;
  const marker = "\n[TRUNCATED: middle omitted]\n";
  if (limit <= marker.length) return marker.slice(0, limit);
  const head = Math.ceil((limit - marker.length) / 2);
  return (
    text.slice(0, head) + marker + text.slice(-(limit - marker.length - head))
  );
}
export function routingTimeoutMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(2147483647, Math.ceil(number))
    : 2000;
}
export function buildRoutingContext(context = {}) {
  let remaining = 4500;
  const result = {};
  let truncated = false;
  // Critical fresh evidence precedes historical prose. Only this allowlist is sent.
  for (const [key, limit] of [
    ["constraints", 900],
    ["failureSummary", 1000],
    ["acceptanceCriteria", 700],
    ["dependencies", 600],
    ["goal", 700],
    ["stage", 100],
    ["lastResult", 1000],
    ["summary", 2500],
    ["progress", 1000],
  ]) {
    const raw = Array.isArray(context[key])
      ? context[key].filter((v) => typeof v === "string").join("\n")
      : context[key];
    result[key] = boundPrompt(raw, Math.min(limit, remaining));
    remaining -= result[key].length;
    if (typeof raw === "string" && raw.length > result[key].length)
      truncated = true;
  }
  result.contextComplete =
    context.contextComplete !== false &&
    !truncated &&
    !Object.values(result).some(
      (v) => typeof v === "string" && v.includes("[TRUNCATED:"),
    );
  if (Array.isArray(context.inputModalities))
    result.inputModalities = context.inputModalities.filter((x) =>
      ["text", "image", "localImage", "audio"].includes(x),
    );
  const attachment =
    context.attachmentsReadable === true ||
    context.attachmentState === "readable";
  if (result.inputModalities?.some((x) => x !== "text")) {
    result.attachmentState = attachment ? "readable" : "unread";
    if (!attachment) result.contextComplete = false;
  }
  return result;
}
