/**
 * Policy engine.
 *
 * Every tool call is evaluated by `evaluate` before anything is sent to SAP.
 * Rules come only from the policy file; input from the agent is plain data to
 * this layer and cannot change a rule. That is the technical answer to prompt
 * injection: the enforcement point sits outside the channel an attacker can
 * influence.
 *
 * The default is deny. The tool list in the policy is also the allow-list:
 * a tool that is not listed does not exist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DECISION = {
  ALLOW: 'allow',
  DENY: 'deny',
  APPROVAL_REQUIRED: 'approval_required',
};

/** Policy file path; override with SAP_MCP_POLICY_FILE (e.g. inside a container). */
export const POLICY_FILE = process.env.SAP_MCP_POLICY_FILE
  ? path.resolve(process.env.SAP_MCP_POLICY_FILE)
  : path.join(ROOT, 'config', 'policy.json');

export function loadPolicy(file = POLICY_FILE) {
  return normalizePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const upper = (list) => (list ?? []).map((s) => String(s).toUpperCase());

export function normalizePolicy(p) {
  return {
    mode: p.mode === 'dry-run' ? 'dry-run' : 'enforce',
    identity: {
      developer: String(p.identity?.developer ?? '').toUpperCase(),
      approvers: upper(p.identity?.approvers),
    },
    allowedNamespaces: upper(p.allowedNamespaces),
    allowedPackages: upper(p.allowedPackages),
    allowedObjectTypes: upper(p.allowedObjectTypes),
    tools: p.tools ?? {},
    writeEnabled: p.writeEnabled !== false,
    pathPrefix: p.pathPrefix ?? '/sap/bc/adt',
    auditLog: {
      enabled: p.auditLog?.enabled !== false,
      file: p.auditLog?.file ?? 'logs/audit.jsonl',
    },
  };
}

/** Builds a decision object. */
function decide(policy, decision, rule, reason) {
  // In dry-run mode the decision is computed and logged but not enforced.
  // A new policy can be observed in the audit log first and switched on later.
  const enforced = policy.mode === 'enforce';
  return {
    decision,
    effective: enforced ? decision : DECISION.ALLOW,
    enforced,
    mode: policy.mode,
    rule,
    reason,
  };
}

/** Namespace of an object name: first character, or /NAMESPACE/ for prefixed names. */
function namespaceOf(name) {
  const n = String(name ?? '').toUpperCase();
  if (n.startsWith('/')) {
    const end = n.indexOf('/', 1);
    return end > 0 ? n.slice(0, end + 1) : n;
  }
  return n.slice(0, 1);
}

/**
 * Evaluates a tool call.
 *
 * @param {object} request
 *   tool     tool name
 *   params   { objectName, objectType, package, path, transport, approver }
 *            object details must be resolved from the SAP system, not taken from the agent
 *   user     SAP user executing the call
 * @param {object} policy  result of loadPolicy()
 */
export function evaluate(request, policy) {
  const { tool, params = {}, user = null } = request ?? {};
  const p = policy;

  // Unknown tools do not exist.
  const def = p.tools[tool];
  if (!def) {
    return decide(p, DECISION.DENY, 'unknown_tool', `Tool "${tool}" is not offered by this server.`);
  }

  const writes = def.access === 'write';

  // Global read-only switch.
  if (writes && !p.writeEnabled) {
    return decide(p, DECISION.DENY, 'writes_disabled', 'Write operations are disabled (writeEnabled: false).');
  }

  // Path guard, in addition to the check in the ADT client.
  if (params.path !== undefined && params.path !== null) {
    const requested = String(params.path);
    if (!requested.startsWith(p.pathPrefix)) {
      return decide(p, DECISION.DENY, 'path_outside_adt', `Path "${requested}" is outside ${p.pathPrefix}.`);
    }
  }

  // Object-scoped checks. Missing details cannot be checked, so they are denied.
  if (def.objectScoped) {
    const { objectName, objectType } = params;
    const pkg = params.package;

    if (!objectName) {
      return decide(p, DECISION.DENY, 'object_unresolved', 'Object could not be resolved in the SAP system.');
    }

    const ns = namespaceOf(objectName);
    if (!p.allowedNamespaces.includes(ns)) {
      return decide(p, DECISION.DENY, 'namespace_not_allowed',
        `Object "${objectName}" is in namespace "${ns}"; allowed: ${p.allowedNamespaces.join(', ') || 'none'}.`);
    }

    if (!objectType) {
      return decide(p, DECISION.DENY, 'object_type_unresolved', `Object type of "${objectName}" could not be resolved.`);
    }
    if (!p.allowedObjectTypes.includes(String(objectType).toUpperCase())) {
      return decide(p, DECISION.DENY, 'object_type_not_allowed', `Object type "${objectType}" is not on the allow-list.`);
    }

    if (!pkg) {
      return decide(p, DECISION.DENY, 'package_unresolved', `Package of "${objectName}" could not be resolved.`);
    }
    if (!p.allowedPackages.includes(String(pkg).toUpperCase())) {
      return decide(p, DECISION.DENY, 'package_not_allowed',
        `Package "${pkg}" is not on the allow-list (${p.allowedPackages.join(', ') || 'none'}).`);
    }
  }

  // Separation of duties: whoever develops does not approve.
  if (def.separationOfDuties) {
    const approver = String(params.approver ?? '').toUpperCase();
    if (!approver) {
      return decide(p, DECISION.DENY, 'approver_missing', 'No approver given; separation of duties cannot be checked.');
    }
    const executor = String(user ?? p.identity.developer).toUpperCase();
    if (approver === executor) {
      return decide(p, DECISION.DENY, 'self_approval', `"${approver}" cannot approve their own changes.`);
    }
    if (!p.identity.approvers.includes(approver)) {
      return decide(p, DECISION.DENY, 'approver_not_listed', `"${approver}" is not a configured approver.`);
    }
  }

  // Human approval: the call returns a request instead of executing.
  if (def.requiresApproval) {
    return decide(p, DECISION.APPROVAL_REQUIRED, 'approval_required',
      `"${tool}" requires human approval and is not executed by the agent.`);
  }

  return decide(p, DECISION.ALLOW, 'allowed',
    writes ? 'All checks passed; write access inside the allowed scope.' : 'All checks passed; read access.');
}
