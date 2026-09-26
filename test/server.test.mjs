/**
 * Starts the server over stdio with placeholder credentials and checks the MCP
 * handshake. None of these calls connects to SAP, so the test runs anywhere.
 *
 * To test a container image instead:
 *   SAP_MCP_CMD="docker run -i --rm -e SAP_HOST=x -e SAP_CLIENT=000 -e SAP_USER=x -e SAP_PASSWORD=x sap-mcp-server" npm test
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-mcp-test-'));

let child;
const pending = new Map();
let nextId = 1;

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

before(() => {
  const env = {
    ...process.env,
    SAP_HOST: 'sap.example.invalid',
    SAP_CLIENT: '000',
    SAP_USER: 'TEST_USER',
    SAP_PASSWORD: 'placeholder',
    SAP_MCP_AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
  };
  const [cmd, ...args] = process.env.SAP_MCP_CMD
    ? process.env.SAP_MCP_CMD.split(/\s+/)
    : [process.execPath, path.join(ROOT, 'src', 'server.mjs')];
  child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

after(() => {
  child.stdin.end();
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('initialize returns server info', async () => {
  const res = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  });
  assert.equal(res.result.serverInfo.name, 'sap-mcp-server');
  assert.equal(res.result.protocolVersion, '2025-06-18');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
});

test('tools/list offers exactly the configured tools', async () => {
  const res = await rpc('tools/list');
  const names = res.result.tools.map((t) => t.name);
  assert.equal(names.length, 8);
  assert.ok(names.includes('sap_write_source'));
  assert.ok(!names.some((n) => n.includes('delete')));
});

test('calling a tool that is not offered is denied without contacting SAP', async () => {
  const res = await rpc('tools/call', { name: 'sap_delete_object', arguments: { object_name: 'ZCL_ANY' } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /^Denied \(unknown_tool\)/);
});

test('unknown methods return a JSON-RPC error', async () => {
  const res = await rpc('does/not/exist');
  assert.equal(res.error.code, -32601);
});
