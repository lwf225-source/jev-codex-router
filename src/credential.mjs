import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';

const execFileAsync = promisify(execFile);
const SERVICE = 'Codex TypeSafe API Key';

/** Reads an existing credential into memory. Never persist or print the value. */
export async function readTypeSafeKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  if (process.env.JEV_ROUTER_DISABLE_KEYCHAIN === '1') return null;
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-a', process.env.USER || process.env.LOGNAME || userInfo().username,
      '-s', SERVICE,
      '-w',
    ], { timeout: 1200, maxBuffer: 16384, encoding: 'utf8' });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
