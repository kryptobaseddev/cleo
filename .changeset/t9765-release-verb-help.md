---
id: t9765-release-verb-help
tasks: [T9765]
kind: fix
prs: [371]
summary: "`cleo release <verb> --help` now shows verb-specific help instead of the top-level command listing."
---

Pre-fix bug: `runMainWithLafsEnvelope` detected `--help` anywhere in `rawArgs` and called `showUsage(rootCmd)` directly. That dumped the grouped top-level help for every nested subcommand — `cleo release plan --help`, `cleo session start --help`, `cleo nexus impact --help` all collapsed to the same screen. Made `--help` useless as a discovery tool for option flags on nested verbs.

Fix: walk the subcommand tree via a new `resolveSubCommandForHelp` (a local port of citty 0.2.1's unexported `resolveSubCommand`) before calling `showUsage`, so the renderer receives the leaf command + its parent. The resolver is its own module so unit tests don't trigger `index.ts`'s top-level `void startCli()` side effect. Scope of fix covers ALL 11 release verbs plus every other group/verb pair (session, nexus, brain, …).
