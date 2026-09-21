---
id: t12308-advertised-capability-and-remedy
tasks: [T12308]
kind: fix
summary: A surface must not advertise a capability, or a remedy, it cannot deliver
---

Evidence resolution works in a project whose CLEO root is not the git checkout and parents several repositories. A `commit:` atom resolves the sibling that contains its SHA, which needs no configuration because a SHA names exactly one repository. Where the evidence does not identify one, an explicit declaration is honoured by running there: `CLEO_EVIDENCE_GIT_ROOT`, `GIT_WORK_TREE`, or `evidence.gitRoot` in project context. A declared root that is not a checkout fails by name rather than silently measuring a different repository, and an unresolvable layout names the candidate checkouts and a durable way to pin one. The previous remediation could not work from a parent directory, because the guard asked whether the current directory was inside a work tree.

Typed acceptance gates have a supported read-only driver. `cleo verify <id> --run` executes a task's typed gates and reports results without recording anything; combining it with an evidence write is refused, because gates already execute during that write and an observed result must stay distinguishable from an attested one. A test gate's minimum count is satisfied from the structured report the gate's own command emits, and its absence reports the reporter flag that would supply one. A report produced by a separate invocation remains unaccepted for this purpose and is recorded as test-run evidence instead.

Session recovery is proportionate to the backlog. Listing honours the documented request for every match instead of substituting a page, and a start conflict names the number of active sessions and the bulk recovery when more than one has leaked. Operation keys are discoverable through the command its own not-found error already named.

Agent-facing instructions and runtime remediations are checked against the command surface they name. Every `cleo` invocation written into a spawned agent's prompt, and every remediation string in core and CLI sources, must resolve to an existing command whose flags are declared.

Code placed in packages/core/ for evidence, session and gate services, packages/contracts/ for shared types and the operation registry, and packages/cleo/ for thin dispatch per Package-Boundary Check — verified against AGENTS.md.
