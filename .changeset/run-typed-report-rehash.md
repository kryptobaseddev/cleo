---
id: run-typed-report-rehash
tasks: [T14056]
kind: fix
summary: "verify --run-typed refuses a write whose typed gate rewrote the test-run report it cites"
---

`cleo verify --run-typed` validated and hashed a `test-run:` (or `qa-run:`)
report before it executed the typed gates. When a gate command rewrote that
same file, the write recorded the old hash, so the evidence named bytes that
no longer existed and `cleo complete` later refused it as modified. After the
typed gates run, every report the write validated is re-hashed; a changed or
removed report refuses the write with `E_EVIDENCE_STALE`, naming the report
and the two-step remedy: run the typed gates with `cleo verify <id> --run`,
then record the write without `--run-typed` so it validates the report they
wrote. Nothing is recorded from the refused write.
