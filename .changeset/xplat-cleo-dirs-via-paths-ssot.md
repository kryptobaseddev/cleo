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

The `lint-paths-ssot` baseline drops from 17 to 2 (the remaining two are
CAAMP's third-party harness config dirs, which are correct).

T12608: ADR parsing, skill scanning, federated skill search, import logging,
branch-lock audit dirs, provider memory import and nexus JSON migration used
`split('/')` on absolute paths, which returns the whole path on Windows. They
now use `path.basename` / `path.dirname`, and ADR parsing checks
`path.isAbsolute`. `isUnderRoot` in portable-bundle relocation accepts `/` and
`\` as the boundary, because bundle rows carry the source machine's paths. The
CAAMP `pi cant` / `pi extensions` installers expand `~` with the new
`expandTildePath()` (`os.homedir()`), since `HOME` is unset on Windows.
