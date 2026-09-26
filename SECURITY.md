# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Intended use

sap-mcp-server gives an AI agent write access to ABAP development objects. It is meant
for **development and sandbox systems only**.

- Never run it against a production system.
- Use a dedicated SAP user with minimal authorizations, not a personal developer account.
- Use `SAP_PROTOCOL=https` wherever possible. Over HTTP, basic auth sends credentials
  only base64-encoded.
- Review `config/policy.json` before the first start: allow only the sandbox package,
  never `$TMP`.

## Credentials

Credentials belong in `.env` or the environment only. `.env` is excluded by `.gitignore`
and `.dockerignore` and is never built into the container image. CI scans every push
with gitleaks.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub Security Advisories](https://github.com/Maherd18/sap-mcp-server/security/advisories/new).
