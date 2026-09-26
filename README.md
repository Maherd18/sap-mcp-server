# sap-mcp-server

[![CI](https://github.com/Maherd18/sap-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Maherd18/sap-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

An [MCP](https://modelcontextprotocol.io) server that lets AI agents read and write SAP ABAP
development objects through the ADT REST API, **with guardrails that live in the server**.

Every tool call is checked against a policy before anything reaches SAP: which packages,
namespaces and object types the agent may touch, whether writes are enabled at all, and
which actions need a human. Every decision is written to an audit log. The agent can't
talk its way around the policy, because the rules are read from a file it has no access
to, and object details are looked up in SAP instead of trusted from the agent.

- **Package, namespace and object type allow-lists.** `$TMP` and SAP standard objects are off-limits by default.
- **Read-only switch.** One setting turns off all writes.
- **Human approval** for activation and transport release. The agent gets an approval request, nothing is executed.
- **Separation of duties.** The developer can't approve their own transport.
- **Audit log** of every decision and result as JSON Lines.
- **Dry-run mode** to try a new policy before enforcing it.
- **Zero dependencies.** Plain Node.js, runs via Docker or `npx`.

> [!WARNING]
> Use this only against development or sandbox systems, never against production.
> See [Security](#security).

## Contents

- [Quick start](#quick-start)
- [Client setup](#client-setup)
- [Configuration](#configuration)
- [Policy](#policy)
- [Tools](#tools)
- [Audit log](#audit-log)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Quick start

You need an SAP system with the ADT services active (`/sap/bc/adt` in transaction SICF)
and a development user. Create a `.env` file with your connection details:

```bash
curl -fsSL https://raw.githubusercontent.com/Maherd18/sap-mcp-server/main/.env.example -o .env
# edit .env: SAP_HOST, SAP_PORT, SAP_CLIENT, SAP_USER, SAP_PASSWORD
```

**Docker (recommended)**

```bash
# check the connection
docker run --rm --env-file .env ghcr.io/maherd18/sap-mcp-server scripts/check-connection.mjs

# run the server (MCP over stdio, so -i is required)
docker run -i --rm --env-file .env -v sap-mcp-audit:/data ghcr.io/maherd18/sap-mcp-server
```

**npx** (Node.js 22 or later, credentials as environment variables)

```bash
npx -y github:Maherd18/sap-mcp-server
```

**From source**

```bash
git clone https://github.com/Maherd18/sap-mcp-server.git
cd sap-mcp-server
cp .env.example .env    # fill in your values
npm run check           # step-by-step connection check
npm start
```

No `npm install` needed.

### Create a sandbox package

The default policy only allows writes in the package `ZMCP_SANDBOX`. If it doesn't
exist yet, create it once:

```bash
npm run setup:sandbox                 # dry run
npm run setup:sandbox -- --create     # create it
```

Options: `--name`, `--swcomp` (software component, default `HOME`), `--layer` (transport layer).

## Client setup

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "sap-adt": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/absolute/path/to/.env",
        "-v", "sap-mcp-audit:/data",
        "ghcr.io/maherd18/sap-mcp-server:latest"
      ]
    }
  }
}
```

**Claude Code**

```bash
claude mcp add sap-adt -- docker run -i --rm --env-file /absolute/path/to/.env -v sap-mcp-audit:/data ghcr.io/maherd18/sap-mcp-server:latest
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "sap-adt": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "--env-file", "${workspaceFolder}/.env", "ghcr.io/maherd18/sap-mcp-server:latest"]
    }
  }
}
```

More variants (npx, local checkout) are in [`examples/`](examples/).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SAP_HOST` | – | Application server host (required) |
| `SAP_PORT` | `8000` | ICM port |
| `SAP_PROTOCOL` | `http` | `https` or `http` |
| `SAP_CLIENT` | – | Client, e.g. `100` (required) |
| `SAP_USER`, `SAP_PASSWORD` | – | Development user (required) |
| `SAP_LANGUAGE` | `EN` | Logon language |
| `SAP_TIMEOUT_MS` | `30000` | HTTP timeout |
| `SAP_MCP_POLICY_FILE` | `config/policy.json` | Path to your own policy |
| `SAP_MCP_AUDIT_FILE` | `logs/audit.jsonl` | Audit log target (`/data/audit.jsonl` in Docker) |

Settings are read from the environment first, then from `.env` in the project directory.

## Policy

The policy is a JSON file, [`config/policy.json`](config/policy.json) by default.
In Docker, mount your own: `-v "$PWD/policy.json:/app/config/policy.json:ro"`.

```json
{
  "mode": "enforce",
  "identity": { "developer": "", "approvers": ["LEAD_DEV"] },
  "allowedNamespaces": ["Z", "Y"],
  "allowedPackages": ["ZMCP_SANDBOX"],
  "allowedObjectTypes": ["PROG/P", "CLAS/OC", "INTF/OI", "TABL/DT", "FUGR/F"],
  "writeEnabled": true,
  "tools": {
    "sap_write_source": { "access": "write", "objectScoped": true },
    "sap_activate": { "access": "write", "objectScoped": true, "requiresApproval": true }
  }
}
```

| Key | Description |
|---|---|
| `mode` | `enforce` blocks denied calls. `dry-run` logs the decision but lets the call through. |
| `identity.developer` | SAP user the agent works as. Empty means `SAP_USER`. |
| `identity.approvers` | Users allowed to approve a transport release. Must not include the developer. |
| `allowedNamespaces` | Allowed name prefixes, e.g. `Z`, `Y` or `/ACME/`. |
| `allowedPackages` | Packages the agent may read and write. Keep `$TMP` out. |
| `allowedObjectTypes` | ADT object types, e.g. `CLAS/OC`. |
| `writeEnabled` | `false` makes the server read-only. |
| `tools` | The tool allow-list. A tool that isn't listed doesn't exist. Per tool: `access` (`read`/`write`), `objectScoped`, `requiresApproval`, `separationOfDuties`. |
| `auditLog` | `enabled` and `file`. |

Anything not explicitly allowed is denied, including objects that can't be found.
When a call is denied, the agent gets the rule name and a reason:

| Rule | When |
|---|---|
| `unknown_tool` | The tool isn't in the policy |
| `writes_disabled` | Write call while `writeEnabled` is `false` |
| `path_outside_adt` | Request outside `/sap/bc/adt` |
| `object_unresolved` | Object not found in the system |
| `namespace_not_allowed` | Object name outside `allowedNamespaces` |
| `object_type_not_allowed` | Object type outside `allowedObjectTypes` |
| `package_not_allowed` | Package outside `allowedPackages` |
| `approval_required` | Tool needs human approval |
| `approver_missing`, `self_approval`, `approver_not_listed` | Separation of duties violated |

## Tools

| Tool | Access | Description |
|---|---|---|
| `sap_test_connection` | read | Checks the connection, reports user, client and ADT resources |
| `sap_search_objects` | read | Searches repository objects by pattern |
| `sap_read_metadata` | read | Type, package, owner and version of an object |
| `sap_read_source` | read | Source code of an object |
| `sap_list_transports` | read | Open transport requests of the user |
| `sap_write_source` | write | Replaces the source of an existing object (lock, write, unlock) |
| `sap_activate` | write | Activates an object, requires approval |
| `sap_release_transport` | write | Releases a transport, requires approval and separation of duties |

There is intentionally no tool to delete or create objects. People create objects, the
agent changes existing ones.

## Audit log

Every call produces a `decision` entry before execution and a `result` entry afterwards:

```json
{"time":"2026-09-26T10:15:02.114Z","run":"2026-09-26T10-14-58-001Z-4127","type":"decision","user":"DEV_USER","tool":"sap_write_source","params":{"requested":{"object_name":"ZCL_OTHER","lines":42},"resolved":{"found":true,"objectName":"ZCL_OTHER","objectType":"CLAS/OC","package":"ZOTHER_PACKAGE"}},"decision":"deny","effective":"deny","enforced":true,"rule":"package_not_allowed","reason":"Package \"ZOTHER_PACKAGE\" is not on the allow-list (ZMCP_SANDBOX).","mode":"enforce"}
```

`decision` is what the policy concluded, `effective` is what actually happened. They only
differ in `dry-run` mode. Passwords, tokens and cookies are never logged.

```bash
# all denied calls
jq 'select(.type=="decision" and .effective!="allow")' logs/audit.jsonl
```

## Security

- **Development and sandbox systems only.**
- **Use a dedicated SAP user** with minimal authorizations (`S_DEVELOP` restricted to the sandbox package), not a personal developer account.
- **Use HTTPS.** With plain HTTP, basic auth sends credentials only base64-encoded.
- **Review `config/policy.json`** before the first start. Allow only the sandbox package.

The server has no dependencies on purpose: less supply-chain risk for something with write
access to your development system. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Troubleshooting

Run `npm run check` (or the Docker variant from the quick start) first. It checks
configuration, network, login, search and source access step by step.

| Symptom | Cause and fix |
|---|---|
| `401` on login | Wrong user or password, or the user is locked. |
| `403` on login | Logon works but authorizations are missing (`S_DEVELOP`, `S_ADT_RES`). |
| `404` on `/sap/bc/adt/discovery` | ADT service not active. Activate `/sap/bc/adt` in SICF. |
| TLS error with HTTPS | Self-signed or internal CA. Set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. |
| Host not reachable from Docker | For a system on your own machine use `host.docker.internal` as `SAP_HOST`. |
| `PAK 134` when adding objects to a package | ADT's `pak:isAddingObjectsAllowed` is inverted: `true` blocks adding objects. `setup:sandbox` sets `false`. |
| `HTTP 409` on write | Object is locked in another transport. The server always uses the transport from the lock response. |
| Activation fails on a locked object | Activation takes its own lock. The server releases its edit lock before activation. |
| HTTP 500 on create, but the object exists | ADT sometimes reports an error after creating the object. Check for the object before retrying. |

## Limitations

- Write path tested with ABAP classes; other object types may need adjustments.
- Transport release is never executed; the tool exists to show that the policy stops it.
- Separation of duties checks against `identity.approvers` in the policy, not against SAP authorizations.
- One SAP system per server instance.

## Development

```bash
npm test          # unit and integration tests, no SAP system needed
```

The tests cover the policy rules, the MCP handshake over stdio and the full tool path
against a simulated ADT endpoint.

```
src/
  server.mjs       MCP entry point (JSON-RPC over stdio)
  tools.mjs        tool definitions, single execution path
  policy.mjs       policy engine
  adt-client.mjs   ADT REST client with path guard
  audit.mjs        audit log
  config.mjs       configuration from environment / .env
config/policy.json default policy
scripts/           connection check, sandbox setup
test/              tests (node:test)
```

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Related projects

[sap-ai-mcp-servers](https://github.com/marianfoo/sap-ai-mcp-servers) keeps an up-to-date
list of MCP servers for SAP, including several for ABAP and ADT.

## License

[MIT](LICENSE)
