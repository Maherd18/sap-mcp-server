# Contributing

Thanks for your interest in sap-mcp-server. Bug reports, ideas, documentation and code
are all welcome.

## Before you start

- **Security issues:** please don't open a public issue. See [SECURITY.md](SECURITY.md).
- For larger changes, open an issue first so we can agree on the direction.
- Never post credentials, hostnames, clients, user names or customer package names in
  issues, logs or code. Use placeholders like `ZMCP_SANDBOX` or `DEV_USER`.

## Development setup

```bash
git clone https://github.com/Maherd18/sap-mcp-server.git
cd sap-mcp-server
npm test    # no SAP system needed
```

Node.js 22 or later, plain ESM, **no npm dependencies**. Please keep it that way: every
dependency adds supply-chain risk to a server with write access to development systems.

To try changes against a real system, copy `.env.example` to `.env` and run `npm run check`.

## Guidelines

- **Every tool call goes through the policy.** Pull requests that add a second path to
  the ADT client won't be merged.
- **New tools** need an entry in `config/policy.json`, a row in the tools table of the
  README, and tests.
- **New rules** belong in the policy file, not in hard-coded logic, and need a
  descriptive rule name.
- **Deny by default**, also on errors: if a detail is missing, deny.
- Add user-facing changes to [CHANGELOG.md](CHANGELOG.md) under "Unreleased".

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change and run `npm test`.
3. Open a pull request describing what changed, why, and how you tested it.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
