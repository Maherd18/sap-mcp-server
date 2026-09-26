/**
 * Configuration.
 *
 * Credentials come from environment variables or a local .env file. They are
 * never logged and never included in error messages. .env is excluded via
 * .gitignore and .dockerignore.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');

/** Minimal .env parser: KEY=VALUE, # starts a comment, quotes optional. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip trailing inline comments ("VALUE   # comment") unless quoted.
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = readEnvFile(ENV_FILE);
const pick = (key, fallback) => process.env[key] ?? fileEnv[key] ?? fallback;

export const config = {
  root: ROOT,
  envFile: ENV_FILE,

  sap: {
    host: pick('SAP_HOST', ''),
    port: Number(pick('SAP_PORT', '8000')),
    protocol: pick('SAP_PROTOCOL', 'http'),
    client: pick('SAP_CLIENT', ''),
    user: pick('SAP_USER', ''),
    password: pick('SAP_PASSWORD', ''),
    language: pick('SAP_LANGUAGE', 'EN'),
  },

  http: {
    timeoutMs: Number(pick('SAP_TIMEOUT_MS', '30000')),
    // The client never requests anything outside this path.
    basePath: '/sap/bc/adt',
  },
};

/** Base URL without trailing slash. */
export function baseUrl() {
  const { protocol, host, port } = config.sap;
  return `${protocol}://${host}:${port}`;
}

/** Returns the names of missing settings without revealing any secret. */
export function validateConfig() {
  const missing = [];
  if (!config.sap.host) missing.push('SAP_HOST');
  if (!config.sap.client) missing.push('SAP_CLIENT');
  if (!config.sap.user) missing.push('SAP_USER');
  if (!config.sap.password) missing.push('SAP_PASSWORD');
  if (!Number.isFinite(config.sap.port)) missing.push('SAP_PORT');
  return missing;
}

/** Configuration overview for console output. The password is never shown. */
export function safeSummary() {
  return {
    url: config.sap.host ? baseUrl() : '(not set)',
    client: config.sap.client || '(not set)',
    user: config.sap.user || '(not set)',
    password: config.sap.password ? `set (${config.sap.password.length} chars)` : 'MISSING',
    language: config.sap.language,
    timeoutMs: config.http.timeoutMs,
  };
}
