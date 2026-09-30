/**
 * End-to-end test of the tool layer against a minimal simulated ADT endpoint.
 * Covers the full path: resolve object in the system → policy → ADT call → audit log.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const OBJECTS = {
  ZCL_DEMO: { type: 'CLAS/OC', pkg: 'ZMCP_SANDBOX', uri: '/sap/bc/adt/oo/classes/zcl_demo' },
  ZOTHER_PROGRAM: { type: 'PROG/P', pkg: 'ZOTHER_PACKAGE', uri: '/sap/bc/adt/programs/programs/zother_program' },
};

const calls = [];
let source = 'CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS.';
let server;
let AdtClient; let loadPolicy; let findTool; let PolicyDenied; let AuditLog;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push(`${req.method} ${url.pathname}${url.searchParams.get('_action') ? `?${url.searchParams.get('_action')}` : ''}`);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('x-csrf-token', 'TOKEN');
      res.setHeader('set-cookie', 'SAP_SESSIONID=abc; path=/');
      if (url.pathname === '/sap/bc/adt/discovery') {
        return res.end('<app:service><app:collection href="/sap/bc/adt/a"/></app:service>');
      }
      if (url.pathname === '/sap/bc/adt/repository/informationsystem/search') {
        const q = url.searchParams.get('query');
        const refs = Object.entries(OBJECTS).filter(([n]) => n === q)
          .map(([n, o]) => `<adtcore:objectReference adtcore:uri="${o.uri}" adtcore:type="${o.type}" adtcore:name="${n}" adtcore:packageName="${o.pkg}"/>`);
        return res.end(`<adtcore:objectReferences>${refs.join('')}</adtcore:objectReferences>`);
      }
      if (url.searchParams.get('_action') === 'LOCK') {
        return res.end('<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR>DEVK900001</CORRNR>');
      }
      if (url.searchParams.get('_action') === 'UNLOCK') return res.end('');
      if (url.pathname.endsWith('/source/main')) {
        if (req.method === 'PUT') { source = body; return res.end(''); }
        return res.end(source);
      }
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  process.env.SAP_HOST = '127.0.0.1';
  process.env.SAP_PORT = String(server.address().port);
  process.env.SAP_CLIENT = '000';
  process.env.SAP_USER = 'DEV_USER';
  process.env.SAP_PASSWORD = 'placeholder';
  ({ AdtClient } = await import('../src/adt-client.mjs'));
  ({ loadPolicy } = await import('../src/policy.mjs'));
  ({ findTool, PolicyDenied } = await import('../src/tools.mjs'));
  ({ AuditLog } = await import('../src/audit.mjs'));
});

after(() => server.close());

function context() {
  const client = new AdtClient();
  return { client, policy: loadPolicy(), audit: new AuditLog(null, false), user: 'DEV_USER' };
}

test('reads source inside the allowed package', async () => {
  const ctx = context();
  await ctx.client.connect();
  const out = await findTool('sap_read_source').run(ctx, { object_name: 'ZCL_DEMO' });
  assert.match(out, /ZCL_DEMO \(ZMCP_SANDBOX\)/);
  assert.equal(ctx.audit.entries[0].decision, 'allow');
});

test('the audit log keeps booleans and numbers as their JSON types', async () => {
  const ctx = context();
  await ctx.client.connect();
  await findTool('sap_write_source').run(ctx, { object_name: 'ZCL_DEMO', source: 'A\nB' });
  const entry = ctx.audit.entries[0];
  assert.equal(entry.params.resolved.found, true);
  assert.equal(entry.params.requested.lines, 2);
});

test('denies reading an object from another package, based on the system lookup', async () => {
  const ctx = context();
  await ctx.client.connect();
  await assert.rejects(
    findTool('sap_read_source').run(ctx, { object_name: 'ZOTHER_PROGRAM', package: 'ZMCP_SANDBOX' }),
    (err) => err instanceof PolicyDenied && err.decision.rule === 'package_not_allowed',
  );
});

test('denies unknown objects (deny by default)', async () => {
  const ctx = context();
  await ctx.client.connect();
  await assert.rejects(
    findTool('sap_read_source').run(ctx, { object_name: 'ZDOES_NOT_EXIST' }),
    (err) => err instanceof PolicyDenied && err.decision.rule === 'object_unresolved',
  );
});

test('writes source with lock and unlock inside the sandbox', async () => {
  const ctx = context();
  await ctx.client.connect();
  calls.length = 0;
  const out = await findTool('sap_write_source').run(ctx, { object_name: 'ZCL_DEMO', source: 'NEW SOURCE' });
  assert.match(out, /written/);
  assert.equal(source, 'NEW SOURCE');
  assert.ok(calls.some((c) => c.endsWith('?LOCK')));
  assert.ok(calls.some((c) => c.endsWith('?UNLOCK')));
  assert.equal(ctx.audit.entries.at(-1).type, 'result');
  assert.equal(ctx.audit.entries.at(-1).success, true);
});

test('activation is never executed, it returns an approval request', async () => {
  const ctx = context();
  await ctx.client.connect();
  calls.length = 0;
  await assert.rejects(
    findTool('sap_activate').run(ctx, { object_name: 'ZCL_DEMO' }),
    (err) => err instanceof PolicyDenied && err.decision.decision === 'approval_required',
  );
  assert.ok(!calls.some((c) => c.includes('/activation')));
});

test('the ADT client refuses paths outside /sap/bc/adt', async () => {
  const ctx = context();
  await assert.rejects(ctx.client.raw('/etc/passwd'), /Refused request outside/);
  await assert.rejects(ctx.client.raw('http://example.com/sap/bc/adt/discovery'), /Refused foreign host/);
});
