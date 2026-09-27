import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '..', 'scripts', 'show-route-notification.applescript');

/** Notification text is restricted to the selected configuration and fixed routing reason. */
export function renderRouteNotice({ model, effort, reason, source } = {}) {
  const label = source === 'fallback' ? '备用配置' : source === 'manual' ? '手动选择' : source === 'explicit' ? '本轮指定' : 'Jev 判断';
  const safeModel = String(model || '').replace(/[^\w.-]/g, '').slice(0, 90);
  const safeEffort = String(effort || '').replace(/[^a-z]/gi, '').slice(0, 20);
  const safeReason = String(reason || '').replace(/[\r\n\t]+/g, ' ').slice(0, 100);
  return `${label}：${safeModel} / ${safeEffort}${safeReason ? `。${safeReason}` : ''}`;
}

export async function announceRoute(route, { execImpl = exec } = {}) {
  if (process.platform !== 'darwin' || process.env.JEV_ROUTER_DISABLE_NOTIFICATIONS === '1') return false;
  try {
    await execImpl('/usr/bin/osascript', [script, renderRouteNotice(route)], { timeout: 1500, maxBuffer: 1024 });
    return true;
  } catch { return false; }
}
