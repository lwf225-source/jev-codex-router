# Jev 路由 Codex 桌面任务与子代理

本项目将 TypeSafe Jev 接入 Codex 桌面任务路由。每轮新任务开始前，包装器调用 Jev 决定直接执行，或进入强模型规划流程。复杂任务的主代理形成计划；按风险可增加强模型复核；计划明确后，主代理调用 MCP 为各执行子任务选模型，再用 Codex 原生 `spawn_agent` 将任务交给子代理。

本地 MCP 提供设置、预览、反馈、执行子任务选型和记录。桌面 `app-server` 包装器在每轮 `turn/start` 发往原生 Codex 前应用规划模型与思考等级。子代理开始前由 MCP `route_execution_subtask` 再次请求 Jev，并将返回的模型与思考等级传给 `spawn_agent`。

## 当前验证状态

- `npm test`：114 项测试通过，覆盖直跑／两阶段决策、规划复核、子任务模型选择、失败后升档、路由停用后的上下文清理、MCP、本地日志和队列恢复。
- `npm run check:stage` 及 `--review`：固定规划入口的原生 App Server 联动均通过。Astra/high 规划；复核分支另派 Sol/high；真实 Jev 为执行子任务选 Sol/medium，原生执行子代理配置回读一致并交付临时文件。规划入口是测试夹具，尚不等于桌面真实任务验收。
- `npm run check:mcp`：真实 STDIO MCP、7 个原生模型、主任务路由及执行子任务路由均取得 Jev 判断；子任务日志不含其提示文本。
- `npm run check:app-server`：临时任务通过真实包装器执行；Jev 路由结果与 Codex `thread/read` 的模型和推理配置一致。
- `npm run check:queue`：真实 App Server 的持久测试任务中，执行期间加入待执行消息；上一轮结束后，包装器依据最终输入重新调用 Jev 并自动启动下一轮。两轮已确认完成，队列最终归零，测试任务随后归档。
- `npm run check:controls`：同一原生测试任务内，验证持续手动选择、恢复自动、单次指定和关闭该任务路由；六轮原生记录分别显示预期模型与推理档位，任务随后归档。
- `npm run eval:samples`：21/21 模型档位、21/21 阶段选择、6/6 第二模型复核条件符合样例预期；本次运行无回退，平均 Jev 响应约 617 ms。
- **待验收**：完整的原生桌面规划器调用 Jev MCP、再派发差异化模型子代理的联动，通知、模型选择器手动接管和所有项目默认开启。静态发现的 `CODEX_CLI_PATH` 是当前桌面版本的接入口，未见于稳定公开环境变量清单；升级桌面后需重测。

2026-09-23 已验证原图标启动会读取 `CODEX_CLI_PATH`，并修复桌面前置 `-c` 参数的识别问题。原生入口已有一条 Jev 路由及备用路径的运行证据。此次新增的阶段交接代码需要重新启动桌面后加载，再完成原生 UI 验收。

## 本地安装

需要 macOS 上已登录的 Codex 桌面应用、Node.js 和现有 TypeSafe API Key（`TYPESAFE_API_KEY` 环境变量，或 macOS 钥匙串中账户为当前用户、服务名为 `Codex TypeSafe API Key` 的项目）。密钥只在内存中读取，路由日志不保存提示词、完整对话或凭据。

```bash
npm install
node scripts/manage-install.mjs --dry-run
npm run install:local
```

安装器注册 `jev-router` MCP，安装本地 `app-server` 启动包装器，并设置登录时的 `CODEX_CLI_PATH`。原生桌面应用需要重新启动才能读取新环境。完整桌面验收之前，全局自动路由保持关闭。

安装后可通过 MCP 的 `status`、`available_models`、`route_preview`、`route_execution_subtask`、`settings`、`thread_settings`、`feedback`、`recent_routes`、`last_decision`、`queue_status` 工具管理和查看结果。`route_execution_subtask` 接收一个计划好的执行单元及其验收标准，返回适合的原生模型与思考等级；重试时可附上前次模型与失败摘要，Jev 会提高配置。它只写入模型、档位、阶段、回退状态和升档标记，不记录任务文字。`thread_settings` 支持某个任务启停自动路由，以及手动模型持续生效到重新开启自动模式。`route_preview` 不启动 Codex 任务，也不记录传入提示词。`last_decision` 根据固定原因代码给出简短中文说明，指定 `threadId` 可精确查询当前任务。`queue_status` 只显示待执行数量与未确认启动状态，不暴露排队提示词。

### 查看子任务

在项目目录执行 `npm run subtasks -- --thread <父任务ID>`，可以查看正在执行及已经完成的直接子任务，包括名称、ID、状态、派发指定模型和最新配置。增加 `--results` 显示限长结果；增加 `--json` 获取结构化结果。也可让 Codex 调用 MCP 的 `subtask_history`，传入相同父任务 ID。新 MCP 工具需要重新启动桌面应用以加载；本地命令可直接使用。

查询使用本机原生历史接口，仅访问指定父任务及其直接子任务，不启动、恢复或更改任务，不调用 Jev，也不另存对话。父任务读取上限 500 条活动，默认最多读取 20 个子任务；截断或读取错误会明确返回，不能把“没有读取到”当成“没有历史任务”。

`route_execution_subtask` 现在返回 `routeId` 和 `routingToken`。派发时把 `routingToken` 用作 `spawn_agent.task_name`，便可精确关联建议与子任务。查询结果分别提供建议、派发指定和最新配置，配置不一致、重复编号和未关联建议会显式标出。旧记录没有编号时不猜测匹配。最新配置来自原生任务元数据，不是逐轮执行遥测；任务完成也不代表交付内容已经通过主代理验收。

停用并恢复原启动方式：

```bash
npm run uninstall:local
```

卸载器移除本项目注册的 MCP、登录启动环境和包装器；本地设置和 30 天内的路由记录保留。退出并重新打开桌面应用后生效。项目目录与 Node 路径在安装后应保持可用；迁移这两条路径前，先从旧位置卸载，再在新位置安装。

## 路由行为

每次新的用户回合读取原生 `model/list`，或使用同一进程已缓存的当前目录。Jev 在一次请求中评估复杂度、后果、信息不足、是否需要阶段规划和是否需要第二意见；代码将结果限制在当前账号可用模型及支持的思考档位。简单明确的任务直达执行模型。复杂、长链路、存在重要歧义或高影响任务选择强规划模型，并注入本轮协作指引。规划主代理在步骤、依赖和验收标准清楚后，按风险让第二个强模型复核，再逐项调用 `route_execution_subtask`，并把返回模型与 `reasoning_effort` 传给原生 `spawn_agent`。默认一个执行子代理；只有任务可独立拆分时才并行。执行失败时带上前次配置和失败摘要重问 Jev，按模型能力和思考等级顺序升档。若用户选择 Codex 的仅规划模式，包装器保留该模式，不自动派发执行子代理。明确的单次模型指令优先于自动分流。当前执行中的 `turn/steer` 原样传递，在下一个 `turn/start` 才重新判断。

原生 App Server 会在上一轮结束时自动执行它自己的队列，客户端未必发送可拦截的 `thread/queue/start`。本项目在包装器中接管排队项的增删改、排序与列表，保存到权限为 0600 的操作状态文件；实际轮到执行时读取最终输入，先路由，再向原生 App Server 发送 `turn/start`。确认原生任务已经接收该消息后即删除操作状态中的排队项。若启动响应丢失，先通过原生消息 `clientId` 和任务历史核对；仍无法确认时保留“待核查”标记并阻止自动重试，避免重复执行。这个文件不属于路由日志，待执行的原文只在队列仍存在时保存。

TypeSafe 请求异常或超过 2 秒时使用目录中的 Sol / medium 备用配置。包装器在内存中保留少量同任务上下文，供“继续”等提示词使用；路由记录只保留模型、档位、阶段、原因代码、耗时、回退和升档标记及可选反馈，不保存完整提示词或对话。每日登录任务清理超过 30 天的记录。

## 开发检查

```bash
npm test
npm run check:mcp
npm run check:app-server
npm run check:stage
npm run check:stage -- --review
npm run check:queue
npm run check:controls
npm run eval:samples
```

`check:mcp`、`check:app-server`、`check:queue` 和 `check:controls` 会使用真实 TypeSafe 凭据执行合成请求。后两者创建并归档测试任务；这些检查不会改变全局路由开关。

`check:stage` 固定规划入口以验证协作链路，执行模型仍调用真实 Jev。测试进程只预先允许 `route_execution_subtask`，不改全局权限；生产桌面可能需要首次允许该工具。交接指引通过本轮 `additionalContext` 的 application 类型进入模型上下文，保留用户选择的协作模式。指引依赖模型调用原生工具，不是对每次工具调用的硬拦截。
