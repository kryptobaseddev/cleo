---
id: t13159-exit-path-preload
tasks: [T13159]
kind: fix
summary: A long-running cleo command that outlives an in-place upgrade keeps its exit code instead of crashing after its work is done; CLI chunk names may use any case
---

The CLI is code-split (T13126), so the teardown that runs after every successful command
(`@cleocode/core/shutdown`) and the error renderer were imported only once the command
had returned. An in-place upgrade (`npm i -g`, `cleo self-update`) replaces the package
directory, hashed chunks and all, so a command still running across it (`cleo run --wait`
holds for up to 30 minutes, an evidence run for minutes) crashed with
`ERR_MODULE_NOT_FOUND` AFTER its child had finished: `cleo run -- <cmd>` exited 1 with a
stack trace although the command succeeded.

- The exit path (teardown, shutdown deadline, error renderer) is now imported when the
  command is dispatched, while its files are certainly there, and served from memory when
  the command ends. Measured: with the teardown modules removed mid-run, `cleo run` now
  exits with the child's code (0); before, it exited 1 with `ERR_MODULE_NOT_FOUND`.
- If a needed module is still missing, the CLI prints one line instead of a stack trace:
  that CLEO was upgraded from one version to another while the command ran (or, when the
  version did not change, to reinstall), keeping the command's exit code on success.
- `CLEO_CLI_CHUNK_PATTERN` (the shipped-artifact check) accepts a source basename in any
  case, so a module named `TaskCard.ts` no longer fails the artifact check.
