# ct-lean never-cut list (CLEO edition)

Lean means less *unrequested* code. These are always in scope, however small the task.

| Never cut | Why | CLEO enforcement |
|---|---|---|
| Validation at trust boundaries | Input from users, agents, harness hooks and synced peers is untrusted | Zod schemas in `packages/contracts`; sync write invariants (gate 38) |
| Error handling that prevents data loss | A silent catch around a store write loses rows | `catch (err: unknown)` is banned; killed writes have unknown outcome |
| Security | Secrets, shell quoting, path traversal | `tool:security-scan` evidence; no secrets in output |
| Evidence | A gate without programmatic proof is self-attestation | `cleo verify --gate … --evidence …` (ADR-051), re-validated at `cleo complete` |
| Type safety | `any` and cast chains hide the bug the type would have caught | Project rule; shared types live in `packages/contracts/` |
| Package boundary | Code in the wrong package becomes the next relocation task | AGENTS.md boundary table; `cleo check arch` gates 4, 6, 10, 11 |
| Store safety | The DB chokepoint, migrations, backups, tracked identity files | Gates 3, 17, 28, 36, 37; never `git add` `.cleo/*.db` |
| Accessibility | UI that only works for some users is not done | Studio review checks |
| Anything the task or owner asked for | Lean trims extras, never the request | The task's acceptance criteria |

When a lean option conflicts with a row above, the row wins. Say so in the reply's
skipped/risk line instead of silently choosing the bigger diff.
