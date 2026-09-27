# Jev Model Router for Codex

> An experimental TypeSafe Jev-powered task router for the Codex Desktop app. Choose a model and reasoning effort for each new task, send complex work through stronger planning and optional review, then delegate bounded execution to cost-effective Codex subagents.

Jev Codex Router connects TypeSafe Jev to Codex Desktop through a local MCP server and an `app-server` wrapper. Simple requests can go straight to an execution model. Complex tasks can use a stronger planner and, when useful, a second-model review. Jev selects from models available to the current Codex account and assigns a supported reasoning effort. If Jev times out or fails, the router uses the configured fallback (Sol / medium by default).

- **Task-aware routing:** choose an available model and reasoning effort for each new turn.
- **Planning and review:** reserve stronger models for complex, high-impact, or ambiguous work.
- **Subagent routing:** select a model for each bounded execution task and escalate after failures.
- **Codex integration:** use an MCP server, an `app-server` wrapper, queue controls, and native task history.

**Status:** 114 automated tests pass. The full native desktop planning-to-subagent workflow remains experimental and still needs end-to-end desktop acceptance. This is an independent community project and is not affiliated with OpenAI.

## Validation status

- `npm test`: 114 tests pass, covering direct and staged routing, plan review, subtask model selection, retry escalation, routing-context cleanup, MCP tools, local logs, and queue recovery.
- `npm run check:stage` and `npm run check:stage -- --review`: the staged App Server test flow passes. Astra / high is used for planning; the review path assigns Sol / high; live Jev selected Sol / medium for an execution subtask, and the native subagent configuration was read back successfully. The staged planner is a test fixture, so this does not prove full desktop end-to-end behavior.
- `npm run check:mcp`: live Jev judgments passed through the STDIO MCP flow for the main task and execution subtasks across seven native Codex models. Subtask prompt text is not written to the routing log.
- `npm run check:app-server`: a temporary task ran through the real wrapper, and the model and reasoning configuration matched the result read from Codex `thread/read`.
- `npm run check:queue`: a persistent test task accepted a queued message during execution. After the previous turn ended, the wrapper routed the final queued input and started the next turn. Both turns completed, the queue returned to zero, and the test task was archived.
- `npm run check:controls`: a native test task verified persistent manual selection, returning to automatic routing, a one-turn override, and disabling routing for that task. The six native records showed the expected model and reasoning effort; the test task was archived afterward.
- `npm run eval:samples`: 21/21 model-effort choices, 21/21 stage choices, and 6/6 second-review decisions matched the sample expectations. That run had no fallbacks and averaged about 617 ms for Jev responses; this is a sample result, not a latency guarantee.

**Still awaiting desktop acceptance:** the complete native planner → Jev MCP → differentiated subagent workflow, notification behavior, model-picker manual takeover, and enabling automatic routing by default for all projects. The current wrapper uses `CODEX_CLI_PATH`, which was found in the desktop launch path but is not listed among stable public environment variables. Recheck compatibility after Codex Desktop updates.

## Installation

Requirements: macOS, a signed-in Codex Desktop app, Node.js, and a TypeSafe API key. Set `TYPESAFE_API_KEY` or store the key in the macOS Keychain under the service name `Codex TypeSafe API Key` for the current user. The key is read into memory; routing logs do not store prompts, full conversations, or credentials.

```bash
npm install
node scripts/manage-install.mjs --dry-run
npm run install:local
```

The installer registers the `jev-router` MCP server, installs the local `app-server` launch wrapper, and configures `CODEX_CLI_PATH` for the login session. Restart Codex Desktop to load the new environment and MCP server. Automatic routing is disabled by default in a fresh installation. A settings readback alone is not end-to-end acceptance.

After installation, use MCP tools such as `status`, `available_models`, `route_preview`, `route_execution_subtask`, `settings`, `thread_settings`, `feedback`, `recent_routes`, `last_decision`, and `queue_status` to manage and inspect routing. `route_execution_subtask` accepts a planned work unit and its acceptance criteria, then returns a native model and reasoning effort. A retry can include the previous model and a failure summary so Jev can raise the capability level. Subtask records contain the model, effort, phase, fallback status, and escalation flag, not task text.

`thread_settings` can enable or disable routing for one task; manual model selection stays active until automatic mode is restored. `route_preview` does not start a Codex task or log the supplied prompt. `last_decision` gives a short explanation based on fixed reason codes and can target a specific `threadId`. `queue_status` reports queued-item counts and unconfirmed starts without exposing queued prompt text.

### View subagent tasks

From the project directory, run:

```bash
npm run subtasks -- --thread <parent-thread-id>
```

This lists the parent's direct children, including active and completed tasks, their names and IDs, the model assigned at dispatch, and the latest configuration. Add `--results` for bounded results or `--json` for structured output. Codex can also call the MCP `subtask_history` tool with the same parent thread ID. Restart Codex Desktop to load the new MCP tool; the local command works immediately.

The query uses Codex's native local history interface. It reads only the specified parent and its direct children; it does not start, resume, or change tasks, call Jev, or save conversation transcripts. It reads at most 500 parent activities and 20 child tasks by default. Truncation and read failures are reported explicitly; an incomplete read must not be treated as proof that no history exists.

`route_execution_subtask` returns a `routeId` and `routingToken`. Use the `routingToken` as `spawn_agent.task_name` to link a recommendation to the exact child task. Results distinguish the recommendation, dispatched configuration, and latest native configuration. Mismatches, duplicate IDs, and unlinked recommendations are shown explicitly; old records without a token are not guessed. The latest configuration comes from native task metadata, not per-turn execution telemetry. A completed child task does not by itself mean its deliverable passed review.

To disable the integration and restore the original launch path:

```bash
npm run uninstall:local
```

The uninstaller removes this project's MCP registration, login environment entry, and wrapper. Local settings and routing records from the last 30 days remain. Restart Codex Desktop for the change to take effect. Keep the project directory and Node.js path available after installation. Before moving either path, uninstall from the old location and install from the new one.

## Routing behavior

At the start of each new user turn, the router reads the native `model/list` or uses the current list cached by the same process. In one request, Jev evaluates task complexity, consequences, missing information, whether staged planning is needed, and whether a second opinion is useful. Code restricts the result to models and reasoning efforts available to the current account.

Simple, clear tasks go directly to an execution model. Complex, long-running, ambiguous, or high-impact tasks can use a stronger planner and receive collaboration guidance for the turn. Once the plan has clear steps, dependencies, and acceptance criteria, the main agent can request a second strong-model review according to risk. It then calls `route_execution_subtask` for each bounded unit and passes the returned model and `reasoning_effort` to native `spawn_agent`. The default is one execution subagent; parallel agents are used only for independent work. If execution fails, Jev receives the previous configuration and a failure summary and can escalate the model or reasoning effort. Codex's plan-only mode remains plan-only and does not automatically dispatch execution agents. An explicit one-turn model instruction takes precedence over automatic routing. An in-progress `turn/steer` is forwarded unchanged; routing is reconsidered at the next `turn/start`.

The native App Server may run its own queue after the previous turn ends, even when the client does not send an interceptable `thread/queue/start`. The wrapper handles queue additions, edits, deletion, reordering, and listing, and stores queue state in a file with `0600` permissions. When an item is ready to run, it routes the final input before sending `turn/start`. The item is removed from the queue state only after the native task confirms receipt. If the start response is lost, the wrapper checks the native `clientId` and task history. If it still cannot confirm whether the task started, it keeps a pending-check marker and blocks automatic retry to avoid duplicate execution. This queue-state file is separate from routing logs; queued prompt text is stored only while the item remains queued.

If a TypeSafe request fails or exceeds the 2-second timeout, the router uses the configured fallback, Sol / medium by default. The wrapper retains a small amount of same-task context in memory for follow-ups such as “continue.” Routing logs keep only the model, effort, phase, reason code, duration, fallback and escalation flags, and optional feedback; they do not store full prompts or conversations. A daily login task removes routing records older than 30 days.

## Development checks

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

`check:mcp`, `check:app-server`, `check:queue`, and `check:controls` use a real TypeSafe credential to send synthetic requests. Queue and control checks create and archive test tasks; they do not change the global routing setting.

`check:stage` uses a fixed planning entry point to verify the collaboration flow; the execution model still calls live Jev. The test process pre-approves only `route_execution_subtask` and does not change global permissions. A production Codex Desktop session may ask once for permission to use this tool. Handoff guidance is supplied as this turn's `additionalContext` of type `application` and preserves the user's collaboration mode. The model must follow that guidance and call native tools; it is not a hard interception rule for every tool call.
