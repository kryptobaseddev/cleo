---
id: ac-files-provenance-two-tier
tasks: [T12118]
kind: fix
summary: AC-file enforcement requires a declaration; prose-derived lists advise instead of blocking (gh#1240)
---

`cleo verify --gate implemented` extracted file paths from acceptance-criteria
prose and required the commit to modify them — losing any negation. An AC
reading "the diff touches no line of src/lib/compound-catalog.ts" had the
filename scraped out and the prohibition discarded, so the gate demanded a
modification to the one file the task forbade touching. The gate became
satisfiable only by violating the criteria it enforced, and every honest
escape was worse than the check: modify the forbidden file, rewrite the AC to
hide the filename, or burn an audited owner override on correct work.

The defect is structural, not textual: `task.files` is the documented SSoT and
prose parsing is documented as a legacy fallback, but the gate blocked
identically on either — a heuristic fallback was wired to a blocking gate. The
lost negation is the sharpest symptom, not the cause.

Enforcement now requires a declaration. `task.files` blocks as before; a
prose-derived list warns and lets the gate pass, carrying a
`W_AC_FILES_DERIVED` envelope warning that names the task and tells the
operator to declare `--files` to make the gate enforcing. The warning code is
stable so the downgrade is countable.

Derived lists also drop paths their own clause forbids touching, so the
advisory never names a file the AC prohibits. That is advisory quality only
and buys no enforcement authority — prose cannot reliably separate a target
from a prohibition, an example, or a cross-reference, and handling the
negations seen so far does not change that.

Cost, stated plainly: tasks that never set `--files` lose a blocking check.
That check fired on whatever filenames appeared in a sentence in any
grammatical role, and the incentive it created was to stop writing negative
constraints — which are how a blast radius gets pinned.
