#!/usr/bin/env node
/**
 * sap-mcp-server entry point.
 *
 * Model Context Protocol over stdio (JSON-RPC 2.0), no dependencies. The server
 * offers only the tools from src/tools.mjs, and every call goes through the
 * policy engine. There is no second path to the ADT client.
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdtClient } from './adt-client.mjs';
import { config, validateConfig } from './config.mjs';
import { loadPolicy } from './policy.mjs';
import { AuditLog } from './audit.mjs';
import { toolCatalog, findTool, PolicyDenied } from './tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version: SERVER_VERSION } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SERVER_NAME = 'sap-mcp-server';
const DEFAULT_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const log = (msg) => process.stderr.write(`[sap-mcp-server] ${msg}\n`);

const missing = validateConfig();
if (missing.length) {
  log(`missing configuration: ${missing.join(', ')} (see .env.example)`);
  process.exit(1);
}

const policy = loadPolicy();
// Audit log target; override with SAP_MCP_AUDIT_FILE (e.g. a volume in a container).
const auditFile = process.env.SAP_MCP_AUDIT_FILE
  ? path.resolve(process.env.SAP_MCP_AUDIT_FILE)
  : path.join(ROOT, policy.auditLog.file);
const audit = new AuditLog(auditFile, policy.auditLog.enabled);
const client = new AdtClient();
const ctx = { client, policy, audit, user: config.sap.user.toUpperCase() };

// The SAP connection is established lazily on the first tool call.
let connected = false;
async function ensureConnected() {
  if (!connected) { await client.connect(); connected = true; }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
const sendResult = (id, result) => send({ jsonrpc: '2.0', id, result });
const sendError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (text, isError = false) => {
  const r = { content: [{ type: 'text', text }] };
  if (isError) r.isError = true;
  return r;
};

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion ?? DEFAULT_PROTOCOL;
      sendResult(id, {
        protocolVersion: KNOWN_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          `Controlled access to SAP ABAP development objects on ${config.sap.host} `
          + `(client ${config.sap.client}) as ${ctx.user}. `
          + `Writes are only possible in: ${policy.allowedPackages.join(', ') || 'none'}. `
          + 'Every call is checked against a policy before execution and written to an audit log. '
          + 'Activation and transport release require human approval and are never executed automatically. '
          + 'Package and object type are always looked up in the system; values passed in a call are ignored for checks.',
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: toolCatalog() });
      return;
    case 'resources/list':
      sendResult(id, { resources: [] });
      return;
    case 'prompts/list':
      sendResult(id, { prompts: [] });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = findTool(name);

      // Tools that are not offered never reach execution.
      if (!tool) {
        audit.decision({
          tool: name, params: args,
          decision: 'deny', effective: 'deny', enforced: true,
          rule: 'unknown_tool', reason: `Tool "${name}" is not offered by this server.`,
          mode: policy.mode, user: ctx.user,
        });
        sendResult(id, textResult(`Denied (unknown_tool): tool "${name}" does not exist.`, true));
        return;
      }

      try {
        await ensureConnected();
        const text = await tool.run(ctx, args);
        sendResult(id, textResult(text ?? '(no output)'));
      } catch (err) {
        if (err instanceof PolicyDenied) {
          const d = err.decision;
          const label = d.decision === 'approval_required' ? 'Approval required' : 'Denied';
          sendResult(id, textResult(`${label} (${d.rule}): ${d.reason}`, true));
        } else {
          sendResult(id, textResult(`Error in ${name}: ${err.message}`, true));
        }
      }
      return;
    }
    default:
      if (id !== undefined && id !== null) sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (err) { sendError(null, -32700, `Parse error: ${err.message}`); return; }
  queue = queue.then(() => handle(msg).catch((err) => {
    if (msg?.id !== undefined && msg?.id !== null) sendError(msg.id, -32603, `Internal error: ${err.message}`);
  }));
});

rl.on('close', () => { queue.then(() => process.exit(0)); });
process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e.message}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack ?? e}`));
