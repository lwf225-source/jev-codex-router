import { existsSync } from 'node:fs';

const CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
];
/** Honor the configured native binary; never substitute the router itself via PATH. */
export function resolveNativeCodexBinary({ env = process.env, exists = existsSync } = {}) {
  return env.CODEX_JEV_REAL_CLI || CANDIDATES.find(path => exists(path)) || CANDIDATES[0];
}
