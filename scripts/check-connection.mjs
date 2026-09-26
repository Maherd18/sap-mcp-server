#!/usr/bin/env node
/**
 * Checks the connection to the SAP system, step by step:
 *
 *   1. configuration complete
 *   2. host reachable (TCP)
 *   3. ADT login (session cookie, CSRF token)
 *   4. repository search
 *   5. source code read
 *   6. path guard refuses requests outside /sap/bc/adt
 *
 * Read-only. The password never appears in the output.
 *
 *   npm run check
 */

import net from 'node:net';
import { AdtClient, AdtError } from '../src/adt-client.mjs';
import { config, validateConfig, safeSummary, baseUrl } from '../src/config.mjs';

const ok = (s) => `  ok    ${s}`;
const fail = (s) => `  FAIL  ${s}`;
const info = (s) => `        ${s}`;

let failures = 0;
const step = (n, title) => console.log(`\n[${n}] ${title}`);

// --- 1. Configuration -------------------------------------------------------
step(1, 'Configuration');
const missing = validateConfig();
for (const [k, v] of Object.entries(safeSummary())) console.log(info(`${k.padEnd(10)} ${v}`));
if (missing.length) {
  console.log(fail(`missing: ${missing.join(', ')}`));
  console.log(info('Set them as environment variables or in .env (see .env.example).'));
  process.exit(1);
}
console.log(ok('complete'));

// --- 2. TCP -----------------------------------------------------------------
step(2, 'Host reachable');
const reachable = await new Promise((resolve) => {
  const socket = net.createConnection({ host: config.sap.host, port: config.sap.port });
  const done = (v) => { socket.destroy(); resolve(v); };
  socket.setTimeout(5000);
  socket.on('connect', () => done(true));
  socket.on('timeout', () => done(false));
  socket.on('error', () => done(false));
});
if (!reachable) {
  console.log(fail(`${config.sap.host}:${config.sap.port} is not reachable`));
  console.log(info('Check host, port and network access (VPN, firewall).'));
  process.exit(1);
}
console.log(ok(`${config.sap.host}:${config.sap.port} responds`));

// --- 3. Login ---------------------------------------------------------------
const client = new AdtClient();
step(3, 'ADT login');
try {
  const res = await client.connect();
  console.log(ok(`logged on to ${baseUrl()} as ${config.sap.user}, client ${config.sap.client}`));
  console.log(info(`CSRF token: ${res.csrfToken ? 'received' : 'NOT received'}`));
  console.log(info(`ADT collections: ${res.collections}`));
  if (!res.csrfToken) {
    console.log(fail('Without a CSRF token no write operation will work.'));
    failures++;
  }
} catch (err) {
  console.log(fail(err.message));
  if (err instanceof AdtError) {
    if (err.status === 401) console.log(info('401: wrong user or password, or the user is locked.'));
    if (err.status === 403) console.log(info('403: logon works, but authorizations are missing (S_DEVELOP, S_ADT_RES).'));
    if (err.status === 404) console.log(info('404: ADT service is not active. Activate /sap/bc/adt in transaction SICF.'));
  }
  process.exit(1);
}

// --- 4. Search --------------------------------------------------------------
step(4, 'Repository search');
let candidate = null;
try {
  const objects = await client.searchObjects('Z*', { maxResults: 10 });
  if (!objects.length) {
    console.log(info('no results for Z* (unusual, but not an error)'));
  } else {
    console.log(ok(`${objects.length} objects found`));
    // Only types that have source code, and no generic workbench URIs.
    const SOURCE_TYPES = /^(PROG\/P|CLAS\/OC|INTF\/OI|FUGR\/FF|PROG\/I)$/;
    candidate = objects.find((o) => o.uri && SOURCE_TYPES.test(o.type ?? '') && !o.uri.includes('/vit/wb/')) ?? null;
  }
} catch (err) {
  console.log(fail(err.message));
  failures++;
}

// --- 5. Source --------------------------------------------------------------
step(5, 'Source code read');
if (!candidate) {
  console.log(info('skipped (no suitable object from step 4)'));
} else {
  try {
    const source = await client.getSource(candidate.uri);
    console.log(ok(`${candidate.name}: ${source.split(/\r?\n/).length} lines`));
  } catch (err) {
    console.log(info(`${candidate.name}: ${err.message} (not every object type has source code)`));
  }
}

// --- 6. Path guard ----------------------------------------------------------
step(6, 'Path guard');
for (const target of ['/etc/passwd', '/sap/bc/ping', 'http://example.com/sap/bc/adt/discovery']) {
  try {
    await client.raw(target);
    console.log(fail(`not refused: ${target}`));
    failures++;
  } catch (err) {
    if (err instanceof AdtError && /^Refused/.test(err.message)) console.log(ok(`refused: ${target}`));
    else { console.log(fail(`${target}: unexpected error: ${err.message}`)); failures++; }
  }
}

console.log(`\n${failures === 0 ? 'Connection works.' : `${failures} check(s) failed.`}`);
process.exit(failures ? 1 : 0);
