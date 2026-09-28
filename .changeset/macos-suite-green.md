---
id: macos-suite-green
tasks: [T12550]
kind: fix
summary: The test suite passes on macOS; snapshot inspection, parser-worker cancellation and two lint gates work there
---

The macOS leg of CI (`Unit Tests (macos-latest, …)`, which runs the full
sweep on every push to main) had failed on every main commit, and a local
`pnpm run test` on macOS arm64 failed in six more places that Linux CI never
sees. Each failure was one of three kinds. None was fixed by loosening an
assertion.

Product defects:

- `inspectBackupObservation` (`cleo backup inspect`) refused every platform
  except Linux. Source identity depends only on `O_NOFOLLOW`, which macOS has.
  `O_NOATIME` was already documented as best effort. Inspection now needs
  only `O_NOFOLLOW` and requests `O_NOATIME` where it exists. Platforms
  without `O_NOFOLLOW` (Windows) still fail explicitly. Access-time changes
  are still reported, not restored. Without `O_NOATIME` the inspection's own
  read can advance atime, so the result says so. `source.atimeIsolation` is
  `'noatime'` or `'unavailable'`. When it is unavailable, `atimeChanged` is
  `null` rather than a claim about another reader, and a limitation line
  says the access time may reflect this inspection. On Linux the new
  `atimeIsolation: 'noatime'` key is the only change; every existing value is
  unchanged.
- `cleo backup inspect --record-id` resolves the parent directory of the
  path you pass. macOS `/tmp`, `/var` and `$TMPDIR` are symlinks into
  `/private`, so every snapshot there was refused with a misleading
  "symlink" message. A symlinked snapshot FILE is still refused.
- The parser-worker `stop()` in `spawn-wrapper.ts` threw `kill EPERM` on
  macOS. When a process group has only unreaped zombies left, Darwin's
  `kill(2)` returns EPERM, not ESRCH (measured: the group kill returns EPERM
  while a PID probe still succeeds). Cancelling a parse therefore surfaced
  `Error: kill EPERM` instead of `E_PARSE_CANCELLED`. On darwin, an EPERM
  from the group signal now falls back to signalling the worker PID. That is
  a no-op on a zombie, and it still kills a live worker if something (a
  sandbox) denied only the group signal.
- `lint-claim-sync.mjs` and `lint-agent-outputs-registration.mjs` built
  their entry-point check from `new URL(import.meta.url).pathname`. That
  keeps `%20`, so under `~/Library/Application Support/` `main()` never ran
  and the gate exited 0 without checking anything. Both now use the shared
  `scripts/lib/is-main.mjs`. The `is-main` guard test also catches the
  two-statement form of that idiom now, which it missed before.

Test-harness assumptions:

- Test files derived paths from `URL.pathname` (`nexus` pipeline,
  `nexus-content`, `reconstruct`) or ran unquoted `cat ${path}` through a
  shell (three release-migration tests). All of them break on a path with a
  space. They now use `fileURLToPath` and `readFileSync`, and
  `no-url-pathname-paths.test.mjs` now covers test files as well as vitest
  configs.
- The packed-command descendant-termination test read `/proc/<pid>/stat`
  for process identity. Off Linux, it now reads the same PID plus start
  time, state and command from `ps`. The Linux path is unchanged.

Linux-only, skipped with a reason:

- One `backup-inspect` test isolates ANOTHER reader's access-time change. It
  depends on the fixture's own identity read leaving atime untouched, and
  only `O_NOATIME` guarantees that. It is `skipIf(platform !== 'linux')`, so
  it still runs on Linux.
