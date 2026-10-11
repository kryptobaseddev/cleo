---
id: t13517-mac-local-suite
tasks: [T13517]
kind: test
summary: "The 13 session-binding and admission tests that failed on macOS locally (green in CI) now pass under any shell"
---

**Session binding (12 tests, 6 files).** Session tests bind through the caller's terminal identity. CI supplies one (`GITHUB_RUN_ID`), and so does an agent harness with a provider env key such as `CLAUDE_CODE_SESSION_ID`. Under vitest, though, the ancestor walk stops at the runner process (a Node host that is neither a wrapper nor a known harness), so a shell with no key (`env -i`, a harness that exports none) ran them unbound and they failed with `E_SESSION_UNBOUND`. `vitest.setup.ts` now gives each fork a `TERM_SESSION_ID` only when it inherited no identity variable, so every run binds the way CI does. The setup lists those variables itself, because plain Node loads it too (the scripts tests), and a core test keeps the list equal to `TERMINAL_KEY_SOURCES`. The tests that assert unbound or terminal-key behaviour pass either way: 10 files, 197 tests, with and without `env -i`.

**Heavy-hook admission (1 test).** The child CLI runs dropped the suite's `CLEO_ADMISSION_PRESSURE=off`, so live host pressure moved the budget mid-run. The bound was also the class budget, which uses the class plan's footprint. On a 64 GiB host that is 24 GiB, while a named-file `vitest` or a `tsc -p` is charged 6 GiB, so admission correctly ran more at once than the bound allowed. The children now inherit pressure off, and the bound is admission's own byte rule: capacity over the smallest charge among the class's command lines. On a 16 GiB runner both charges are 6 GiB, so admission still has to hold runs back there.
