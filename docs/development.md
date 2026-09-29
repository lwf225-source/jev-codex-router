# Development and validation

Run checks from the repository root with Node.js 24 after `npm ci`:

```sh
npm test
npm run check:mcp
npm run check:mcp -- --timeout-ms=10000
npm run check:stage -- --timeout-ms=10000
npm run check:stage -- --review --timeout-ms=10000
npm run check:app-server
npm run check:queue
npm run check:controls
npm run eval:samples
node scripts/check-status-context.mjs
node scripts/check-status-context.mjs --live
```

`npm test` covers settings, selection, effort thresholds, deadlines, fallback, cancellation, queue edits, context truncation, retry classification, idempotency, plan dependencies, incomplete history, configuration drift, and separate delivery acceptance. The status/context check uses eight fixed synthetic cases. Offline mode uses a fixed judgment stub; `--live` uses TypeSafe credentials and isolated MCP previews. Use `--case=<fixture id>` to rerun one case. The timeout option changes isolated test settings only.

Live checks send synthetic prompts to TypeSafe. The staged integration check uses a fixed planner unless `--live` is supplied; execution selection still calls Jev. These checks exercise native protocol and handoff evidence. They do not establish acceptance in every installed Codex Desktop build, production latency, routing quality, or token/cost savings. The older 0.1 sample evaluation is not evidence of 0.2 quality.

For a read-only view of one parent task and its direct children:

```sh
npm run subtasks -- --thread <parent-thread-id>
npm run subtasks -- --thread <parent-thread-id> --results
npm run subtasks -- --thread <parent-thread-id> --json
```

The history reader does not start tasks, call Jev, or persist transcripts. Its reads are bounded and report incomplete evidence. Use MCP `subtask_history` for registered-plan reconciliation and acceptance.
