#!/usr/bin/env node
import { inspectSubtasks } from '../src/subtask-history.mjs';
import { getThreadSettings } from '../src/settings.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || !args.length) {
  process.stdout.write('用法：npm run subtasks -- --thread <父任务ID> [--results] [--json]\n查看当前及已完成的直接子任务。配置字段不是逐轮执行遥测。\n');
} else {
  try {
    const index = args.indexOf('--thread');
    const threadId = index >= 0 ? args[index + 1] : null;
    if (!threadId || threadId.startsWith('--')) throw new Error('请使用 --thread 指定父任务 ID');
    const allowed = new Set(['--thread', '--results', '--json']);
    if (args.some((value, i) => i !== index + 1 && !allowed.has(value))) throw new Error('未知参数；请查看 --help');
    const result = { ...await inspectSubtasks({ threadId, includeResults: args.includes('--results') }),
      routing: await getThreadSettings(threadId) };
    if (result.readError) process.exitCode = 1;
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      const oneLine = value => String(value ?? '未知').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180);
      const tasks = result.tasks || [];
      process.stdout.write(`父任务：${oneLine(threadId)}\n`);
      process.stdout.write(`当前路由设置：${result.routing.enabled ? result.routing.mode === 'manual' ? `手动 ${oneLine(result.routing.manualModel)} / ${oneLine(result.routing.manualEffort)}` : '自动' : '关闭'}\n`);
      if (result.readError) process.stdout.write(`读取异常：${oneLine(result.readError)}\n`);
      if (!tasks.length) process.stdout.write(result.truncated || result.readError ? '历史读取不完整，暂时无法确认子任务列表。\n' : '已读取的历史范围内没有发现直接子任务。\n');
      for (const task of tasks) {
        process.stdout.write(`\n${oneLine(task.name || task.childThreadId)}\n  ID：${oneLine(task.childThreadId)}\n  状态：${oneLine(task.status)}\n  Jev 建议：${oneLine(task.suggestedModel)} / ${oneLine(task.suggestedEffort)}\n  派发指定：${oneLine(task.requestedModel)} / ${oneLine(task.requestedEffort)}\n  最新配置：${oneLine(task.configuredModel)} / ${oneLine(task.configuredEffort)}\n`);
        if (task.configuredMatchesSuggestion === false) process.stdout.write('  核对：最新配置与关联的选型建议不一致。\n');
        if (task.readError) process.stdout.write(`  读取异常：${oneLine(task.readError)}\n`);
        if (task.result) process.stdout.write(`  结果：${String(task.result).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')}\n`);
      }
      const coverage = result.coverage || {};
      process.stdout.write(`\n已列出 ${tasks.length} 个子任务；父任务历史${coverage.parentHistory === 'complete' ? '已完整读取' : '读取不完整'}，${result.truncated ? '达到读取限制或存在缺失' : '未截断'}。\n`);
      if (coverage.unlinkedRoutingTokens?.length) process.stdout.write(`有 ${coverage.unlinkedRoutingTokens.length} 条选型建议在已读范围内未关联到子任务。\n`);
      process.stdout.write('“最新配置”来自任务元数据，不能单独证明每轮实际执行模型。\n');
    }
  } catch (error) {
    process.stderr.write(`子任务读取失败：${error.message}\n`);
    process.exitCode = 1;
  }
}
