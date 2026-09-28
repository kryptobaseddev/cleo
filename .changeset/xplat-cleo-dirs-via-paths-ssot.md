---
id: xplat-cleo-dirs-via-paths-ssot
tasks: [T12602, T12608]
kind: fix
summary: CLEO data, state and worktree dirs resolve through @cleocode/paths on macOS and Windows; OS paths are no longer split on '/'
---

Fourteen sites built CLEO's own directories as `$XDG_* ?? ~/.local/share/cleo`
(or `~/.local/state/cleo`) on every OS. On macOS `getCleoHome()` is
`~/Library/Application Support/cleo` and on Windows `%LOCALAPPDATA%\cleo\Data`,
so those sites read or wrote a second tree the rest of CLEO never sees.

- `cleo gc worktrees` and the doctor orphan-worktree audit scanned an empty
  `~/.local/share/cleo/worktrees` on macOS and reported nothing. Both now use
  `getCleoWorktreesRoot()`, where `cleo orchestrate spawn` provisions.
- The adapters' legacy `anthropic-key` tier, the LLM catalog cache, the CANT
  global/user tiers and `CLEOOS-IDENTITY.md` (adapters and the cleo-os
  extension) resolve through `getCleoHome()` / the CLEO config dir. The cleo-os
  extension drops those tiers when `@cleocode/paths` cannot load instead of
  guessing a Linux path.
- The CleoOS hub `cant-bridge.ts` template finds global agents under the CLEO
  home it was installed into.
- New `getCleoStateDir()` in `@cleocode/paths`: `$XDG_STATE_HOME/cleo` on
  Linux, `<getCleoHome()>/state` on macOS and Windows. Used for nexus
  deprecation telemetry, the nexus cleanup audit log and the dialectic
  failure cache.
- `install-daemon-service.mjs` uses `getCleoPlatformPaths()` instead of a
  hand-copied env-paths fallback, anchors the launchd plist on `homedir()`
  (a `CLEO_HOME` override used to move it out of `~/Library/LaunchAgents`),
  and parses again: an unescaped backtick inside the cleo.slice template
  literal had made the whole script a syntax error since T11993.
- `playbook.ts`'s `~/.local/share/cleo/playbooks` branch was unreachable and
  is removed; the core resolver already used `getCleoHome()`.

Behaviour changes to know about:

- **Linux:** the nexus-deprecation telemetry and the `nexus projects clean`
  audit log were written to a hard-coded `~/.local/state/cleo`. They now
  honour `XDG_STATE_HOME`. With it unset, the path is unchanged.
- **macOS and Windows:** `.cant` files under `~/.local/share/cleo/cant` and
  `~/.config/cleo/cant` are no longer read. The new `legacy_cant_dirs` check
  in `cleo doctor` warns when those dirs still hold `.cant` files and names
  where to move them. The cleo-os extension warns once per process when it
  cannot load `@cleocode/paths` and skips the global/user tiers.

The `lint-paths-ssot` baseline drops from 17 to 2 (the remaining two are
CAAMP's third-party harness config dirs, which are correct).

T12608: ADR parsing, skill scanning, federated skill search, import logging,
branch-lock audit dirs, provider memory import and nexus JSON migration used
`split('/')` on absolute paths, which returns the whole path on Windows. They
now use `path.basename` / `path.dirname`, and ADR parsing checks
`path.isAbsolute`. Portable-bundle relocation (`isUnderRoot` / `relocatePath`)
accepts `/` and `\` as the boundary, because bundle rows carry the source
machine's paths. It ignores a trailing separator on either root (so a bundle
rooted at `/` or `D:\` no longer drops the separator), writes the remainder
with the destination's separator (a Windows bundle relocated onto macOS or
Linux gets `/a/b`, not the single filename `a\b`), and resolves `..`, so
`proj/../../etc/passwd` is not treated as under `proj`. Windows-shaped path
values are now recognised as absolute, where only `/`-prefixed ones were. The
CAAMP `pi cant` / `pi extensions` installers expand `~` with the new
`expandTildePath()` (`os.homedir()`), since `HOME` is unset on Windows.
