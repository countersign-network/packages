# Security Policy

Countersign is a control plane for AI agents that spend money — security is the product. We take
reports seriously.

## Status

This repository is a **testnet-only proof** and has **not** been independently security-audited.
Do **not** use it with mainnet funds or real custody. (Prime directive #6: testnet only.)

## Reporting a vulnerability

Please report privately — do **not** open a public issue:

- Email **support@countersign.network** with `[countersign-security]` in the subject, or
- Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability).

Include a description, affected component (package/file), and reproduction steps. We aim to
acknowledge within 72 hours.

## Scope of particular interest

The invariants that, if broken, are the most serious:

1. **Fail-open** — any path where "no decision / no backend response" results in a spend being
   allowed instead of denied (must always default-deny).
2. **Freeze that silently doesn't stop an agent** — a freeze reported as confirmed while the agent
   can still spend.
3. **Ledger tampering** — a way to alter, delete, or reorder ledger entries without `verify()`
   detecting it.
4. **Policy-compiler mismatch** — a unified policy that lowers to a *weaker* native control than it
   specifies on any backend.
5. **Key handling** — any place keys are reconstructed or leave a vendor TEE/MPC boundary (Countersign
   must never hold or rebuild keys — prime directive #1).

## Please do not

- Test against third parties' wallets or live funds.
- Run denial-of-service against any backend.
