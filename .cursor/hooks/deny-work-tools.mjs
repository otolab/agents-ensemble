#!/usr/bin/env node
/**
 * Deny built-in work tools for the conductor workspace.
 * Custom dispatch tools (MCP) are allowed.
 */
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const toolName = String(input.tool_name ?? input.toolName ?? '');

const denied = /^(Shell|Write|Edit|Delete|ApplyPatch|Task)$/i;
if (denied.test(toolName)) {
  console.log(
    JSON.stringify({
      permission: 'deny',
      agent_message:
        'Conductor does not perform work directly. Use dispatch_worker or dispatch_reviewer.',
    }),
  );
  process.exit(2);
}

console.log(JSON.stringify({ permission: 'allow' }));
