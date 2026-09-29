# Jev Model Router for Codex

An experimental, local model router for Codex Desktop on macOS. It asks TypeSafe Jev to assess a task, then recommends an available Codex model and reasoning effort. It can route new turns automatically or provide a preview for a manual choice. A recommendation does not prove that a task ran or passed review.

This is an independent community project, not affiliated with OpenAI or TypeSafe. Compatibility depends on your Codex Desktop build. Token and cost savings have not been measured.

## Requirements

- macOS and a signed-in Codex Desktop app
- Node.js 24 (the version used for validation)
- A TypeSafe API key for your own account
- A native Codex model catalog that includes the models you intend to use

The router reads `TYPESAFE_API_KEY` from its process environment or a macOS Keychain generic password with service **Codex TypeSafe API Key** and account set to your macOS username. Add the credential in Keychain Access; keep the key out of this repository, screenshots, issue reports, and shell command history. The project does not ship a key. You can use `route_preview` after installation to check that the credential is available.

## Install

```sh
git clone https://github.com/lwf225-source/jev-codex-router.git
cd jev-codex-router
npm ci
node scripts/manage-install.mjs --dry-run
npm run install:local
```

The dry run checks for conflicting Codex launch and MCP settings. Installation registers the `jev-router` MCP server and a local app-server wrapper. Restart Codex Desktop after installation so it loads both. Keep this checkout and its Node executable at the same paths while installed; uninstall before moving either one.

Fresh installations default to automatic routing **disabled**; existing router settings are preserved. You can ask Codex in chat to invoke the named `jev-router` MCP tools and use the current thread ID for thread-specific settings. First use `status`, `available_models`, and `route_preview`. For example, call `route_preview` with:

```json
{"prompt":"Return the word READY."}
```

A preview asks Jev for a recommendation but does not start a Codex turn or save that prompt in route logs. It sends the prompt and any supplied bounded same-task context to TypeSafe. Check the returned `model`, `effort`, `source`, and `nextAction`. A fallback `source` indicates that the router did not use a successful Jev recommendation. A non-`execute` `nextAction` may be a valid Jev judgment that calls for context, repair, replanning, or a stop.

## Enable and control routing

After checking the preview and your desktop behavior, enable automatic routing globally by calling MCP `settings` with:

```json
{"enabled":true}
```

To enable it for one existing Codex thread, call MCP `thread_settings` with its exact thread ID:

```json
{"threadId":"YOUR_CODEX_THREAD_ID","enabled":true,"mode":"auto"}
```

A thread setting overrides the inherited global value. Use `{"enabled":false}` in `settings` to disable the default for threads that inherit it; a thread explicitly set to `enabled:true` stays enabled. Use `{"threadId":"YOUR_CODEX_THREAD_ID","enabled":false}` in `thread_settings` to disable one thread; `enabled:null` restores inheritance from the global setting. Read either tool with no update fields to inspect its current settings.

To pin a model for a thread, call `thread_settings` with all three fields:

```json
{"threadId":"YOUR_CODEX_THREAD_ID","mode":"manual","manualModel":"gpt-6-sol","manualEffort":"medium"}
```

Call `thread_settings` with `{"threadId":"YOUR_CODEX_THREAD_ID","mode":"auto"}` to resume automatic selection. Choose a model and effort supported by `available_models`. The router acts on a new turn; steering an active turn is passed through unchanged. Plan-only mode stays plan-only.

See [Routing and handoff](docs/routing.md) for policy, fallback, retries, and execution-plan verification. See [Development and checks](docs/development.md) for test commands and their limits.

## Privacy and local data

The current prompt and bounded same-task context are sent to TypeSafe for judgment. The router does not automatically read project files or send attachment bytes. Queued input is kept temporarily in a local file with `0600` permissions until its native start is confirmed; queue status does not reveal prompt text. Local route and execution metadata omit prompt and task text and are retained for 30 days. The app-server wrapper still passes the original turn to native Codex. See [Routing and handoff](docs/routing.md#context-queues-and-retention) for details.

## Uninstall

```sh
npm run uninstall:local
```

Restart Codex Desktop afterward. Uninstall removes this integration's MCP registration and launcher configuration; local settings and retained metadata remain. The desktop wrapper relies on the experimental `CODEX_CLI_PATH` integration point, so recheck it after Codex updates.

Licensed under the [MIT License](LICENSE).
