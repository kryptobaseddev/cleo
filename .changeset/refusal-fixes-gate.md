---
id: refusal-fixes-gate
tasks: [T14299]
kind: fix
summary: "every refusal on the close, cancel, verify, done, review and docs-link paths carries a runnable fix; gate 42 keeps it that way"
---

Refusals on the paths agents use to close work now say what to run next:

- every `cleo verify` refusal: `cleo done <id> --plan` names the evidence
  each gate needs, or the exact `cleo verify` form (`--run`, `--run-typed`,
  `--shared-evidence`);
- every cancel refusal, including a failed store write
  (`cleo doctor type-matrix`);
- the review refusals and the docs `link-decision`/`unlink-decision` handlers
  (`decisionLinkResponse` now passes the thrown error's fix through);
- the lifecycle stage gate (`cleo lifecycle complete <id> <stage>`, or
  `skip`), the failed-merge-CI sweep refusal and the names-no-file credit
  refusal (`cleo review packet <pr> --task <id>`), and `E_RESOURCE_DEFERRED`
  (`cleo run --wait -- <command>`).

Gate 42 (`scripts/lint-refusal-fixes.mjs`, in `cleo check arch` and CI)
counts the `CleoError`, `engineError` and `lafsError` refusals on those paths
that carry no fix, or a fix naming a command or flag the CLI rejects. It is
pinned at zero per file and may only fall; there is no `--baseline` mode.
Gate 14's flag checker now resolves an args object a command spreads in from
a sibling command (`cleo done`'s `...completeCommandArgs`).
