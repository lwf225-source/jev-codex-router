#!/usr/bin/env node
import { resolveNativeCodexBinary } from '../src/native-binary.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDataDir } from '../src/settings.mjs';

const exec = promisify(execFile);
const action = process.argv[2] || '--dry-run';
const project = resolve(import.meta.dirname, '..');
const dataDir = getDataDir();
const launcher = join(dataDir, 'codex-app-server.sh');
const marker = join(dataDir, 'install.json');
const agentFile = join(homedir(), 'Library', 'LaunchAgents', 'ai.typesafe.codex-jev-router-env.plist');
const pruneAgentFile = join(homedir(), 'Library', 'LaunchAgents', 'ai.typesafe.codex-jev-router-prune.plist');
const codexNative = resolveNativeCodexBinary();
const proxyEntry = join(project, 'bin', 'codex-jev-app-server.mjs');
const mcpEntry = join(project, 'bin', 'jev-router-mcp.mjs');
const pruneEntry = join(project, 'scripts', 'prune-logs.mjs');
const nodePath = process.execPath;
const cliPath = process.env.CODEX_JEV_INSTALL_CLI || 'codex';
const label = 'ai.typesafe.codex-jev-router-env';
const pruneLabel = 'ai.typesafe.codex-jev-router-prune';

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function xmlEscape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }

function launcherText() {
  return `#!/bin/sh\nCODEX_JEV_REAL_CLI=${shellQuote(codexNative)} exec ${shellQuote(nodePath)} ${shellQuote(proxyEntry)} "$@"\n`;
}

function agentText() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xmlEscape(label)}</string>\n<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${xmlEscape(launcher)}</string></array>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n`;
}

function pruneAgentText() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xmlEscape(pruneLabel)}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(nodePath)}</string><string>${xmlEscape(pruneEntry)}</string></array>\n<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>86400</integer>\n</dict></plist>\n`;
}

async function configuredMcp() {
  try {
    const { stdout } = await exec(cliPath, ['mcp', 'get', 'jev-router', '--json'], { timeout: 4000 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === 1) return null;
    throw new Error('Cannot inspect existing Codex MCP configuration');
  }
}

function isOurMcp(config) {
  const command = config?.transport?.stdio?.command || config?.transport?.command || config?.command;
  const args = config?.transport?.stdio?.args || config?.transport?.args || config?.args;
  return command === nodePath && Array.isArray(args) && args.includes(mcpEntry);
}

async function currentOverride() {
  try {
    const { stdout } = await exec('/bin/launchctl', ['getenv', 'CODEX_CLI_PATH'], { timeout: 2500 });
    return stdout.trim();
  } catch { return ''; }
}

async function loadedAgent(agentLabel) {
  try {
    await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${agentLabel}`], { timeout: 2500 });
    return true;
  } catch { return false; }
}

async function dryRun() {
  if (process.platform !== 'darwin') throw new Error('The native desktop installer requires macOS');
  if (!await exists(codexNative)) throw new Error('The bundled Codex binary was not found');
  if (!await exists(proxyEntry) || !await exists(mcpEntry) || !await exists(pruneEntry)) throw new Error('Router entry points were not found');
  const override = await currentOverride();
  const mcp = await configuredMcp();
  if (override && override !== launcher) throw new Error('Another CODEX_CLI_PATH override is active; installation would conflict');
  if (mcp && !isOurMcp(mcp)) throw new Error('A different jev-router MCP server already exists');
  if (await exists(launcher) && (await readFile(launcher, 'utf8')) !== launcherText()) {
    throw new Error('A different launcher already exists at the Jev router path');
  }
  if (await exists(marker)) {
    const installed = JSON.parse(await readFile(marker, 'utf8'));
    if (installed.project !== project || installed.launcher !== launcher || installed.mcpEntry !== mcpEntry) {
      throw new Error('The Jev router installation marker belongs to a different installation');
    }
  }
  if (await exists(agentFile) && (await readFile(agentFile, 'utf8')) !== agentText()) {
    throw new Error('A different launch agent already owns the Jev router label');
  }
  if (await exists(pruneAgentFile) && (await readFile(pruneAgentFile, 'utf8')) !== pruneAgentText()) {
    throw new Error('A different launch agent already owns the Jev retention label');
  }
  return { project, launcher, agentFile, pruneAgentFile, mcpEntry, nodePath, codexNative, currentOverride: override || null, mcpRegistered: Boolean(mcp), desktopRestartRequired: true };
}

async function install() {
  const plan = await dryRun();
  const existingLauncher = await exists(launcher);
  const existingAgent = await exists(agentFile);
  const existingPruneAgent = await exists(pruneAgentFile);
  const agentWasLoaded = await loadedAgent(label);
  const pruneWasLoaded = await loadedAgent(pruneLabel);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  let addedMcp = false;
  try {
    await writeFile(launcher, launcherText(), { mode: 0o700 });
    await chmod(launcher, 0o700);
    await exec(launcher, ['--version'], { timeout: 5000 });
    if (!plan.mcpRegistered) {
      await exec(cliPath, ['mcp', 'add', 'jev-router', '--', nodePath, mcpEntry], { timeout: 6000 });
      addedMcp = true;
    }
    await writeFile(agentFile, agentText(), { mode: 0o600 });
    await writeFile(pruneAgentFile, pruneAgentText(), { mode: 0o600 });
    if (!agentWasLoaded) {
      await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, agentFile], { timeout: 5000 });
    }
    if (!pruneWasLoaded) {
      await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, pruneAgentFile], { timeout: 5000 });
    }
    await exec('/bin/launchctl', ['setenv', 'CODEX_CLI_PATH', launcher], { timeout: 2500 });
    await writeFile(marker, `${JSON.stringify({ project, launcher, agentFile, pruneAgentFile, mcpEntry, nodePath, codexNative, installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ installed: true, mcpRegistered: true, launcher, agentFile, pruneAgentFile, desktopRestartRequired: true, automaticRoutingEnabled: false })}\n`);
  } catch (error) {
    if (plan.currentOverride !== launcher && await currentOverride() === launcher) {
      if (plan.currentOverride) await exec('/bin/launchctl', ['setenv', 'CODEX_CLI_PATH', plan.currentOverride], { timeout: 2500 }).catch(() => {});
      else await exec('/bin/launchctl', ['unsetenv', 'CODEX_CLI_PATH'], { timeout: 2500 }).catch(() => {});
    }
    if (!pruneWasLoaded && await loadedAgent(pruneLabel)) await exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, pruneAgentFile], { timeout: 5000 }).catch(() => {});
    if (!agentWasLoaded && await loadedAgent(label)) await exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, agentFile], { timeout: 5000 }).catch(() => {});
    if (addedMcp) await exec(cliPath, ['mcp', 'remove', 'jev-router'], { timeout: 5000 }).catch(() => {});
    if (!existingAgent) await rm(agentFile, { force: true }).catch(() => {});
    if (!existingPruneAgent) await rm(pruneAgentFile, { force: true }).catch(() => {});
    if (!existingLauncher) await rm(launcher, { force: true }).catch(() => {});
    throw error;
  }
}

async function uninstall() {
  const mcp = await configuredMcp();
  if (mcp && !isOurMcp(mcp)) throw new Error('The registered jev-router MCP server is owned by another installation');
  if (await exists(launcher) && (await readFile(launcher, 'utf8')) !== launcherText()) {
    throw new Error('The installed launcher has changed; leaving it and startup configuration untouched');
  }
  if (mcp) await exec(cliPath, ['mcp', 'remove', 'jev-router'], { timeout: 5000 });
  const override = await currentOverride();
  if (override === launcher) await exec('/bin/launchctl', ['unsetenv', 'CODEX_CLI_PATH'], { timeout: 2500 });
  if (await exists(agentFile) && (await readFile(agentFile, 'utf8')) === agentText()) {
    if (await loadedAgent(label)) await exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, agentFile], { timeout: 5000 });
    await rm(agentFile, { force: true });
  }
  if (await exists(pruneAgentFile) && (await readFile(pruneAgentFile, 'utf8')) === pruneAgentText()) {
    if (await loadedAgent(pruneLabel)) await exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, pruneAgentFile], { timeout: 5000 });
    await rm(pruneAgentFile, { force: true });
  }
  await rm(launcher, { force: true });
  await rm(marker, { force: true });
  process.stdout.write(`${JSON.stringify({ installed: false, desktopRestartRequired: true, retainedDataDir: dataDir })}\n`);
}

try {
  if (action === '--dry-run') process.stdout.write(`${JSON.stringify(await dryRun())}\n`);
  else if (action === '--install') await install();
  else if (action === '--uninstall') await uninstall();
  else throw new Error('Use --dry-run, --install or --uninstall');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
