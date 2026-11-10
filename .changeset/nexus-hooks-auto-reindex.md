---
id: nexus-hooks-auto-reindex
tasks: [T12349]
kind: feat
summary: "git post-commit, post-merge, post-checkout and post-rewrite hooks keep the NEXUS index current with a detached incremental refresh, on by default"
---

The NEXUS index used to refresh only when someone ran `cleo nexus analyze`, so
it fell thousands of commits behind. CLEO's git hooks now refresh it after
every commit, merge, branch checkout and rewrite (D11237).

- **Hooks.** `cleo init` and `cleo upgrade` install `post-commit`,
  `post-checkout` and `post-rewrite` next to the existing `post-merge`. Each
  one starts `cleo nexus auto-reindex` detached, so git never waits for it.
  The hook only reads git config. It starts nothing in a linked worktree,
  when `cleo.nexusAutoReindex` is `false`, or when `CLEO_NEXUS_AUTO_REINDEX=off`
  (vitest sets this for every test fork).
- **Chaining.** A hook that already sits at one of these `post-*` names is no
  longer skipped. It moves to `<name>.cleo-chained`, and the CLEO hook runs it
  last with the same arguments and stdin. The install receipt keeps the first
  pre-CLEO image across later re-installs.
- **`cleo nexus hooks install|uninstall`.** Install turns the refresh on and
  is idempotent. Uninstall sets `cleo.nexusAutoReindex=false`, which init and
  upgrade respect. It also renames each chained hook back, which restores its
  exact bytes and mode, and removes any hook CLEO created. A hook edited since
  install is kept and reported.
- **The refresh.** `nexus analyze` is incremental by default. It is admitted
  through `cleo run --class scan` at the lowest priority: it never queues,
  yields to waiters and gives up after its timeout. One refresh runs per
  project at a time. A burst of events during a run leaves a pending marker,
  and the holder runs one follow-up pass. The opt-in
  `cleo nexus reindex-on-merge` uses the same lock and admission, and it still
  runs from `post-merge` when the auto refresh is off.
