---
id: t12139-strict-flags-chokepoint
tasks: [T12139]
kind: fix
summary: "BREAKING: an unknown flag is now an error instead of being silently ignored — the existing assertKnownFlags guard is applied at the CLI chokepoint rather than to one command"
---

Closes the root mechanism behind GH #1245.

## ⚠️ Breaking change, in plain language

**A command invocation containing a flag that command does not accept now FAILS with exit code 6 instead of succeeding while ignoring the flag.**

If you have a script passing a stray or misspelled flag, it will start failing. That script has been getting results computed without the flag it thought it was passing. A rejected invocation is the correct outcome: the alternative is the state that produced #1245, where `cleo list --severity P0` returned **all 3,173 tasks** and nothing indicated the filter had been discarded.

Concretely, before and after:

```
$ cleo list --severity P0 --output count
3173                                        # before: flag absorbed, whole table returned

E_UNKNOWN_FLAG: unknown flag '--severity' for 'list'.
  fix: Run `cleo list --help` for the full flag list.
                                            # after: exit 6
```

Global flags (`--json`, `--quiet`, `--output`, `--field`, `--fields`, `--mvi`, `--verbose`, `--full`, `--summary`, `--describe`, `--idempotency-key`, `--help`, `--version`) are unaffected — they are consumed by the entry point and are explicitly allowlisted.

## The guard was already written, and had one consumer

This is not a new mechanism. `assertKnownFlags` (`packages/cleo/src/cli/lib/strict-args.ts`, T10359) is complete and tested: Levenshtein-ranked did-you-mean, `--` terminator handling, `=value` stripping, bare-`-` stdin handling, and a structured `UnknownFlagError` carrying the offending flag plus the command's full valid surface.

**Its only caller was `packages/cleo/src/cli/commands/docs.ts`** — out of ~111 commands. So the same binary rejected `cleo docs add --field` properly and silently swallowed `cleo list --severity P0`. Two opposite behaviours, because one command opted in and nothing propagated it.

The underlying cause is citty calling `parseArgs` with `strict: false` and no public knob, so an unknown flag is absorbed as a positional.

## Applied at the chokepoint

`lazyCommand.run` in `packages/cleo/src/cli/lazy-command.ts` is the single point every manifest command passes through, and it holds both halves the guard needs: the loaded command's `args` schema and the invocation's `rawArgs`. One call site now covers every command that reaches it, instead of 111 opt-ins.

Errors render through the same path `docs` has used since T10359, so the contract is identical whichever command produced it, and `knownFlags` is surfaced as `alternatives` — the did-you-mean suggestions tell a caller what is *close to their typo*, not what is *valid*. The renderer is imported dynamically inside the error branch, because `lazy-command.ts` is on the hot startup path for every invocation and valid calls must not pay the renderer's load cost.

### The naive fix reintroduces the defect it removes

`lazyCommand` exposes `args` as an **async thunk** so a command module stays unloaded until needed, and `assertKnownFlags` deliberately **bails out** on a resolvable schema rather than throwing. So passing the wrapper's own `args` would produce a guard that looks wired and validates nothing — the exact failure this change exists to remove.

It must be the **loaded** `cmd.args` from inside `run(ctx)`. There is a comment saying so at the call site, and a test asserting the thunk path does *not* throw, so the reasoning cannot be "simplified" away.

## Two things the smoke test caught that unit tests could not

**1. `cleo add --title` would have broken for every agent.** `add`'s `title` is declared `type: 'positional'`, so `--title` is not a named flag — it works because citty's non-strict parse populates `args.title` for both spellings. `assertKnownFlags` skipped positionals when building its known set, which is correct for a guard about flags and catastrophic for a command whose primary parameter is positional-but-flag-addressable:

```
$ cleo add --type task --parent T12119 --title smoke --acceptance a --dry-run
E_UNKNOWN_FLAG: unknown flag '--title' for 'add'. Did you mean: --files, --note, --size, --type?
```

`CLEO-INJECTION.md` documents that exact form everywhere. `collectKnownLongFlags` now contributes `--<name>` for positionals too. That is correctness, not leniency: the parameter exists, citty accepts both spellings, and the handler reads the same key either way — so rejecting `--title` while accepting the bare positional would have the guard inventing a restriction the command does not have, in a guard whose purpose is enforcing the command's real surface.

**2. A retired flag is rejected WITH the replacement, not passed through.** My first attempt let `cleo complete --force` through, assuming dispatch's purpose-built `E_FLAG_REMOVED` would fire. Measured against the built binary, it does not: `complete.ts` never forwards `force`, so that error is reachable only by SDK/dispatch callers. From the CLI, `--force` was silently ignored and the caller then got an unrelated evidence-gate failure. Passing it through would have restored the exact defect this guard removes. So it is rejected, and the rejection substitutes the remedy for the did-you-mean:

> `--force was removed by ADR-051. Record evidence instead: cleo verify <id> --gate <gate> --evidence "<atoms>", then cleo complete <id>. For an audited emergency bypass, set CLEO_OWNER_OVERRIDE=1 on verify.`

That `E_FLAG_REMOVED` is unreachable from the CLI is a separate defect, filed separately.

## Scope, stated honestly

The chokepoint fires for commands citty resolves to directly — the top-level leaf commands, which is where the reported defects were. It does **not** fire for nested subcommands (`cleo docs add`), because citty descends into `subCommands` without invoking the parent's `run`. Those need per-command opt-in, as `docs` already does. Extending coverage to nested subcommands is follow-up work, not silently included here.

## Global flags are an SSoT, not a second list

`CLI_GLOBAL_FLAGS` is exported from `strict-args.ts`, and a test asserts every `arg === '--x'` comparison in the entry point's parser appears in it. A guard whose allowlist drifts from the parser would begin **rejecting valid flags** — worse than the silence it replaced — and a second hand-maintained list is precisely the divergence this cluster has been about. The test also pins a minimum match count so a regex that stopped matching cannot pass vacuously.

## Verification

Nine tests, deliberately asserting the **wiring** rather than the function: `assertKnownFlags`' own unit tests have passed since T10359 while 110 commands went unguarded, so a test of the function proves nothing. These go through the chokepoint and through `list` — the command that never opted in and returned all 3,173 rows.
