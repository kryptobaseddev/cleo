---
id: t12311-squash-merge-orphans-evidence
tasks: [T12311]
kind: fix
summary: A squash merge no longer makes shipped work look absent from the release it shipped in
---

Evidence records a commit while its branch still exists. A squash merge then discards that identity and keeps the change under a new one, so asking only whether the recorded commit is an ancestor of the release tag reported shipped work as missing from the release that shipped it. Because a completed task's verification is frozen, the suggested repair — re-verify the task — was refused by the same system that suggested it, leaving an owner override as the only way to finish a release. That affected every task verified before its own squash merge, which is the ordinary order of work.

Release provenance now asks whether the CHANGE is present rather than whether the identity survived. Reachability is still asked first and remains the strongest answer. When the recorded commit is gone, its patch identity is compared against the commits in the tag — the same property a squash preserves and the same mechanism used to decide whether a change has already been applied upstream. A presence established this way names the commit that actually carries it, so the receipt records what the evidence resolved to instead of quietly equating two objects.

Absence is now distinguished from the two conditions that used to share its message. A tag that does not resolve, a commit unknown to the repository, and a change genuinely not in the release are three different situations with three different repairs, and each is now named. Where the change is truly absent, the remedy addresses the release rather than the evidence, because re-verifying a completed task is not something the caller can do.

Patch identity is not commit identity and is not claimed to be: it establishes that the work is in the tag, not who authored it or in what order. A merge commit and an empty commit carry no patch and are answered by reachability alone, and say so.

Code placed in packages/core/ for release provenance per Package-Boundary Check — verified against AGENTS.md.
