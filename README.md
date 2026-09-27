# Jev Model Router for Codex

An experimental model router for Codex Desktop, powered by TypeSafe Jev. Use stronger models for uncertain decisions and complex planning, then route well-defined execution work to suitable Codex subagents.

The integration combines a local MCP server with an `app-server` wrapper. Jev evaluates the task; configurable code selects an available model and supported reasoning effort. A routing decision is a recommendation, not proof that a child ran or that its deliverable passed review.

This is an independent community project, not affiliated with OpenAI. Desktop compatibility depends on the installed Codex build. Token savings and cost savings have not been measured.

## Version 0.2 behavior

- **Task-specific selection.** One Jev request evaluates task type, complexity, consequence, missing information, planning, and review. Types cover routine actions, coding, diagnosis, writing, research, architecture, review, and unknown work. Policy profiles constrain model selection; no fabricated prices or success rates are used.
- **Independent reasoning effort.** Planning does not automatically select `xhigh`. Clear routine work uses low effort; ordinary work and clear planning use medium; difficult, important, or uncertain decisions use high. Automatic `xhigh` requires complexity at least 2.65/3, complexity confidence at least 0.65, and diagnosis, architecture, or review work. Explicit user settings take precedence.
- **Evidence-aware fallback.** The default total routing budget is 2,000 ms, configurable from 100 to 10,000 ms. Preparation and Jev judgment share the budget. Known ordinary work may use the configured balanced fallback; unknown or complex work retains a strong planning configuration. Previous safety evidence is reused only for an explicit continuation of the same task.
- **Classified retries.** Capability failures can escalate. Environment failures request repair; permission failures stop; plan failures request replanning; missing information requests context. Unknown launch state or possible external effects require a completion check before retry. Registered execution units permit at most two execution attempts.
- **Observable handoffs.** A registered plan links execution units to routing decisions and native children. Native completion and model configuration are checked separately from the main agent's delivery acceptance. The wrapper supplies instructions and evidence checks; it does not intercept every native tool call.

Unknown task categories use a conservative configuration. They do not alone block a fully specified execution task. Missing required information, unread attachments, or truncated context can return `needs_context`. When available models cannot meet the required capability or effort, the decision is marked limited.

## Installation

Use macOS with a signed-in Codex Desktop app and Node.js (validation uses Node.js 24). A TypeSafe API key must be available through `TYPESAFE_API_KEY` or the macOS Keychain service `Codex TypeSafe API Key` for the current user.

```bash
git clone https://github.com/lwf225-source/jev-codex-router.git
cd jev-codex-router
npm ci
node scripts/manage-install.mjs --dry-run
npm run install:local
```

The installer registers the `jev-router` MCP server, installs a launch wrapper, and configures `CODEX_CLI_PATH` for the login session. Restart Codex Desktop to load a changed wrapper and MCP tool schema. Fresh installations default to automatic routing disabled; existing settings are preserved. The `CODEX_JEV_REAL_CLI` override is honored, with known desktop bundle locations used when it is absent.

`CODEX_CLI_PATH` is an experimental desktop integration point. A successful installation or settings readback does not establish desktop end-to-end acceptance. Revalidate after desktop updates.

```bash
npm run uninstall:local
```

Uninstall removes this integration's MCP registration, launch environment entry, and wrapper. Local settings and retained metadata remain. Restart Codex Desktop afterward. Before relocating the project or Node executable, uninstall from the old location and reinstall from the new location.

## Routing and settings

Use `status`, `available_models`, `route_preview`, `settings`, `thread_settings`, `last_decision`, `recent_routes`, and `feedback` through MCP. `route_preview` does not start a Codex task. `thread_settings` supports automatic routing, persistent manual selection, and a per-task enable override. Plan-only mode remains plan-only. Steering an active turn is forwarded unchanged; a new `turn/start` triggers a new decision.

The optional `routingPolicy` setting supports `tiers`, `tasks`, `stages`, and `models`. Preferences contain known model families or exact native model IDs; declared capabilities range from 1 to 3. Entries are intersected with the native account catalog. Unknown models are not silently treated as cheap alternatives, and a larger version number alone does not establish better capability.

Example MCP `settings` arguments:

```json
{
  "timeoutMs": 2000,
  "routingPolicy": {
    "tasks": { "writing": ["sol", "terra", "astra", "luna"] },
    "stages": { "planning": ["astra", "sol"] }
  }
}
```

Responses retain `model`, `effort`, `source`, and `phase` and add `taskKind`, `policyVersion`, `reasonCode`, `contextComplete`, `capabilityLimited`, and `nextAction`. Consumers must check `nextAction` before dispatch:

| nextAction | Required behavior |
| --- | --- |
| `execute` | Execute the bounded unit using the returned configuration |
| `repair_environment` | Resolve the environment or dependency problem first |
| `needs_context` | Supply missing information or verify uncertain execution state |
| `replan` | Revise the plan or address a capability limitation |
| `stop` | Do not start another execution attempt |

A returned model is not permission to execute when `nextAction` says otherwise. Default routing time remains two seconds; a slower service can produce frequent safe fallbacks. Increase the setting only when the added wait is acceptable.

## Native execution handoff

1. Call `register_execution_plan` with `threadId` and `units`. Each unit needs a stable `unitId`, `task`, `acceptanceCriteria`, and optional dependency unit IDs. Registration does not dispatch work. Changed plans require explicit replacement; unresolved work cannot be silently discarded, and unchanged units retain their attempt history.
2. Call `route_execution_subtask` with the same unit ID, task, and criteria, plus relevant plan context. Pass `model` and `effort` to native `spawn_agent`, use the returned `routingToken` as its task name, and use `fork_turns="none"` with a self-contained assignment.
3. Honor `nextAction`. A repeated request retains its route identity. When `reused` or `dispatchNeedsCheck` is returned, inspect native history before dispatch. Keep an existing child; only complete evidence of `not_dispatched` permits the first dispatch with that token.
4. Read `subtask_history` after execution. Native completion and matching configuration must be observed before calling `record_execution_acceptance` with `threadId`, `unitId`, `routeId`, `accepted`, and an explicit verification summary in `evidence`.
5. Read `subtask_history` again. Its `executionPlan` distinguishes native observations from the main agent's acceptance declaration. Missing children, conflicting tokens, configuration drift, truncated history, read errors, or missing acceptance cannot produce `allVerified: true`.

Use one execution child by default, with parallel children only for independent work. A rejected completed deliverable can be retried when the failure is classified and the previous execution is known. Retry arguments include `retry`, `attempt`, `failureCategory`, `failureSummary`, `launchState`, and `possibleExternalEffects`; registered attempts use the stored previous configuration and authoritative attempt count.

Failure categories are `capability`, `environment`, `permission`, `transient`, `plan`, `missing_information`, and `unknown`. Only `capability` automatically raises capability. A confirmed transient failure can request one same-configuration retry. A non-execution decision consumes no execution attempt.

Legacy unregistered calls still receive routing advice, but their handoff coverage is incomplete. A main agent's acceptance remains a declaration about its checks, not independent proof of semantic correctness.

## Context, queues, and privacy

The router sends the current prompt and bounded same-task context to TypeSafe. It does not automatically read project files or send attachment bytes. Structured context can contain `goal`, `constraints`, `phase`, `dependencies`, `acceptanceCriteria`, `lastResult`, and `attachmentStatus` (`none`, `readable`, `unreadable`, or `unknown`). It also accepts bounded legacy summary/progress fields. Unread attachments are explicitly marked as missing information.

Main-task prompt text is capped at 12,000 characters using head/tail retention and a truncation marker. Context fields share an approximately 4,500-character text budget, prioritizing explicit constraints and recent failure evidence. The full original input still goes to native Codex; a bounded router view must not silently rewrite the user's task.

Routing logs retain configuration, fixed reason codes, policy metadata, timing, fallback/escalation flags, and optional feedback. Execution-plan records store identifiers, dependencies, state, configuration, timestamps, and hashes of task/acceptance/evidence text. They do not persist that text. Metadata is written atomically with `0600` file permissions and retained for 30 days.

The queue state is separate: it temporarily holds queued input in a `0600` file. Final queued input is routed before native execution, and removed only after receipt is confirmed. An unconfirmed start requires checking native `clientId` and history before automatic retry. `queue_status` reports counts and uncertain starts without exposing queued prompt text.

```bash
npm run subtasks -- --thread <parent-thread-id>
npm run subtasks -- --thread <parent-thread-id> --results
npm run subtasks -- --thread <parent-thread-id> --json
```

The local history reader visits only the specified parent and its direct children. It does not start or resume tasks, call Jev, or persist transcripts. Reads are bounded, and incomplete evidence is explicit. For registered-plan acceptance use MCP `subtask_history`, which also reconciles the execution plan.

## Validation

```bash
npm test
npm run check:mcp
npm run check:mcp -- --timeout-ms=10000
npm run check:stage -- --timeout-ms=10000
npm run check:stage -- --review --timeout-ms=10000
npm run check:app-server
npm run check:queue
npm run check:controls
npm run eval:samples
```

Unit/protocol tests cover manual overrides, task-specific routing, effort thresholds, total deadlines, conservative fallback, cancellation, queue edits, context truncation, retry classification, idempotency, plan dependencies, incomplete history, configuration drift, and separate delivery acceptance.

Live checks use synthetic prompts and real TypeSafe credentials. The timeout option changes only isolated test settings. The staged integration test uses a fixed planner unless `--live` is supplied; execution selection still calls Jev. It checks plan registration, native children, selected configurations, delivery content, and acceptance evidence. Native protocol success is separate from a restarted desktop UI acceptance test. Do not treat the historical 0.1 sample evaluation as proof of 0.2 routing quality or savings.
