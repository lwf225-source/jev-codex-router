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
// Deliberately narrow, whole-turn grammar. Quoted, negated, mixed-action and
// unrecognized requests keep the ordinary task path; quotes are never stripped.
export function routingIntent(prompt = "") {
  const raw = String(prompt).trim();
  // Accept only an exact reporting-only suffix, never arbitrary negation removal.
  const text = raw.replace(/[？?。.!！]\s*(?:只汇报(?:当前)?状态[，,]不执行改动|只汇报[，,]不执行|只汇报当前状态|report status only[;,] do not execute changes)[。.!！]?$/iu, "");
  if (text.length <= 160 && [
    /^(?:请问)?(?:现在|目前)?(?:还有什么|还有哪些|哪些)(?:优化|任务|工作|事项)?(?:还)?(?:没做完|没完成|未完成|待完成)[？?。!！\s]*$/u,
    /^(?:现在|目前)?(?:进度|进展|状态)(?:怎么样|如何|到哪了|到哪一步了)[？?。!！\s]*$/u,
    /^(?:做完了吗|完成了吗|还有什么没做|还剩哪些工作|还剩什么)[？?。!！\s]*$/u,
    /^(?:what(?:'s| is) (?:the (?:current )?)?(?:status|progress)|(?:what|which (?:tasks|items)) (?:remains? unfinished|(?:is|are) (?:still )?(?:unfinished|pending))|what(?:'s| is) left(?: to do)?|how is (?:the )?(?:task|work|progress) going|are (?:you|we) done)[?.!\s]*$/i,
  ].some(pattern => pattern.test(text))) return "status";
  // A wider continuation signal only RETAINS safety evidence. It never grants
  // permission or enables the status optimization.
  if (/^(?:continue\b|resume\b|proceed\b|继续|接着|那就继续|按(?:原|这个|上面)(?:计划|方案))/iu.test(text))
    return "continuation";
  return "task";
}

export function buildRoutingContext(context = {}, { statusOnly = false } = {}) {
  let remaining = 4500;
  const result = {};
  let historyTruncated = context.historyTruncated === true;
  let currentComplete = context.contextComplete !== false && context.currentContextComplete !== false;
  const historical = new Set(["summary", "progress", "lastResult"]);
  // A status answer needs recent evidence, not the old implementation plan.
  // Critical current fields retain their priority and truncation remains unsafe.
  const fields = [
    ["constraints", 900], ["failureSummary", 1000],
    ["acceptanceCriteria", 700], ["dependencies", 600],
    ["goal", 700], ["stage", 100], ["lastResult", 1000],
    ...(statusOnly ? [["progress", 600], ["summary", 900]]
      : [["summary", 2500], ["progress", 1000]]),
  ];
  for (const [key, limit] of fields) {
    const raw = Array.isArray(context[key])
      ? context[key].filter((v) => typeof v === "string").join("\n")
      : context[key];
    result[key] = boundPrompt(raw, Math.min(limit, remaining));
    remaining -= result[key].length;
    const truncated = typeof raw === "string" &&
      (raw.length > result[key].length || raw.includes("[TRUNCATED:"));
    if (truncated) {
      if (historical.has(key)) historyTruncated = true;
      else currentComplete = false;
    }
  }
  if (Array.isArray(context.inputModalities))
    result.inputModalities = context.inputModalities.filter((x) =>
      ["text", "image", "localImage", "audio"].includes(x),
    );
  const attachment = context.attachmentsReadable === true || context.attachmentState === "readable";
  if (result.inputModalities?.some((x) => x !== "text") ||
      ["unread", "unreadable", "unknown"].includes(context.attachmentState)) {
    result.attachmentState = attachment ? "readable" : "unread";
    if (!attachment) currentComplete = false;
  }
  result.historyTruncated = historyTruncated;
  result.currentContextComplete = currentComplete;
  result.contextComplete = currentComplete && (statusOnly || !historyTruncated);
  if (statusOnly) {
    result.turnIntent = "status";
    result.statusEvidenceAvailable = ["lastResult", "progress", "summary"].some(key =>
      result[key].trim() && !result[key].includes("[TRUNCATED:"));
    if (!result.statusEvidenceAvailable) result.contextComplete = false;
  }
  return result;
}
