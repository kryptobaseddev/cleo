---
id: exit-code-registry-parity
tasks: [T12171]
kind: fix
summary: Register ExitCode.AC_LOCKED and gate the two SSoTs that describe exit codes
---

**gh#1273.** Two SSoTs describe the same thing and nothing asserted they agree:

```
packages/contracts/src/exit-codes.ts   the ExitCode enum   — what a command EXITS with
packages/core/src/error-registry.ts    CLEO_ERROR_REGISTRY — how that code RENDERS
```

A code in the enum and absent from the registry still works as an exit status,
so nothing fails — but `getRegistryEntry()` returns `undefined`, so it carries
no category, no LAFS code, no retryable flag and no HTTP status. `AC_LOCKED`
(48) is a deliberate policy guard with a documented `--reason` override that
writes a real audit entry, and it rendered to the caller like an internal crash.

**The gap is far larger than the report.** The enum declares **97** members; the
registry covered **40**. Fifty-six error codes render without metadata. The
reported one is not special — it is the one somebody happened to hit.

Writing all 56 in one pass would produce 56 guesses at category, retryability
and HTTP status, which is worse than 56 absences. So this registers the reported
one properly and **gates the rest**: the gap is baselined, the list may only
shrink, and a **net-new** enum member without a registry entry fails.

`AC_LOCKED` is registered as `CONTRACT`, not `VALIDATION` — the input is
well-formed and the guard is about *when* a change is allowed, not whether it
parses — with `retryable: false`, because an identical retry is refused
identically. The caller must supply `--reason` or not make the change.

Proven both directions:

```
adding a net-new enum member with no entry   -> FAIL  (ZZ_PROBE_UNREGISTERED=199)
registering AC_LOCKED                        -> 56 unregistered becomes 55,
                                                and the gate says so
```

`SUCCESS = 0` is exempt: it is not an error and has nothing to render.

Deliberately **not** registered in `cleo check arch` / the AGENTS.md gate table
yet — three open PRs already contend for row 21, and adding a fourth would make
the numbering worse. The arch-parity gate joins on script path and passes with
an unregistered script, so this is safe to land and register once the row
numbering settles.

Coverage note: the only suite that exercises the registry
(`lafs-conformance.test.ts`) is in the T12067 quarantine and does not run, so
this change is validated by the gate's own execution and by typecheck rather
than by that suite.
