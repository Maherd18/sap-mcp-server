#!/usr/bin/env node
/**
 * Creates the sandbox package the agent is allowed to write to.
 *
 * One-time setup, not part of the running server. The script stops at the
 * first problem, only creates the named package and never deletes or changes
 * existing objects. Without --create it is a dry run.
 *
 *   npm run setup:sandbox -- [--create] [--name ZMCP_SANDBOX] [--swcomp HOME] [--layer ZSAP]
 */

import { AdtClient } from '../src/adt-client.mjs';
import { config } from '../src/config.mjs';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const NAME = arg('--name', 'ZMCP_SANDBOX').toUpperCase();
const DESCRIPTION = 'MCP sandbox';
const SOFTWARE_COMPONENT = arg('--swcomp', 'HOME');
const TRANSPORT_LAYER = arg('--layer', '');
const CREATE = process.argv.includes('--create');

const text = (b) => (b ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const step = (n, t) => console.log(`\n[${n}] ${t}`);
const abort = (reason) => { console.error(`\nABORTED: ${reason}\nNothing was changed.`); process.exit(1); };

const c = new AdtClient();
await c.connect();
console.log(`User ${config.sap.user}, client ${config.sap.client}`);
console.log(CREATE ? 'Mode: CREATE' : 'Mode: dry run (pass --create to create the package)');

// --- 1. Name must be free ----------------------------------------------------
step(1, `Check whether ${NAME} already exists`);
try {
  const r = await c.raw(`/sap/bc/adt/packages/${NAME.toLowerCase()}`, { accept: '*/*' });
  abort(`${NAME} already exists (HTTP ${r.status}).`);
} catch (e) {
  if (e.status === 404) console.log(`  ok  ${NAME} is available`);
  else abort(`Unexpected response: HTTP ${e.status} ${text(e.body)}`);
}

// --- 2. Validation by the system --------------------------------------------
step(2, 'Validation by the system');
const q = `objtype=DEVC%2FK&objname=${NAME}&packagename=&description=${encodeURIComponent(DESCRIPTION)}`
  + `&operation=CREATE&recordChanges=true&swcomp=${SOFTWARE_COMPONENT}`;
try {
  const r = await c.request('POST', `/sap/bc/adt/packages/validation?${q}`, { accept: '*/*', csrf: true });
  const m = text(r.text);
  if (m && !/^OK$/i.test(m)) abort(`Validation failed: ${m}`);
  console.log('  ok  no objections');
} catch (e) {
  abort(`Validation failed: HTTP ${e.status} ${text(e.body)}`);
}

// --- 3. Package XML ------------------------------------------------------------
// Note: ADT's pak:isAddingObjectsAllowed is inverted. "true" makes the system
// refuse new objects (message PAK 134); "false" allows adding objects.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core"`
  + ` adtcore:name="${NAME}" adtcore:type="DEVC/K" adtcore:description="${DESCRIPTION}"`
  + ` adtcore:responsible="${config.sap.user.toUpperCase()}"`
  + ` adtcore:masterLanguage="${config.sap.language}" adtcore:version="active">
<pak:attributes pak:packageType="development" pak:isAddingObjectsAllowed="false" pak:recordChanges="true"/>
<pak:superPackage/>
<pak:applicationComponent pak:name=""/>
<pak:transport>
<pak:softwareComponent pak:name="${SOFTWARE_COMPONENT}"/>
<pak:transportLayer pak:name="${TRANSPORT_LAYER}"/>
</pak:transport>
<pak:useAccesses/>
<pak:packageInterfaces/>
<pak:subPackages/>
</pak:package>`;

step(3, 'Package to create');
console.log(`  name:               ${NAME}`);
console.log(`  software component: ${SOFTWARE_COMPONENT}`);
console.log(`  transport layer:    ${TRANSPORT_LAYER || '(none)'}`);
console.log('  record changes:     yes');

if (!CREATE) {
  console.log('\nDry run finished. Run again with --create to create the package.');
  process.exit(0);
}

// --- 4. Create -----------------------------------------------------------------
step(4, 'Create package');
try {
  const r = await c.request('POST', '/sap/bc/adt/packages', {
    body: xml,
    contentType: 'application/vnd.sap.adt.packages.v2+xml',
    accept: 'application/vnd.sap.adt.packages.v2+xml',
    csrf: true,
  });
  console.log(`  ok  HTTP ${r.status}`);
} catch (e) {
  console.log(`  HTTP ${e.status}: ${text(e.body).slice(0, 400)}`);
  if (e.status === 403) abort('Missing authorization to create packages (S_DEVELOP, object type DEVC, activity 01).');
  if (/transport|corr/i.test(text(e.body))) abort('The system requires a transport request; create one and try again.');
  abort(`Creating the package failed: HTTP ${e.status}`);
}

// --- 5. Read back --------------------------------------------------------------
step(5, 'Read package back');
try {
  const r = await c.raw(`/sap/bc/adt/packages/${NAME.toLowerCase()}`, { accept: 'application/vnd.sap.adt.packages.v2+xml' });
  const attr = (re) => new RegExp(re).exec(r.body)?.[1] ?? '-';
  console.log(`  ok  ${NAME} exists, owner ${attr('adtcore:responsible="([^"]*)"')}`);
} catch (e) {
  console.log(`  read-back failed: HTTP ${e.status} (the package was created in step 4)`);
}

console.log(`\nDone. Add "${NAME}" to "allowedPackages" in config/policy.json.`);
