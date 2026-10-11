# Reviewing a diff with ct-lean

Use this when reviewing a PR or your own diff before `cleo verify`.

1. **Scope.** Does every changed file serve the task's acceptance criteria? Name anything
   that does not, such as an unrelated refactor or a speculative option.
2. **Reuse.** Was there an existing helper, accessor, contract or chokepoint for this? Check
   `packages/core/src` and `packages/contracts/src`. A new utility that duplicates one is a
   finding.
3. **Abstraction.** Count the new interfaces, options, config keys and wrappers. Each one
   needs a caller today; "for later" is a finding.
4. **Completeness.** Grep the callers of every changed exported symbol. A caller, fixture or
   doc left behind is a finding. Lean never means half-done.
5. **Root cause.** Is a bug fixed in the shared code, or patched at one call site?
6. **Checks.** New non-trivial logic has one focused test. Test expectations were not edited
   to match broken code.
7. **Never-cut list.** Validation, data safety, security, evidence, type safety, package
   boundary: confirm none were trimmed to shorten the diff.
8. **Shortcuts.** Each known limit carries `shortcut: <limit>, <when to upgrade>`.

Report findings as the reply format says: verdict first, then one line per finding with its
file and line, then what you did not check.
