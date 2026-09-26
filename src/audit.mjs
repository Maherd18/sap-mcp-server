/**
 * Audit log.
 *
 * Every policy decision is written before the operation runs, including allowed
 * calls and calls let through in dry-run mode, followed by the result of the
 * execution. Format: JSON Lines, append-only, so the log can be processed with
 * standard tools (jq, SIEM import).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Parameter names that never go into the log. */
const SECRET = /^(password|passwd|token|secret|authorization|cookie)$/i;

/** Truncates long values and removes secrets. */
function sanitize(value, maxLength = 400) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') {
    const s = String(value);
    return s.length > maxLength ? `${s.slice(0, maxLength)}…[${s.length} chars]` : s;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, maxLength));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET.test(k) ? '[removed]' : sanitize(v, maxLength);
  }
  return out;
}

export class AuditLog {
  /**
   * @param {string} file     path of the log file
   * @param {boolean} enabled if false, entries are kept in memory only
   */
  constructor(file, enabled = true) {
    this.file = file;
    this.enabled = enabled;
    this.entries = [];
    this.writeErrors = 0;
    this.runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    if (enabled && file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Records a policy decision. */
  decision({ tool, params, decision, effective, enforced, rule, reason, mode, user }) {
    const entry = {
      time: new Date().toISOString(),
      run: this.runId,
      type: 'decision',
      user: user ?? null,
      tool,
      params: sanitize(params),
      // `decision` is what the policy concluded, `effective` is what actually
      // happens. They differ only in dry-run mode, which shows what a policy
      // would have blocked.
      decision,
      effective: effective ?? decision,
      enforced: enforced ?? true,
      rule: rule ?? null,
      reason,
      mode,
    };
    this.write(entry);
    return entry;
  }

  /** Records the outcome of an executed operation. */
  result({ tool, success, message, durationMs }) {
    this.write({
      time: new Date().toISOString(),
      run: this.runId,
      type: 'result',
      tool,
      success,
      message: message ? sanitize(message, 600) : null,
      durationMs: durationMs ?? null,
    });
  }

  write(entry) {
    this.entries.push(entry);
    if (!this.enabled || !this.file) return;
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // A failed log write must not stop the server, but it is counted.
      this.writeErrors++;
    }
  }

  /** Reads a log file back, skipping malformed lines. */
  static read(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }
}
