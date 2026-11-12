# Security policy

Flow AI is a hackathon MVP. It runs on XRPL Testnet only and moves no real value. It is not production software and has not had an independent security audit.

## Testnet only

- Do not point any part of this project at Mainnet, and do not configure the Mainnet RLUSD issuer. The code refuses to start unless the network is `xrpl-testnet`, the WebSocket URL is on an exact Testnet allowlist and the server reports `network_id` 1.
- Never use a seed, key or API key that controls real funds or paid services with this repository.

## Never commit secrets

- Seeds, private keys, API keys, tokens and `.env` files must never be committed, pasted into issues or pull requests, or shared in chat. `.env*` (except `.env.example`) and `.secrets/` are gitignored.
- Run `pnpm secret-scan` before committing. Install the versioned pre-commit hook once per clone with `pnpm setup:hooks` (opt-in; it sets `core.hooksPath` for that clone only).
- If a real secret was ever committed or shared, treat it as compromised: rotate it and replace the account. Removing it from history is not enough.

## Reporting a vulnerability

Please report privately. Do not open a public issue for a vulnerability.

- Use GitHub private vulnerability reporting for this repository (Security tab, "Report a vulnerability"), or contact the maintainers privately through the channel listed on the repository profile.
- Include what you found, steps to reproduce, the affected file or endpoint, and the impact you expect. Do not include real secrets in the report.
- We aim to acknowledge reports within 5 working days. This is a best-effort, unfunded project, and there is no bug bounty.

## Scope and known limitations

In scope: code in this repository. Out of scope: XRPL Testnet itself, the Ripple faucet, third-party services and dependencies (report those upstream).

Known limitations are tracked in [`docs/security-review.md`](docs/security-review.md) and, from M8, `docs/threat-model.md`. Binding rules for new code are in [`docs/secure-coding-standards.md`](docs/secure-coding-standards.md).
