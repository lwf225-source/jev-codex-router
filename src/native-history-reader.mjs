import { spawn } from 'node:child_process';

const DEFAULT_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex';
const ALLOWED_METHODS = new Set(['initialize', 'thread/read', 'thread/items/list']);

/** A short-lived local connection. It cannot start, resume, or mutate a thread. */
export async function createNativeHistoryReader({
  binary = process.env.CODEX_JEV_REAL_CLI || DEFAULT_BINARY,
  timeoutMs = 4000,
  maxResponseBytes = 8 * 1024 * 1024,
  spawnImpl = spawn,
} = {}) {
  const child = spawnImpl(binary, ['app-server', '-c', 'mcp_servers={}'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, CODEX_CLI_PATH: '' },
  });
  let nextId = 1;
  let buffer = '';
  let closed = false;
  let failure;
  let killTimer;
  const pending = new Map();

  const rejectPending = (error) => {
    failure ||= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    rejectPending(new Error('Native history reader closed'));
    child.stdout?.removeListener('data', onData);
    child.stdin?.end();
    if (child.exitCode == null && !child.killed) {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 250);
      killTimer.unref?.();
    }
  };
  const fail = (error) => {
    rejectPending(error);
    close();
  };
  function onData(chunk) {
    buffer += chunk.toString('utf8');
    // Bound even malformed/unframed responses before JSON parsing.
    if (Buffer.byteLength(buffer) > maxResponseBytes) {
      fail(new Error('Native history response exceeded the byte limit'));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const code = message.error.code == null ? '' : ` (${message.error.code})`;
        const error = new Error(`${entry.method} failed${code}: ${String(message.error.message || 'unknown error').slice(0, 300)}`);
        error.code = message.error.code;
        entry.reject(error);
      } else entry.resolve(message.result);
    }
  }
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', onData);
  child.on('error', () => fail(new Error('Native Codex could not start')));
  child.on('exit', () => {
    clearTimeout(killTimer);
    fail(new Error('Native Codex exited before completing the history read'));
  });
  child.stdin?.on('error', () => fail(new Error('Native Codex input closed')));

  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (!ALLOWED_METHODS.has(method)) return reject(new Error('History reader only permits read-only RPC methods'));
    if (failure || closed) return reject(failure || new Error('Native history reader closed'));
    const id = nextId++;
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    try {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch {
      fail(new Error('Native Codex input closed'));
    }
  });

  try {
    await rpc('initialize', {
      clientInfo: { name: 'jev_subtask_history', title: 'Jev Subtask History', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return {
      readThread: (params) => rpc('thread/read', params),
      readItems: (params) => rpc('thread/items/list', params),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
