# Routing and execution handoff

The router uses one TypeSafe Jev judgment to classify task type, complexity, consequence, missing information, planning, and review needs. Policy code then selects from the current native Codex model catalog and chooses a supported reasoning effort. A decision is advice; verify native execution and the result separately.

## Model policy

The `routingPolicy` setting accepts `tiers`, `tasks`, `stages`, and `models`. Tiers are `light`, `balanced`, and `strong`; task kinds are `routine`, `code`, `diagnostic`, `writing`, `research`, `architecture`, `review`, and `unknown`; stages are `planning`, `review`, and `execution`. Preference arrays contain `astra`, `sol`, `terra`, `luna`, or exact native `gpt-...` model IDs. `models` maps exact IDs to declared `capability` values 1, 2, or 3. Preferences are intersected with the available account catalog. Unknown models are not silently treated as cheap alternatives, and a larger version number alone does not establish better capability.

Call MCP `settings`, for example:

```json
{
  "timeoutMs": 2000,
  "routingPolicy": {
    "tasks": {"writing": ["sol", "terra", "astra", "luna"]},
    "stages": {"planning": ["astra", "sol"]}
  }
}
```

The default total routing budget is 2,000 ms; `timeoutMs` accepts 100 through 10,000 ms. Preparation and judgment share that budget. A timeout or failed judgment can select a configured fallback. Known ordinary work may use the balanced fallback; unknown or complex work keeps a strong planning configuration. The returned `source` and `reasonCode` distinguish these cases.

Effort is selected independently of model. Clear routine work uses low effort; ordinary work and clear planning use medium; difficult, important, or uncertain decisions use high. Automatic `xhigh` requires complexity at least 2.65 out of 3, complexity confidence at least 0.65, and diagnostic, architecture, or review work. Explicit user settings take precedence. Policy and effort thresholds are implementation details that may change between releases.

## Decision states and retries

Responses include `model`, `effort`, `source`, and `phase`, plus `taskKind`, `policyVersion`, `reasonCode`, `contextComplete`, `capabilityLimited`, and `nextAction`. Check `nextAction` before dispatch:

| `nextAction` | Action |
| --- | --- |
| `execute` | Run the bounded unit using the returned configuration. |
| `repair_environment` | Fix the environment or dependency first. |
| `needs_context` | Provide missing information or verify uncertain launch state. |
| `replan` | Revise the plan or address a capability limit. |
| `stop` | Do not retry this execution. |

A returned model alone is not permission to execute. Failure categories are `capability`, `environment`, `permission`, `transient`, `plan`, `missing_information`, and `unknown`. Only a capability failure automatically raises capability. A confirmed transient failure can request one same-configuration retry. Unknown launch state or possible external effects require checking native execution before retry. Registered units allow at most two execution attempts; a decision without execution consumes no attempt.

Recognized status-only questions in long conversations can use recent results and progress plus a short historical summary. A complete status snapshot can be answered directly. Mixed actions, quoted questions, and negated requests do not receive that shortcut. Previous execution safety evidence is reused only for an explicit continuation of the same task.

## Registered native handoff

1. Call `register_execution_plan` with `threadId` and `units`. Each unit needs a stable `unitId`, `task`, `acceptanceCriteria`, and optional dependency unit IDs. Registration does not dispatch work. Replacing a plan is explicit; unchanged units retain attempt history.
2. Call `route_execution_subtask` with the same unit ID, task, criteria, and relevant plan context. Honor `nextAction`. If it is `execute`, pass the returned `model` and `effort` to native `spawn_agent`, use `routingToken` as the task name, and give a self-contained assignment with `fork_turns="none"`.
3. A repeated request retains its route identity. If `reused` or `dispatchNeedsCheck` is returned, inspect native history before dispatch. Keep an existing child. Only complete evidence of `not_dispatched` permits the first dispatch with that token.
4. After execution, read `subtask_history`. Native completion and matching configuration must be observed before calling `record_execution_acceptance` with `threadId`, `unitId`, `routeId`, `accepted`, and an explicit verification summary in `evidence`.
5. Read `subtask_history` again. `executionPlan` distinguishes native observations from the main agent's acceptance declaration. Missing children, conflicting tokens, configuration drift, incomplete history, read errors, or missing acceptance cannot produce `allVerified: true`.

Current-plan verification can be complete even if older global history is truncated, but only when `coverage.currentPlan` proves the plan boundary and the authoritative `executionPlan` reports `coverage: "complete"`, `coverageScope: "currentPlan"`, and `allVerified: true`. Parent-interval coverage alone does not prove child completion or delivery acceptance. A main agent's acceptance is a declaration about its checks, not independent proof of semantic correctness. Legacy unregistered calls receive routing advice but incomplete handoff coverage.

Retry arguments include `retry`, `attempt`, `failureCategory`, `failureSummary`, `launchState`, and `possibleExternalEffects`. Use the stored previous configuration and authoritative attempt count. A rejected completed deliverable can be retried only after classification and confirmation of the previous execution state.

## Context, queues, and retention

The current prompt and bounded same-task context go to TypeSafe. Structured context may contain `goal`, `constraints`, `phase`, `dependencies`, `acceptanceCriteria`, `lastResult`, and `attachmentStatus` (`none`, `readable`, `unreadable`, or `unknown`), plus bounded legacy summary and progress fields. The router does not automatically read project files or send attachment bytes. Unread attachments are marked as missing information.

The prompt view is capped at 12,000 characters with head/tail retention and a truncation marker. Context fields share an approximately 4,500-character text budget, prioritizing explicit constraints and recent failure evidence. A recognized status-only question may use recent results and progress before a historical summary capped at 900 characters. These checks establish evidence availability, not freshness or truth. Execution continuations retain conservative history requirements. The original input still goes to native Codex.

Route logs store configuration, reason codes, policy metadata, timing, and optional feedback, without prompt text. Execution-plan records store identifiers, dependencies, state, configuration, timestamps, and hashes of task, acceptance, and evidence text, not those texts. Local metadata is written with `0600` permissions and retained for 30 days.

Queued input is separate. It is temporarily held in a local `0600` file and removed after a confirmed native receipt. An unconfirmed start requires checking native `clientId` and history before automatic retry. `queue_status` reports counts and uncertain starts without queued prompt text. The queue can therefore contain user input while a turn waits; inspect or clear it through the supported queue controls when needed.
