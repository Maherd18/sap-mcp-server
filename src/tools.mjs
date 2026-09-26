/**
 * Tools exposed to the agent.
 *
 * Only operations listed in the policy are offered. Every call follows the same
 * path, without exception:
 *
 *   1. resolve object details in the SAP system, never trust the agent's input
 *   2. evaluate the policy
 *   3. log the decision
 *   4. execute only if allowed
 *   5. log the result
 *
 * Step 1 is security-critical. If the policy took package and object type from
 * the call parameters, a manipulated agent could simply state a false package
 * and bypass every package boundary. The authoritative details therefore
 * always come from the system.
 */

import { evaluate, DECISION } from './policy.mjs';

/** Error returned to the agent as a structured denial. */
export class PolicyDenied extends Error {
  constructor(decision) {
    super(decision.reason);
    this.name = 'PolicyDenied';
    this.decision = decision;
  }
}

const UNRESOLVED = { found: false, objectName: null, objectType: null, package: null, uri: null };

/**
 * Looks up type, package and URI of an object in the system. If the object is
 * not found, the fields stay null and the policy denies the call (deny by default).
 */
export async function resolveObject(client, objectName) {
  if (!objectName) return { ...UNRESOLVED };
  const name = String(objectName).toUpperCase();
  let hits = [];
  // Not found: objectName stays null, so the policy denies with object_unresolved.
  // The requested name is still recorded in the audit log via the call arguments.
  try {
    hits = await client.searchObjects(name, { maxResults: 25 });
  } catch {
    return { ...UNRESOLVED };
  }
  const exact = hits.find((o) => (o.name ?? '').toUpperCase() === name);
  if (!exact) return { ...UNRESOLVED };
  return {
    found: true,
    objectName: exact.name,
    objectType: exact.type ?? null,
    package: exact.packageName ?? null,
    uri: exact.uri ?? null,
  };
}

/**
 * The only execution path. Every tool runs through here.
 *
 * @param {object} ctx       { client, policy, audit, user }
 * @param {string} tool
 * @param {object} args      arguments as sent by the agent
 * @param {object} resolved  details resolved from the system
 * @param {Function} execute called only if the policy allows
 */
export async function runChecked(ctx, tool, args, resolved, execute) {
  const { policy, audit, user } = ctx;

  const d = evaluate({ tool, params: resolved, user }, policy);

  audit.decision({
    tool,
    params: { requested: args, resolved },
    decision: d.decision,
    effective: d.effective,
    enforced: d.enforced,
    rule: d.rule,
    reason: d.reason,
    mode: d.mode,
    user,
  });

  if (d.effective !== DECISION.ALLOW) throw new PolicyDenied(d);

  const start = Date.now();
  try {
    const result = await execute();
    audit.result({ tool, success: true, durationMs: Date.now() - start });
    return result;
  } catch (err) {
    audit.result({ tool, success: false, message: err.message, durationMs: Date.now() - start });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const str = (description) => ({ type: 'string', description });

export const TOOLS = [
  {
    name: 'sap_test_connection',
    description: 'Checks the connection to the SAP system and reports user, client and number of available ADT resources.',
    schema: {},
    async run(ctx) {
      return runChecked(ctx, 'sap_test_connection', {}, {}, async () => {
        const r = await ctx.client.connect();
        return `Connected as ${ctx.user}, ${r.collections} ADT collections, CSRF token ${r.csrfToken ? 'present' : 'missing'}.`;
      });
    },
  },

  {
    name: 'sap_search_objects',
    description: 'Searches repository objects. Returns name, type and package.',
    schema: {
      query: str('Search pattern, e.g. "ZCL_MCP*".'),
      max_results: { type: 'integer', description: 'Maximum number of hits, default 20.' },
    },
    required: ['query'],
    async run(ctx, a) {
      return runChecked(ctx, 'sap_search_objects', a, {}, async () => {
        const hits = await ctx.client.searchObjects(String(a.query), { maxResults: a.max_results ?? 20 });
        if (!hits.length) return `No results for ${a.query}.`;
        return `${hits.length} results:\n` + hits
          .map((o) => `  ${(o.name ?? '?').padEnd(30)} ${(o.type ?? '').padEnd(10)} package: ${o.packageName ?? '-'}`)
          .join('\n');
      });
    },
  },

  {
    name: 'sap_read_metadata',
    description: 'Reads type, package, owner and version of an object.',
    schema: { object_name: str('Object name.') },
    required: ['object_name'],
    async run(ctx, a) {
      const obj = await resolveObject(ctx.client, a.object_name);
      return runChecked(ctx, 'sap_read_metadata', a, obj, async () => {
        const r = await ctx.client.raw(obj.uri, { accept: '*/*' });
        const attr = (re) => new RegExp(re).exec(r.body)?.[1] ?? '-';
        return `${obj.objectName}\n  type: ${obj.objectType}\n  package: ${obj.package}\n`
          + `  owner: ${attr('adtcore:responsible="([^"]*)"')}\n  version: ${attr('adtcore:version="([^"]*)"')}`;
      });
    },
  },

  {
    name: 'sap_read_source',
    description: 'Reads the source code of a development object.',
    schema: { object_name: str('Object name.') },
    required: ['object_name'],
    async run(ctx, a) {
      const obj = await resolveObject(ctx.client, a.object_name);
      return runChecked(ctx, 'sap_read_source', a, obj, async () => {
        const source = await ctx.client.getSource(obj.uri);
        return `${obj.objectName} (${obj.package}), ${source.split('\n').length} lines:\n\n${source}`;
      });
    },
  },

  {
    name: 'sap_list_transports',
    description: 'Lists open transport requests of the logged-on user.',
    schema: {},
    async run(ctx) {
      return runChecked(ctx, 'sap_list_transports', {}, {}, async () => {
        const r = await ctx.client.raw(`/sap/bc/adt/cts/transportrequests?user=${encodeURIComponent(ctx.user)}&targets=true`, {
          accept: 'application/vnd.sap.adt.transportorganizertree.v1+xml',
        });
        const numbers = [...r.body.matchAll(/tm:number="([^"]+)"/g)].map((m) => m[1]);
        return numbers.length ? `Transport requests: ${numbers.join(', ')}` : 'No open transport requests.';
      });
    },
  },

  {
    name: 'sap_write_source',
    description: 'Replaces the source code of an existing object. Only inside the allowed packages. Activation is a separate step that requires approval.',
    schema: { object_name: str('Object name.'), source: str('The new source code.') },
    required: ['object_name', 'source'],
    async run(ctx, a) {
      const obj = await resolveObject(ctx.client, a.object_name);
      const logged = { object_name: a.object_name, lines: String(a.source ?? '').split('\n').length };
      return runChecked(ctx, 'sap_write_source', logged, obj, async () => {
        let handle = null;
        try {
          const lock = await ctx.client.lock(obj.uri);
          handle = lock.handle;
          await ctx.client.setSource(obj.uri, String(a.source), { lockHandle: handle, corrNr: lock.transport || null });
          return `${obj.objectName} written (${String(a.source).split('\n').length} lines)`
            + `${lock.transport ? `, transport ${lock.transport}` : ''}. Activation is a separate step and requires approval.`;
        } finally {
          if (handle) { try { await ctx.client.unlock(obj.uri, handle); } catch { /* lock expires with the session */ } }
        }
      });
    },
  },

  {
    name: 'sap_activate',
    description: 'Activates an object. Requires human approval: the call returns an approval request and does not execute.',
    schema: { object_name: str('Object name.') },
    required: ['object_name'],
    async run(ctx, a) {
      const obj = await resolveObject(ctx.client, a.object_name);
      return runChecked(ctx, 'sap_activate', a, obj, async () => {
        const r = await ctx.client.activate(obj.objectName, obj.uri);
        return `${obj.objectName} activated (HTTP ${r.status}).${r.messages.length ? `\n${r.messages.join('\n')}` : ''}`;
      });
    },
  },

  {
    name: 'sap_release_transport',
    description: 'Releases a transport request. Requires human approval and is subject to separation of duties.',
    schema: {
      transport: str('Transport request number.'),
      approver: str('SAP user who approves the release. Must not be the developer.'),
    },
    required: ['transport'],
    async run(ctx, a) {
      const resolved = { transport: a.transport, approver: a.approver ?? null };
      return runChecked(ctx, 'sap_release_transport', a, resolved, async () => {
        throw new Error('Not implemented: transport release is never executed by this server.');
      });
    },
  },
];

/** Tool list in MCP format. */
export function toolCatalog() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.schema, required: t.required ?? [] },
  }));
}

export function findTool(name) {
  return TOOLS.find((t) => t.name === name) ?? null;
}
