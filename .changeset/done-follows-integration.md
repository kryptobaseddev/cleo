---
id: done-follows-integration
tasks: [T12671, T12710]
kind: fix
summary: "cleo done --pr <component> follows a component PR to the integration PR that landed it: closed by hand, marked merged by GitHub, stacked, main-merged afterwards, or rebased into the batch"
---
`cleo done T#### --pr <component>` used to fail when the component reached
main through an integration branch merged with `--no-ff`: it checked the
component's own incomplete CI (`E_EVIDENCE_TESTS_FAILED`), refused a closed
component (`pr-unverified`), or reported a stacked one as `pr-stacked`.

It now follows the component to the integration PR that landed it and records
`pr:<component>@<integration>` and `ci:<component>@<integration>`:

- **Ancestry first.** The newest component commit on the default branch, then
  the first commit on the default branch's first-parent chain containing it,
  then the merged PR whose merge commit that is.
- **Rebased batch.** When no component commit is on the default branch, merged
  PRs whose body lists `#<component>` are candidates. The body is only a hint:
  a candidate is accepted only when every component commit matches, by
  `git patch-id`, a commit its merge introduced.
- **Safety.** Every commit of the component must be in the landing merge, and
  at least one must be new there. Only paths the component's own commits
  changed are credited, and only where the landing merge still carries the
  change (T12689 rules). The `pr:`/`ci:` validators run the same proof.
- Every `gh` search is bounded by the evidence deadline. Offline is a named
  refusal, not a hang.
