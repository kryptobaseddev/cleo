---
id: t13493-preflight-stdout-guard
tasks: [T13493]
kind: test
summary: "Guard test: worktree preflight progress goes to stderr only, so spawn stdout stays one LAFS envelope"
---
axiom reported a `[worktree-preflight]` line ahead of the spawn envelope on stdout (axiom T1797). It does not reproduce on 2026.10.6. A sandboxed spawn whose install runs prints both preflight lines on stderr, and its stdout parses as exactly one envelope. The source writes every preflight line with `process.stderr.write`.

These tests pin that behaviour: the node_modules install path and the `core.worktree` leak heal both write their notices to stderr and nothing to stdout (ADR-086).
