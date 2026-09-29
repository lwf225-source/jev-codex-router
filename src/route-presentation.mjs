/** Public route copy is assembled exclusively from bounded metadata and fixed labels. */
export const ROUTE_OBSERVABILITY_VERSION = 'route-visibility-v1';
export const ROUTE_SCOPES = Object.freeze(['main', 'subtask', 'review', 'continuation']);
export const ROUTE_EVENTS = Object.freeze(['selected', 'reselected', 'reused', 'retained', 'explicit', 'manual', 'fallback', 'policy', 'disabled', 'blocked', 'continuation']);
export const ROUTE_REASON_TEXT = Object.freeze({
  simple_task: '任务范围很小，选择轻量配置', standard_task: '常规多步任务，选择均衡配置',
  complex_reasoning: '需要深入推理，选择更强配置', high_impact: '错误后果较大，选择更强配置',
  uncertain: '判断信息不足，选择更稳妥的配置', plan_required: '进入规划与子任务执行流程',
  execution_subtask: '按计划子任务选择配置', judgment: 'Jev 已完成本次判断',
  fallback: 'Jev 不可用，使用备用配置', manual: '使用持续手动配置', explicit: '使用本次明确指定配置',
  disabled: '自动路由已关闭', policy: '使用本地策略', unknown: '路由信息不足',
  aborted: '路由已取消', catalog_unavailable: '模型目录不可用', timeout: '路由判断超时',
  missing_key: '未配置路由凭证', service_error: '路由服务不可用', context_incomplete: '上下文不完整',
  capability_limited: '当前能力受限', attempt_limit: '已达到尝试上限', completion_unknown: '执行完成状态未知',
  failure_environment: '需要修复执行环境', failure_permission: '需要解决权限问题', failure_plan: '需要调整计划',
  failure_missing_information: '需要补充信息', failure_unknown: '失败原因待确认', transient_retry: '允许重试临时故障',
  capability_upgrade: '提高执行配置', capability_ceiling: '已达到可用能力上限',
  routing_in_progress: '路由判断正在进行', completion_check_required: '需要核验执行结果',
  routing_reservation_expired: '路由预留已失效', dependency_incomplete: '依赖尚未完成', plan_missing: '尚未注册计划',
  continuation_retained: '沿用当前执行配置', independent_review_unavailable: '没有可用的独立复核模型', review_planner_missing: '需要提供规划模型以核验独立复核',
});
export const validRouteModel = value => typeof value === 'string' && /^gpt-[a-z0-9][a-z0-9.-]{1,80}$/i.test(value);
export const validRouteEffort = value => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value);
const sources = ['jev', 'fallback', 'manual', 'explicit', 'disabled', 'policy'];
const actions = ['execute', 'repair_environment', 'needs_context', 'replan', 'stop'];
const scopeLabels = { main: '主任务', subtask: '子任务', review: '复核', continuation: '续接' };
const sourceLabels = { jev: 'Jev 本次判断', fallback: '备用配置', manual: '手动选择', explicit: '本轮明确指定', disabled: '自动路由关闭', policy: '本地策略', unknown: '来源未确认' };
const actionLabels = { execute: '可执行', repair_environment: '先修复环境，暂不派发', needs_context: '先补充上下文，暂不派发', replan: '先调整计划，暂不派发', stop: '停止派发' };

export function buildRoutePresentation(route = {}, { scope = 'main', event, previousModel, previousEffort } = {}) {
  route = route && typeof route === 'object' ? route : {};
  scope = ROUTE_SCOPES.includes(scope) ? scope : 'main';
  const source = sources.includes(route.source) ? route.source : 'unknown';
  const model = validRouteModel(route.model) ? route.model : undefined;
  const effort = validRouteEffort(route.effort) ? route.effort : undefined;
  const validConfiguration = Boolean(model && effort);
  const requestedAction = actions.includes(route.nextAction) ? route.nextAction : route.nextAction === undefined ? 'execute' : 'stop';
  const nextAction = requestedAction === 'execute' && !validConfiguration ? 'stop' : requestedAction;
  const previousValid = validRouteModel(previousModel) && validRouteEffort(previousEffort);
  const sameConfiguration = previousValid && validConfiguration ? model === previousModel && effort === previousEffort : undefined;
  event = ROUTE_EVENTS.includes(event) ? event : undefined;
  const retained = event === 'retained' || event === 'continuation';
  const reused = route.reused === true;
  if (!validConfiguration || nextAction !== 'execute') event = 'blocked';
  else if (route.reused === true) event = 'reused';
  else if (event === 'retained' || event === 'continuation') { /* caller proves no fresh judgment */ }
  else if (source !== 'jev') event = sources.includes(source) ? source : 'blocked';
  else if (previousValid || event === 'reselected') event = 'reselected';
  else event = 'selected';
  let label = sourceLabels[source];
  if (event === 'blocked' && source === 'jev') label = 'Jev 路由结果';
  if (reused) label = `复用已有决定（${label}），未重新询问 Jev`;
  if (retained) label = '保留当前配置，未重新询问 Jev';
  if (event === 'reselected') label = sameConfiguration ? 'Jev 已重新判断，配置与上次相同' : 'Jev 已重新判断';
  const configuration = validConfiguration ? `${model} / ${effort}` : '缺少有效模型或推理强度';
  const reason = (reused || retained || event === 'blocked') && route.reasonCode === 'judgment' ? undefined : ROUTE_REASON_TEXT[route.reasonCode];
  return {
    text: `${scopeLabels[scope]}｜${label}：${configuration}；${actionLabels[nextAction]}${reason ? `。${reason}` : ''}`,
    scope, event, source, ...(model ? { model } : {}), ...(effort ? { effort } : {}), nextAction,
    ...(sameConfiguration !== undefined ? { sameConfiguration } : {}),
  };
}
