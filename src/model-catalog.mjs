import { resolveNativeCodexBinary } from './native-binary.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';



/** Queries the same native Codex binary used by the desktop app. No turn runs. */
export async function listNativeCodexModels({ binary = resolveNativeCodexBinary(), timeoutMs = 4000, signal, spawnImpl = spawn } = {}) {
  if (signal?.aborted) throw new Error('Codex model catalog cancelled');
  const child = spawnImpl(binary, ['app-server', '-c', 'mcp_servers={}'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CODEX_CLI_PATH: '' } });
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
  let onAbort;
  const startFailure = new Promise((_, reject) => {
    child.once('error', () => reject(new Error('Native Codex could not start')));
    child.once('exit', () => reject(new Error('Native Codex exited before model catalog was read')));
    child.stdin.on('error', () => reject(new Error('Native Codex catalog input closed')));
    onAbort = () => reject(new Error('Codex model catalog cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
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
    signal?.removeEventListener('abort', onAbort);
    pending.clear();
    lines.close();
    child.stdin.end();
    child.kill('SIGTERM');
  }
}
