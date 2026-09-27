#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createAppServerProxy } from '../src/app-server-proxy.mjs';
import { announceRoute } from '../src/desktop-notice.mjs';

const nativeCodex = process.env.CODEX_JEV_REAL_CLI || '/Applications/ChatGPT.app/Contents/Resources/codex';
const args = process.argv.slice(2);
const childEnv = { ...process.env };
delete childEnv.CODEX_CLI_PATH;

if (resolve(nativeCodex) === resolve(process.argv[1])) {
  process.stderr.write('Jev router: native Codex path points back to the router.\n');
  process.exit(1);
}

// The desktop passes global -c options before the app-server subcommand.
const appServerMode = args.includes('app-server');
const child = spawn(nativeCodex, args, {
  env: childEnv,
  stdio: appServerMode ? ['pipe', 'pipe', 'pipe'] : 'inherit',
});

if (appServerMode) {
  child.stderr.pipe(process.stderr);
  createAppServerProxy({
    child,
    announce: announceRoute,
    diagnostic: (message, error) => {
      // Never include protocol messages, prompts, response bodies or credentials.
      process.stderr.write(`Jev router: ${message}${error?.code ? ` (${error.code})` : ''}\n`);
    },
  });
}

child.on('error', (error) => {
  process.stderr.write(`Jev router: native Codex could not start (${error.code || 'unknown'}).\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  if (appServerMode) process.stdin.destroy();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
