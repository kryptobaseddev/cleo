---
id: link-or-copy-xplat
tasks: [T12607, T12603]
kind: fix
summary: Every CLEO link creation goes through one linkOrCopy helper (junction on Windows, verified, copy fallback); skills and federation reads stop resolving through ~/.cleo
---

**T12607.** `@cleocode/paths` now exports `linkOrCopy(target, link, kind)`. It
returns `symlink`, `junction` or `copy`.
- **Directories** get a junction on win32, which needs no Developer Mode or admin
  rights. Everything else gets a symlink.
- **Verification:** after creating the link, it checks that the link resolves.
- **Copy fallback:** if linking throws, or the link does not resolve, it copies
  the target instead. `fallback: 'none'` turns the copy off for targets that are
  too large to copy.
- **Dangling links:** an existing link is found with `lstat`, so a dangling link
  gets replaced instead of causing `EEXIST`.
- **Real files:** a real file or directory is replaced only when `overwrite` is
  passed.

The helper is now used at these sites:
- **skills doctor-bridge:** per-skill links and the `~/.agents/skills` bridge.
- **LLM catalog cache:** `latest.json`. Before this change it was never written
  on Windows, and a dangling one was never replaced.
- **Portable bundle import:** bundle symlinks. A failure used to abort the whole
  import after data was placed. The copy is now recorded in the section's
  `symlinkFallbacks`.
- **worktree-include legacy path:** include links.
- **CleoOS postinstall:** the `extensions/node_modules` junction, with no copy
  fallback.
- **global-delivery:** skill relinks.

**T12603.** These now resolve from `<cleoHome>` and never through `~/.cleo`:
- the federation index;
- the skills bridge doctor's skills root and backups;
- federated search's local skills root;
- the defaults for `cleo skills migrate`.

An index that an older release left at `~/.cleo/federation.json` is still read
through until the next write moves it. Tests set up a `~/.cleo` that is absent
or dangling and cover `skills list`, both skills doctors and the federation
store.
