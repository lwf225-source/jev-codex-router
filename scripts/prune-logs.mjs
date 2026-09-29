#!/usr/bin/env node
import { listRecentRoutes } from '../src/audit-log.mjs';
import { pruneExecutionPlans } from '../src/execution-plan.mjs';

// Reading the log also rewrites it after applying its fixed 30-day retention.
await listRecentRoutes({ limit: 1 });

await pruneExecutionPlans();
