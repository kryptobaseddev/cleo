---
id: gh1366-readiness-gate-value-and-timeout
tasks: [T12193]
kind: fix
summary: "release plan's readiness result is a value its caller branches on, and a lint timeout no longer reports itself as malformed changesets (gh#1366, gh#1367)"
---

Two coupled defects on the release path. Landing either alone is a regression:
fixing the enforcement while the gate still fails spuriously would block every
release with a message that misdirects the fix.

## gh#1366 — the envelope and the exit code disagreed

`runSpawnReadinessHygieneCli` reported failure by setting `process.exitCode = 1`
and returning normally. Its caller in `release.ts` carried the comment:

```ts
await runSpawnReadinessHygieneCli();
// If we reach here, all gates passed (runSpawnReadinessHygieneCli exits on failure)
```

Control always reached there. So `cleo release plan` ran past a failed readiness
gate, planned the release, and wrote `success: true` to stdout, while the
exitCode surfaced as `rc=1` at the process boundary. Both readings are consumed
by automation — `release-prepare.yml` gates on the exit code, `CLEO-INJECTION.md`
instructs every spawned agent to gate on the envelope — so the pipeline's answer
depended on which consumer asked.

- `runSpawnReadinessHygieneCli` now returns `SpawnReadinessResult`.
- `SpawnReadinessResult` gains `hasBlockingFailure` and `blockingGates`, derived
  from severity. `allPassed` ignored severity, so a `warn`-severity gate could
  not be distinguished from a blocking one.
- `release plan` branches on the returned value and emits `success: false` with
  `codeName: E_READINESS_GATE_FAILED` and exit code 6. Envelope and exit code now
  agree in every branch. `--skip-readiness` is unchanged.
- The false comment is deleted.
- It no longer forces `process.exitCode = 0` on success, which would have cleared
  a failure code set earlier in the same process.

## gh#1367 — a timeout wearing a validation failure's message

`execSync` on timeout throws `ETIMEDOUT`, and the handler interpolated it into
`Changeset lint failed: <stderr>` — telling operators their changesets were
malformed when none had been examined. The remedy that message implies cannot
succeed, so someone would eventually "fix" a valid changeset to silence it.

Gate results now carry a `reason` (`validation | timeout | not-found | io-error`)
and a timeout says so explicitly. The discriminator was measured rather than
assumed: a timeout gives `code=ETIMEDOUT`, `signal=SIGTERM`, `status=null`, while
a real lint failure gives a numeric `status` and no signal.

**The bound stays at 10 s.** The issue argued for raising it from a 91,061 ms
measurement over 275 entries, concluding the gate "is expected to fail on every
invocation, on every machine, indefinitely". That does not survive
re-measurement. The 91 s was taken while the repo lived on an ntfs-3g FUSE mount
and it measured the filesystem, not the script. Over 315 entries — more than the
original run:

| environment | wall |
|---|---|
| btrfs (canonical checkout) | 0.54 s |
| GitHub Actions runner | 1.60 s |
| ntfs-3g, cold page cache | 346.69 s |

The cold NTFS run consumed 5.39 s of CPU across 346.69 s of wall clock — 1.6% CPU,
the rest blocked on the FUSE daemon. A test asserts the bound **equals** 10 s so a
future reader cannot re-raise it on the strength of the retracted number.
`CLEO_CHANGESET_LINT_TIMEOUT_MS` overrides it, and an invalid override is
rejected rather than silently replaced by the default.

## Why `lint-changesets.mjs` got faster anyway

Runtime is ~96% module loading, not parsing:

| | |
|---|---|
| parse 315 entries | 65.9 ms (0.21 ms/entry) |
| `dist/index.js` barrel import | 1750.4 ms |
| `dist/changesets/index.js` import | 605.4 ms |

The script pulled the full 1266-module core barrel in to reach one parser — the
cost arch gate 19 ratchets in the CLI. It now imports the deep changesets module:
1.07–1.35 s to 0.54 s on btrfs, and 346.69 s to 7.47 s on the cold NTFS case. A
missing or renamed export now fails loudly instead of being collected as N
invalid changesets, which would be a tooling break wearing a content failure's
costume — the same shape as the defect above.

The per-entry figure is what matters for the bound: at 0.21 ms/entry, 10,000
changesets would add ~2 s.
