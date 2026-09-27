#!/usr/bin/env node
import { chooseRoute } from '../src/route-core.mjs';
import { readTypeSafeKey } from '../src/credential.mjs';
import { listNativeCodexModels } from '../src/model-catalog.mjs';

const cases = [
  { id: 'L1', expected: 'light', expectedPhase: 'direct', prompt: '把 README 中一个明显的错别字改正。' },
  { id: 'L2', expected: 'light', expectedPhase: 'direct', prompt: '把这句话译成英文：明天下午三点开会。' },
  { id: 'L3', expected: 'light', expectedPhase: 'direct', prompt: '从“2026-09-23 15:30”中提取日期。' },
  { id: 'L4', expected: 'light', expectedPhase: 'direct', prompt: '列出这段代码里的三个常量名：const A=1, B=2, C=3。' },
  { id: 'L5', expected: 'light', expectedPhase: 'direct', prompt: '把按钮的 CSS 背景色从蓝色改为橙色。' },
  { id: 'B1', expected: 'balanced', expectedPhase: 'direct', prompt: '给现有 Express 服务增加一个按 ID 读取文章的接口，并补一个针对成功和不存在情况的测试。' },
  { id: 'B2', expected: 'balanced', expectedPhase: 'direct', prompt: '已有单文件解析器在空输入时报错；找到原因、修复，并运行针对这个边界的测试。' },
  { id: 'B3', expected: 'balanced', expectedPhase: 'direct', prompt: '把这份团队公告写成一百字，保留时间、责任人和截止日期。' },
  { id: 'B4', expected: 'balanced', expectedPhase: 'direct', prompt: '根据给出的查询语句，比较两个数据库索引方案的读写取舍。' },
  { id: 'B5', expected: 'balanced', expectedPhase: 'direct', prompt: '给现有 React 列表组件补加载中和空列表状态，保持已有视觉规范。' },
  { id: 'B6', expected: 'balanced', expectedPhase: 'direct', prompt: '查阅官方文档，核对一个 SDK 参数的名称、默认值，并给出来源。' },
  { id: 'S1', expected: 'strong', expectedPhase: 'plan_execute', expectedReview: true, prompt: '设计跨十个模块的认证迁移；旧令牌与新令牌并行期间不能让线上用户下线，并给出回滚路径。' },
  { id: 'S2', expected: 'strong', expectedPhase: 'plan_execute', expectedReview: true, prompt: '制定生产数据库的大表迁移方案，包含双写切换、校验、失败回滚和多服务兼容。' },
  { id: 'S3', expected: 'strong', expectedPhase: 'plan_execute', expectedReview: true, prompt: '对整条用户输入到命令执行的路径做深入安全审查，验证攻击条件、修复回归和越权风险。' },
  { id: 'S4', expected: 'strong', expectedPhase: 'plan_execute', expectedReview: true, prompt: '跨三个服务的数据偶发不一致，没有稳定复现；追踪事件顺序、重试与幂等性，定位根因并验证。' },
  { id: 'S5', expected: 'strong', expectedPhase: 'plan_execute', expectedReview: true, prompt: '发布之前审核源码、提交历史、包内容、CI、云端部署和设备行为中的隐私泄漏风险。' },
  { id: 'S6', expected: 'strong', expectedPhase: 'direct', prompt: '患者胸痛、呼吸困难并且出冷汗，请判断紧急程度并给出应立即采取的建议。' },
  { id: 'S7', expected: 'strong', expectedPhase: 'plan_execute', expectedReview: true, prompt: '为一个家庭设计高金额投资配置建议，分析重大风险、税务约束与流动性需求。' },
  { id: 'S8', expected: 'strong', expectedPhase: 'plan_execute', prompt: '定位高并发环境下偶发的死锁，涉及锁顺序、事务边界和定时任务，并设计确定性回归验证。' },
  { id: 'S9', expected: 'strong', expectedPhase: 'plan_execute', prompt: '在不改桌面应用文件的前提下，实现每轮提示词自动选择 Codex 主模型和推理档位，保留原生聊天、任务上下文、手动接管和回滚。' },
  { id: 'S10', expected: 'strong', expectedPhase: 'plan_execute', prompt: '继续。', context: { summary: '当前任务是生产数据库的大表迁移审查。需要核对双写切换、跨服务兼容和回滚。', progress: '已发现切换时旧服务仍可能写入旧表。', lastResult: '上一轮列出两个潜在数据丢失窗口。' } },
];

const key = await readTypeSafeKey();
if (!key) throw new Error('TypeSafe credential is unavailable');
const models = await listNativeCodexModels();
const rows = [];
const selectedIds = process.argv.find((arg) => arg.startsWith('--ids='))?.slice('--ids='.length).split(',').filter(Boolean);
const selectedCases = selectedIds ? cases.filter((sample) => selectedIds.includes(sample.id)) : cases;
if (!selectedCases.length) throw new Error('No matching evaluation cases');
for (const sample of selectedCases) {
  const route = await chooseRoute({
    prompt: sample.prompt,
    context: sample.context || {},
    models,
    settings: { fallbackModel: 'gpt-6-sol', fallbackEffort: 'medium', timeoutMs: 2000 },
    apiKey: key,
  });
  const tier = /astra/i.test(route.model) ? 'strong' : /luna/i.test(route.model) ? 'light' : 'balanced';
  rows.push({ id: sample.id, expected: sample.expected, expectedPhase: sample.expectedPhase, expectedReview: sample.expectedReview,
    tier, phase: route.phase, needsSecondOpinion: route.needsSecondOpinion, model: route.model, effort: route.effort,
    source: route.source, reason: route.reason, elapsedMs: route.elapsedMs, confidence: route.confidence });
  process.stdout.write(`${JSON.stringify(rows.at(-1))}\n`);
}
const strongUnder = rows.filter((row) => row.expected === 'strong' && row.tier !== 'strong');
const simpleOver = rows.filter((row) => row.expected === 'light' && row.tier === 'strong');
const fallback = rows.filter((row) => row.source !== 'jev');
const phaseMismatch = rows.filter((row) => row.expectedPhase && row.phase !== row.expectedPhase);
const reviewMismatch = rows.filter((row) => row.expectedReview !== undefined && row.needsSecondOpinion !== row.expectedReview);
const summary = {
  cases: rows.length,
  exactTierMatches: rows.filter((row) => row.tier === row.expected).length,
  strongUnder: strongUnder.map((row) => row.id),
  simpleOver: simpleOver.map((row) => row.id),
  nonJev: fallback.map((row) => row.id),
  phaseMatches: rows.length - phaseMismatch.length,
  phaseMismatch: phaseMismatch.map((row) => ({ id: row.id, expected: row.expectedPhase, actual: row.phase })),
  reviewMatches: rows.filter((row) => row.expectedReview !== undefined).length - reviewMismatch.length,
  reviewMismatch: reviewMismatch.map((row) => ({ id: row.id, expected: row.expectedReview, actual: row.needsSecondOpinion })),
  averageRoutingMs: Math.round(rows.reduce((sum, row) => sum + row.elapsedMs, 0) / rows.length),
};
process.stdout.write(`${JSON.stringify({ summary })}\n`);
if (strongUnder.length || simpleOver.length || fallback.length || phaseMismatch.length || reviewMismatch.length) process.exitCode = 1;
