# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Require Node.js 22 or later; container image based on Node.js 24
- Update GitHub Actions to current major versions

### Fixed

- Audit log keeps numbers and booleans as JSON types instead of writing them as strings
  (e.g. `"found": true` instead of `"found": "true"`)

### Documentation

- npx setup: pass credentials as environment variables and set `SAP_MCP_AUDIT_FILE`,
  otherwise the audit log ends up in the npm cache

## [0.3.0] - 2026-09-26

First public release.

### Added

- MCP server over stdio with eight tools for ABAP development objects via ADT
- Policy engine with package, namespace and object type allow-lists, read-only switch,
  human approval, separation of duties and `enforce` / `dry-run` modes
- Audit log of every decision and result as JSON Lines
- Container image (`ghcr.io/maherd18/sap-mcp-server`) and `npx` support
- `SAP_MCP_POLICY_FILE` and `SAP_MCP_AUDIT_FILE` environment variables
- Connection check and sandbox setup scripts
- Tests for the policy, the MCP handshake and the tool path against a simulated ADT endpoint

[Unreleased]: https://github.com/Maherd18/sap-mcp-server/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Maherd18/sap-mcp-server/releases/tag/v0.3.0
