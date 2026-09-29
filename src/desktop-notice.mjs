import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { buildRoutePresentation, ROUTE_REASON_TEXT } from './route-presentation.mjs';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '..', 'scripts', 'show-route-notification.applescript');

/** Never accept caller-provided reason or presentation text as notification copy. */
export function renderRouteNotice(route = {}, options = {}) {
  const metadata = route?.presentation;
  return buildRoutePresentation({ ...route, nextAction: route.nextAction ?? metadata?.nextAction }, {
    scope: metadata?.scope,
    event: metadata?.event,
    ...(metadata?.sameConfiguration === true ? { previousModel: route.model, previousEffort: route.effort } : {}),
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  }).text;
}

export async function announceRoute(route, { execImpl = exec, scope, event, previousModel, previousEffort } = {}) {
  if (process.platform !== 'darwin' || process.env.JEV_ROUTER_DISABLE_NOTIFICATIONS === '1') return false;
  try {
    await execImpl('/usr/bin/osascript', [script, renderRouteNotice(route, { scope, event, previousModel, previousEffort })], { timeout: 1500, maxBuffer: 1024 });
    return true;
  } catch { return false; }
}

/** Fire independently of routing. A successful command is not proof the user saw it. */
export function scheduleRouteNotice(route, { announce = announceRoute, timeoutMs = 1500, ...presentationOptions } = {}) {
  const presentation = buildRoutePresentation(route, presentationOptions);
  const snapshot = Object.freeze({
    model: presentation.model, effort: presentation.effort, source: presentation.source,
    nextAction: presentation.nextAction, reused: route?.reused === true,
    ...(Object.hasOwn(ROUTE_REASON_TEXT, route?.reasonCode) ? { reasonCode: route.reasonCode } : {}),
    presentation: Object.freeze(presentation),
  });
  let timer;
  const controller = new AbortController();
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(false); }, Math.max(1, Math.min(1500, timeoutMs)));
    timer.unref?.();
  });
  return Promise.race([
    Promise.resolve().then(() => announce(snapshot, { ...presentationOptions, signal: controller.signal })).then(Boolean, () => false),
    timeout,
  ]).finally(() => clearTimeout(timer));
}
