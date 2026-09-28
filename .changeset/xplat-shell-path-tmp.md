---
id: xplat-shell-path-tmp
tasks: [T12604, T12605, T12606]
kind: fix
summary: agent spawns, evidence runs, worktree hooks, the git shim and prompt files now work on Windows (no sh/which/rm/tar, ';' PATH, os.tmpdir())
---

Several runtime paths assumed a POSIX host. On Windows that broke them outright:

- **Spawn wrappers (T12604).** `buildSpawnArgs` (core) and `buildAgentSpawnArgs`
  (adapters) wrapped every command in `sh -c 'ulimit -c 0; exec "$@"'` when
  systemd-run was absent, so every agent spawn and `tool:test` evidence run
  failed with ENOENT. On win32 the command is now spawned directly. Windows
  writes no core files, so no suppression is needed there. POSIX keeps the
  ulimit wrapper.
- **Shell-outs (T12604).** Worktree hooks and release build commands now run
  through a single resolver, `shellInvocation` in `@cleocode/paths`: `/bin/sh -c`
  on POSIX and `%ComSpec% /d /s /c` on Windows. `which` probes (`commandExists`,
  dependency and runtime checks, adapter discovery, issue diagnostics, release
  artifacts, fs-harden detection, and every provider adapter's `healthCheck`/
  `canSpawn` — claude-code, codex, gemini-cli, kimi, opencode, pi including
  pi's `test -x`) now use `findOnPath`, so providers no longer all report
  "cannot spawn" on Windows. A source-scan test fails on any new `which`/
  `test -x` shell-out in the in-scope packages. `rm -f index.lock` is
  replaced by `fs.rmSync`. The worktree-orphan, GC-quarantine and skills
  migration archives use the bundled `tar` library. The quarantine archives
  symlinks as links (a cycle used to raise ELOOP), keeps the old 120s bound,
  and removes a partial archive on failure.
- **PATH (T12605).** The git-shim PATH was built as `${shimDir}:${PATH}`. On
  Windows that fused the shim dir with the first real entry and dropped both,
  so branch protection was silently absent. PATH is now composed with the
  platform delimiter under the existing `Path`/`PATH` key. `findOnPath` honours
  `PATHEXT`, so `cleo-dev.cmd` is found. On win32 the shim installs `git.cmd`
  plus an sh launcher instead of an extensionless symlink. The shim resolves
  real Git as `git.exe` there.
- **Temp paths (T12606).** The claude-code, codex and pi adapters wrote prompts
  to a literal `/tmp/…`. Each prompt now goes to a `mkdtemp` directory under
  `os.tmpdir()`, removed after the child exits. The prod-DB test guard, doctor
  temp classification and bundle export filter now share `isEphemeralPath`,
  which uses realpath and `path.relative` and takes an injectable platform.

Not changed: `captureWrapped` still refuses to run on Windows, because
process-group containment is unavailable there. `cleo-os` harness `/tmp` and
`which` sites are out of scope (for example `cleo-os/src/commands/doctor.ts`
`which cleo`). Provider CLIs installed as `.cmd` shims still need a shell to
spawn on Windows; that is left for a follow-up.
