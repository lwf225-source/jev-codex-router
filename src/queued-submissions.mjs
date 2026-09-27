import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { validateThreadId, withDataLock } from './settings.mjs';

const FILE_NAME = 'queued-submissions.json';
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const publicItem = item => ({ id: item.id, input: structuredClone(item.input), clientUserMessageId: item.clientUserMessageId });

function validateId(id, label) {
  if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) {
    throw new TypeError(`${label} must be a nonempty printable string of at most 256 characters`);
  }
  return id;
}

function validateInput(input) {
  if (!Array.isArray(input) || !input.length || input.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new TypeError('input must be a nonempty array of UserInput objects');
  }
  let copy;
  try { copy = JSON.parse(JSON.stringify(input)); }
  catch { throw new TypeError('input must be JSON serializable'); }
  const validItem = item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    switch (item.type) {
      case 'text': return typeof item.text === 'string' && Array.isArray(item.text_elements);
      case 'image': return typeof item.url === 'string' || typeof item.fileId === 'string';
      case 'audio': return typeof item.url === 'string';
      case 'localImage': case 'localAudio': return typeof item.path === 'string';
      case 'skill': case 'mention': return typeof item.name === 'string' && typeof item.path === 'string';
      default: return false;
    }
  };
  if (copy.some(item => !validItem(item))) {
    throw new TypeError('input must be JSON serializable UserInput objects');
  }
  if (Buffer.byteLength(JSON.stringify(copy)) > MAX_INPUT_BYTES) throw new RangeError('input is too large');
  return copy;
}

function validateStored(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 || !data.threads || typeof data.threads !== 'object' || Array.isArray(data.threads)) {
    throw new Error('invalid queued submissions store');
  }
  for (const [threadId, items] of Object.entries(data.threads)) {
    validateThreadId(threadId);
    if (!Array.isArray(items)) throw new Error('invalid queued submissions store');
    const ids = new Set();
    for (const item of items) {
      validateId(item?.id, 'queuedSubmissionId');
      validateId(item?.clientUserMessageId, 'clientUserMessageId');
      validateInput(item.input);
      if (item.launch !== undefined && (!item.launch || item.launch.state !== 'unknown'
        || typeof item.launch.attemptId !== 'string' || typeof item.launch.attemptedAt !== 'string')) {
        throw new Error('invalid queued submission launch state');
      }
      if (ids.has(item.id)) throw new Error('duplicate queued submission ID');
      ids.add(item.id);
    }
  }
  Object.setPrototypeOf(data.threads, null);
  return data;
}

async function readStore(dir) {
  try { return validateStored(JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, threads: Object.create(null) };
    throw error;
  }
}

async function persist(dir, data) {
  const destination = join(dir, FILE_NAME);
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function encodeCursor(offset) { return Buffer.from(`v1:${offset}`).toString('base64url'); }
function decodeCursor(cursor) {
  if (cursor == null) return 0;
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new TypeError('invalid queue cursor');
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^v1:(0|[1-9]\d*)$/.exec(decoded);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new TypeError('invalid queue cursor');
  return Number(match[1]);
}

export function createQueuedStore({ dataDir } = {}) {
  const locked = operation => withDataLock(dataDir, async dir => operation(await readStore(dir), dir));
  async function deleteItem(threadId, id) {
    validateThreadId(threadId);
    validateId(id, 'queuedSubmissionId');
    return locked(async (data, dir) => {
      const items = data.threads[threadId] ?? [];
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return { deleted: false };
      if (items[index].launch) throw new Error('queued submission start is unconfirmed; inspect it before deleting');
      items.splice(index, 1);
      if (!items.length) delete data.threads[threadId];
      await persist(dir, data);
      return { deleted: true };
    });
  }
  return {
    async add({ threadId, input, clientUserMessageId }) {
      validateThreadId(threadId);
      const copiedInput = validateInput(input);
      validateId(clientUserMessageId, 'clientUserMessageId');
      return locked(async (data, dir) => {
        if (data.threads[threadId]?.some(item => item.clientUserMessageId === clientUserMessageId)) {
          throw new Error('clientUserMessageId is already queued for this thread');
        }
        const item = { id: randomUUID(), input: copiedInput, clientUserMessageId };
        (data.threads[threadId] ??= []).push(item);
        await persist(dir, data);
        return publicItem(item);
      });
    },
    async list(threadId, { limit = 20, cursor = null } = {}) {
      validateThreadId(threadId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100');
      const offset = decodeCursor(cursor);
      return locked(async data => {
        const items = data.threads[threadId] ?? [];
        if (offset > items.length) throw new TypeError('queue cursor is out of range');
        const end = Math.min(items.length, offset + limit);
        return { data: items.slice(offset, end).map(publicItem), nextCursor: end < items.length ? encodeCursor(end) : null };
      });
    },
    async update(threadId, id, input) {
      validateThreadId(threadId);
      validateId(id, 'queuedSubmissionId');
      const copiedInput = validateInput(input);
      return locked(async (data, dir) => {
        const item = data.threads[threadId]?.find(entry => entry.id === id);
        if (!item) throw new Error('queued submission not found');
        if (item.launch) throw new Error('queued submission start is unconfirmed; inspect it before editing');
        item.input = copiedInput;
        await persist(dir, data);
        return publicItem(item);
      });
    },
    delete: deleteItem,
    async reorder(threadId, queuedSubmissionIds) {
      validateThreadId(threadId);
      if (!Array.isArray(queuedSubmissionIds) || queuedSubmissionIds.some(id => typeof id !== 'string')) throw new TypeError('queuedSubmissionIds must be an array of IDs');
      return locked(async (data, dir) => {
        const items = data.threads[threadId] ?? [];
        if (items.length !== queuedSubmissionIds.length || new Set(queuedSubmissionIds).size !== items.length) throw new TypeError('queuedSubmissionIds must contain every queued item exactly once');
        const byId = new Map(items.map(item => [item.id, item]));
        if (queuedSubmissionIds.some(id => !byId.has(id))) throw new TypeError('queuedSubmissionIds contains an unknown ID');
        if (items.length) {
          data.threads[threadId] = queuedSubmissionIds.map(id => byId.get(id));
          await persist(dir, data);
        }
        return {};
      });
    },
    async peek(threadId, id) {
      validateThreadId(threadId);
      if (id != null) validateId(id, 'queuedSubmissionId');
      return locked(async data => {
        const items = data.threads[threadId] ?? [];
        const item = id == null ? items[0] : items.find(entry => entry.id === id);
        return item ? publicItem(item) : null;
      });
    },
    async markStarting(threadId, id, expectedInput) {
      validateThreadId(threadId);
      validateId(id, 'queuedSubmissionId');
      const expected = validateInput(expectedInput);
      return locked(async (data, dir) => {
        const item = data.threads[threadId]?.find(entry => entry.id === id);
        if (!item) throw new Error('queued submission not found');
        if (item.launch) throw new Error('queued submission start is unconfirmed; inspect it before retrying');
        if (JSON.stringify(item.input) !== JSON.stringify(expected)) return { marked: false, submission: publicItem(item) };
        const launch = { state: 'unknown', attemptId: randomUUID(), attemptedAt: new Date().toISOString() };
        item.launch = launch;
        await persist(dir, data);
        return { marked: true, attemptId: launch.attemptId, submission: publicItem(item) };
      });
    },
    async clearStarting(threadId, id, attemptId) {
      validateThreadId(threadId);
      validateId(id, 'queuedSubmissionId');
      validateId(attemptId, 'attemptId');
      return locked(async (data, dir) => {
        const item = data.threads[threadId]?.find(entry => entry.id === id);
        if (!item || item.launch?.attemptId !== attemptId) return false;
        delete item.launch;
        await persist(dir, data);
        return true;
      });
    },
    async getLaunchState(threadId, id) {
      validateThreadId(threadId);
      validateId(id, 'queuedSubmissionId');
      return locked(async data => {
        const item = data.threads[threadId]?.find(entry => entry.id === id);
        return item?.launch ? { ...item.launch, id: item.id, clientUserMessageId: item.clientUserMessageId } : null;
      });
    },
    async listLaunchStates(threadId) {
      validateThreadId(threadId);
      return locked(async data => (data.threads[threadId] ?? []).filter(item => item.launch)
        .map(item => ({ ...item.launch, id: item.id, clientUserMessageId: item.clientUserMessageId })));
    },
    async removeOnStarted(threadId, id) {
      validateThreadId(threadId);
      validateId(id, 'queuedSubmissionId');
      return locked(async (data, dir) => {
        const items = data.threads[threadId] ?? [];
        const index = items.findIndex(item => item.id === id);
        if (index < 0) return { deleted: false };
        items.splice(index, 1);
        if (!items.length) delete data.threads[threadId];
        await persist(dir, data);
        return { deleted: true };
      });
    }
  };
}
