#!/usr/bin/env node
import { runStdioServer } from '../src/mcp-server.mjs';

runStdioServer().catch(error => {
  console.error('Jev router MCP failed:', error?.message ?? error);
  process.exitCode = 1;
});
