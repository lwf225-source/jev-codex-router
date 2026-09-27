import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const DEFAULT_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';

/** Queries the same native Codex binary used by the desktop app. No turn runs. */
export async function listNativeCodexModels({ binary = process.env.CODEX_JEV_REAL_CLI || DEFAULT_BINARY, timeoutMs = 4000 } = {}) {
  const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CODEX_CLI_PATH: '' } });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 1;
  const pending = new Map();
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (pending.has(message.id)) {
      const settle = pending.get(message.id);
      pending.delete(message.id);
      settle(message);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => message.error ? reject(new Error(`${method} failed`)) : resolve(message.result));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Codex model catalog timed out')), timeoutMs); });
  const startFailure = new Promise((_, reject) => child.once('error', () => reject(new Error('Native Codex could not start'))));
  try {
    return await Promise.race([(async () => {
      await rpc('initialize', { clientInfo: { name: 'jev_router_catalog', title: 'Jev Router Catalog', version: '0.1.0' } });
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      const result = await rpc('model/list', { limit: 100, includeHidden: false });
      if (!Array.isArray(result?.data) || !result.data.length) throw new Error('Codex returned no available models');
      return result.data.filter((item) => item && item.hidden !== true);
    })(), deadline, startFailure]);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill('SIGTERM');
  }
}
